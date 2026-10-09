/**
 * Source asset registry v2 (Milestone 2): residency of immutable source pages.
 *
 *   UNRESOLVED -> REQUESTED -> FETCHING -> DECODED -> UPLOAD_QUEUED -> RESIDENT
 *        ^            |            |                                     |
 *        |            +--> RETRY_BACKOFF (transient errors only) <--+    |  (budget, LRU, unpinned only)
 *        |                          |                                    v
 *        +---- cancelled ------  FAILED (4xx / decode / attempts)     EVICTED -> REQUESTED on demand
 *
 * - Pins: visible characters acquire their items (refcount per page). Pinned pages are never evicted.
 * - Budget: when resident GPU bytes exceed `budgetBytes`, unpinned pages are evicted LRU-first down to
 *   `lowWaterRatio * budgetBytes` (hysteresis). If pinned pages alone exceed the budget, nothing pinned is
 *   evicted and `overBudget` is reported (correctness first).
 * - Handles: a RESIDENT page owns a slot; `PageHandle = { index, generation }`. Losing GPU residency
 *   (eviction, context loss) frees the slot and bumps its generation, so an old handle can never resolve to
 *   another page that later reuses the slot (ABA guard).
 * - Network work is deduplicated per page, capped (`maxConcurrentFetches`), cancellable (AbortSignal) when
 *   nobody needs the page any more, and retried with exponential backoff only for transient errors.
 * - GPU uploads run in `beginFrame()` (between frames), at most `uploadsPerFrame` per frame. With
 *   `keepDecodedCopies`, a lost WebGL context is recovered by re-uploading without any network request.
 * Generic over decoded (D) and GPU (T) resource types, so it is unit-tested in Node with fakes.
 */
import type { CompiledPage, ManifestIndex } from '../schema/compiled-manifest.ts';

export type PageState = 'UNRESOLVED' | 'REQUESTED' | 'FETCHING' | 'DECODED' | 'UPLOAD_QUEUED' | 'RESIDENT' | 'RETRY_BACKOFF' | 'FAILED' | 'EVICTED';

/** Thrown by fetchers; `retryable: false` (e.g. HTTP 404) fails the page immediately. */
export class PageFetchError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(message: string, retryable: boolean, status: number | null = null) {
    super(message);
    this.name = 'PageFetchError';
    this.retryable = retryable;
    this.status = status;
  }
}

export interface PageFetcher<D> {
  /** Network + decode. Must reject (any error) when `signal` aborts. */
  fetch(page: CompiledPage, url: string, signal: AbortSignal): Promise<D>;
  /** Frees a decoded CPU copy (e.g. ImageBitmap.close()). */
  release(decoded: D): void;
}

export interface PageUploader<D, T> {
  /** Synchronous GPU upload; called only from beginFrame(). */
  upload(page: CompiledPage, decoded: D): T;
  dispose(resource: T): void;
  /** Estimated GPU bytes of a page once uploaded (e.g. RGBA8 incl. mip chain). */
  gpuBytes(page: CompiledPage): number;
}

export interface RegistryScheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RegistryOptions {
  budgetBytes: number;
  lowWaterRatio: number;
  maxConcurrentFetches: number;
  maxAttempts: number;
  retryBaseMs: number;
  uploadsPerFrame: number;
  keepDecodedCopies: boolean;
}

export const DEFAULT_REGISTRY_OPTIONS: RegistryOptions = {
  // Blueprint §8.3 initial desktop source budget; tune per device profile.
  budgetBytes: 256 * 1024 * 1024,
  lowWaterRatio: 0.75,
  maxConcurrentFetches: 4,
  maxAttempts: 3,
  retryBaseMs: 250,
  uploadsPerFrame: 2,
  keepDecodedCopies: true,
};

export interface PageHandle {
  readonly index: number;
  readonly generation: number;
}

export interface PageStatus {
  pageId: string;
  group: string;
  state: PageState;
  refs: number;
  prefetch: boolean;
  error: string | null;
  attempts: number;
  fetches: number;
  evictions: number;
  /** Loads aborted because nobody needed the page any more. */
  cancels: number;
  gpuBytes: number;
}

export interface RegistryStats {
  pages: number;
  byState: Record<PageState, number>;
  /** Network fetch starts (incl. retries and reloads after eviction). */
  fetches: number;
  /** Fetches of a page that had been evicted before. */
  reloads: number;
  cancelled: number;
  retries: number;
  failures: number;
  uploads: number;
  evictions: number;
  contextLosses: number;
  /** resolve() calls that hit a stale (freed / recycled) handle and correctly returned null. */
  staleResolves: number;
  residentBytes: number;
  pinnedBytes: number;
  decodedBytes: number;
  budgetBytes: number;
  overBudget: boolean;
}

interface Entry<D, T> {
  page: CompiledPage;
  gpuBytes: number;
  state: PageState;
  refs: number;
  prefetch: boolean;
  /** Monotonic request order: demand before prefetch, then FIFO. */
  seq: number;
  attempts: number;
  error: string | null;
  abort: AbortController | null;
  timer: unknown;
  decoded: D | null;
  resource: T | null;
  slot: number;
  lastUsed: number;
  fetches: number;
  evictions: number;
  cancels: number;
}

const ALL_STATES: PageState[] = ['UNRESOLVED', 'REQUESTED', 'FETCHING', 'DECODED', 'UPLOAD_QUEUED', 'RESIDENT', 'RETRY_BACKOFF', 'FAILED', 'EVICTED'];
const LOADING: ReadonlySet<PageState> = new Set(['REQUESTED', 'FETCHING', 'DECODED', 'UPLOAD_QUEUED', 'RETRY_BACKOFF']);

/** What a renderer needs from residency (keeps renderers independent of decode/upload types). */
export interface ResidencyView<T> {
  readonly revision: number;
  acquireItem(itemId: string): void;
  releaseItem(itemId: string): void;
  prefetchItem(itemId: string): void;
  handleFor(pageId: string): PageHandle | null;
  resolve(handle: PageHandle): T | null;
  pageState(pageId: string): PageState;
  touch(pageId: string): void;
  stats(): RegistryStats;
}

export class SourceAssetRegistry<D, T> implements ResidencyView<T> {
  private readonly entries = new Map<string, Entry<D, T>>();
  private readonly slots: { generation: number; pageId: string | null }[] = [];
  private readonly freeSlots: number[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly index: ManifestIndex;
  private readonly baseUrl: string;
  private readonly fetcher: PageFetcher<D>;
  private readonly uploader: PageUploader<D, T>;
  private readonly scheduler: RegistryScheduler;
  readonly options: RegistryOptions;
  private seq = 0;
  private frame = 0;
  private inflight = 0;
  private contextLost = false;
  private disposed = false;
  private counters = { fetches: 0, reloads: 0, cancelled: 0, retries: 0, failures: 0, uploads: 0, evictions: 0, contextLosses: 0, staleResolves: 0 };
  /** Increments whenever the set of usable GPU resources changes; renderers refresh dependent layers. */
  revision = 0;

  constructor(index: ManifestIndex, baseUrl: string, fetcher: PageFetcher<D>, uploader: PageUploader<D, T>, options: Partial<RegistryOptions> = {}, scheduler?: RegistryScheduler) {
    this.index = index;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetcher = fetcher;
    this.uploader = uploader;
    this.options = { ...DEFAULT_REGISTRY_OPTIONS, ...options };
    this.scheduler = scheduler ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    for (const page of index.manifest.pages) {
      this.entries.set(page.id, {
        page,
        gpuBytes: uploader.gpuBytes(page),
        state: 'UNRESOLVED',
        refs: 0,
        prefetch: false,
        seq: 0,
        attempts: 0,
        error: null,
        abort: null,
        timer: null,
        decoded: null,
        resource: null,
        slot: -1,
        lastUsed: 0,
        fetches: 0,
        evictions: 0,
        cancels: 0,
      });
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.revision++;
    for (const l of this.listeners) l();
  }

  urlFor(page: CompiledPage): string {
    return `${this.baseUrl}/${page.file}`;
  }

  private pagesOf(itemId: string): Entry<D, T>[] {
    const item = this.index.items.get(itemId);
    if (!item) return [];
    return item.pages.map((p) => this.entries.get(p)).filter((e): e is Entry<D, T> => e !== undefined);
  }

  private wanted(e: Entry<D, T>): boolean {
    return e.refs > 0 || e.prefetch;
  }

  private request(e: Entry<D, T>): void {
    if (e.state === 'UNRESOLVED' || e.state === 'EVICTED') {
      e.state = 'REQUESTED';
      e.seq = ++this.seq;
      e.attempts = 0;
      e.error = null;
    }
  }

  /** Pins every page of an item (a visible character uses it) and schedules missing loads. */
  acquireItem(itemId: string): void {
    for (const e of this.pagesOf(itemId)) {
      e.refs++;
      this.request(e);
    }
  }

  /** Unpins; loads nobody needs any more are cancelled, resident pages become eviction candidates. */
  releaseItem(itemId: string): void {
    for (const e of this.pagesOf(itemId)) {
      e.refs = Math.max(0, e.refs - 1);
      if (!this.wanted(e)) this.cancel(e);
    }
  }

  /** Low-priority, unpinned load (e.g. characters just outside the view). */
  prefetchItem(itemId: string): void {
    for (const e of this.pagesOf(itemId)) {
      e.prefetch = true;
      this.request(e);
    }
  }

  cancelPrefetch(itemId: string): void {
    for (const e of this.pagesOf(itemId)) {
      e.prefetch = false;
      if (!this.wanted(e)) this.cancel(e);
    }
  }

  private cancel(e: Entry<D, T>): void {
    const before = this.counters.cancelled;
    this.cancelInner(e);
    if (this.counters.cancelled > before) e.cancels++;
  }

  private cancelInner(e: Entry<D, T>): void {
    if (e.state === 'REQUESTED') {
      e.state = 'UNRESOLVED';
    } else if (e.state === 'FETCHING') {
      e.abort?.abort();
      e.abort = null;
      e.state = 'UNRESOLVED';
      this.counters.cancelled++;
    } else if (e.state === 'RETRY_BACKOFF') {
      this.scheduler.clearTimeout(e.timer);
      e.timer = null;
      e.state = 'UNRESOLVED';
      this.counters.cancelled++;
    } else if ((e.state === 'DECODED' || e.state === 'UPLOAD_QUEUED') && e.decoded) {
      // Decoded but never uploaded and nobody wants it: drop the CPU copy.
      this.fetcher.release(e.decoded);
      e.decoded = null;
      e.state = 'UNRESOLVED';
      this.counters.cancelled++;
    }
  }

  private startFetch(e: Entry<D, T>): void {
    const abort = new AbortController();
    e.abort = abort;
    e.state = 'FETCHING';
    e.attempts++;
    e.fetches++;
    this.inflight++;
    this.counters.fetches++;
    if (e.evictions > 0) this.counters.reloads++;
    this.fetcher.fetch(e.page, this.urlFor(e.page), abort.signal).then(
      (decoded) => {
        this.inflight--;
        if (abort.signal.aborted || this.disposed || e.abort !== abort) {
          this.fetcher.release(decoded);
          return;
        }
        e.abort = null;
        e.decoded = decoded;
        e.state = 'UPLOAD_QUEUED';
        this.changed();
      },
      (error: unknown) => {
        this.inflight--;
        if (abort.signal.aborted || this.disposed || e.abort !== abort) return;
        e.abort = null;
        e.error = error instanceof Error ? error.message : String(error);
        const retryable = !(error instanceof PageFetchError) || error.retryable;
        if (retryable && e.attempts < this.options.maxAttempts && this.wanted(e)) {
          e.state = 'RETRY_BACKOFF';
          this.counters.retries++;
          const delay = this.options.retryBaseMs * 2 ** (e.attempts - 1);
          e.timer = this.scheduler.setTimeout(() => {
            e.timer = null;
            if (e.state === 'RETRY_BACKOFF') e.state = 'REQUESTED';
          }, delay);
        } else {
          e.state = 'FAILED';
          this.counters.failures++;
        }
        this.changed();
      },
    );
  }

  private allocSlot(pageId: string): number {
    const index = this.freeSlots.pop() ?? this.slots.push({ generation: 0, pageId: null }) - 1;
    (this.slots[index] as { generation: number; pageId: string | null }).pageId = pageId;
    return index;
  }

  private freeSlot(e: Entry<D, T>): void {
    if (e.slot < 0) return;
    const slot = this.slots[e.slot];
    if (slot) {
      slot.generation++;
      slot.pageId = null;
      this.freeSlots.push(e.slot);
    }
    e.slot = -1;
  }

  /**
   * Per-frame pump, called between frames: starts fetches (demand first), performs at most `uploadsPerFrame`
   * uploads, then evicts unpinned pages if over budget.
   */
  beginFrame(frame: number): { started: number; uploaded: number; evicted: number } {
    this.frame = frame;
    let started = 0;
    let uploaded = 0;
    const byPriority = (a: Entry<D, T>, b: Entry<D, T>): number => (b.refs > 0 ? 1 : 0) - (a.refs > 0 ? 1 : 0) || a.seq - b.seq;
    const requested = [...this.entries.values()].filter((e) => e.state === 'REQUESTED' && this.wanted(e)).sort(byPriority);
    for (const e of requested) {
      if (this.inflight >= this.options.maxConcurrentFetches) break;
      this.startFetch(e);
      started++;
    }
    if (!this.contextLost) {
      const queued = [...this.entries.values()].filter((e) => e.state === 'UPLOAD_QUEUED').sort(byPriority);
      for (const e of queued) {
        if (uploaded >= this.options.uploadsPerFrame) break;
        if (!this.wanted(e)) {
          this.cancel(e);
          continue;
        }
        try {
          e.resource = this.uploader.upload(e.page, e.decoded as D);
        } catch (error) {
          e.state = 'FAILED';
          e.error = `upload failed: ${error instanceof Error ? error.message : String(error)}`;
          this.counters.failures++;
          continue;
        }
        if (!this.options.keepDecodedCopies && e.decoded) {
          this.fetcher.release(e.decoded);
          e.decoded = null;
        }
        e.state = 'RESIDENT';
        e.slot = this.allocSlot(e.page.id);
        e.lastUsed = frame;
        uploaded++;
        this.counters.uploads++;
      }
    }
    const evicted = this.enforceBudget();
    if (started + uploaded + evicted > 0) this.changed();
    return { started, uploaded, evicted };
  }

  private enforceBudget(): number {
    let resident = this.residentBytes();
    if (resident <= this.options.budgetBytes) return 0;
    const target = this.options.budgetBytes * this.options.lowWaterRatio;
    const candidates = [...this.entries.values()]
      .filter((e) => e.state === 'RESIDENT' && e.refs === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed || (a.page.id < b.page.id ? -1 : 1));
    let evicted = 0;
    for (const e of candidates) {
      if (resident <= target) break;
      this.evict(e);
      resident -= e.gpuBytes;
      evicted++;
    }
    return evicted;
  }

  private evict(e: Entry<D, T>): void {
    if (e.resource) this.uploader.dispose(e.resource);
    e.resource = null;
    if (e.decoded) this.fetcher.release(e.decoded);
    e.decoded = null;
    this.freeSlot(e);
    e.state = 'EVICTED';
    e.prefetch = false;
    e.evictions++;
    this.counters.evictions++;
  }

  /** Marks pages used for drawing this frame (LRU order for eviction). */
  touch(pageId: string): void {
    const e = this.entries.get(pageId);
    if (e) e.lastUsed = this.frame;
  }

  handleFor(pageId: string): PageHandle | null {
    const e = this.entries.get(pageId);
    if (!e || e.state !== 'RESIDENT' || e.slot < 0) return null;
    return { index: e.slot, generation: (this.slots[e.slot] as { generation: number }).generation };
  }

  /** The GPU resource for a handle, or null if the handle is stale (evicted, lost or slot recycled). */
  resolve(handle: PageHandle): T | null {
    const slot = this.slots[handle.index];
    if (!slot || slot.generation !== handle.generation || slot.pageId === null) {
      this.counters.staleResolves++;
      return null;
    }
    return this.entries.get(slot.pageId)?.resource ?? null;
  }

  pageState(pageId: string): PageState {
    return this.entries.get(pageId)?.state ?? 'FAILED';
  }

  itemState(itemId: string): PageState {
    const pages = this.pagesOf(itemId);
    if (pages.length === 0) return 'FAILED';
    const states = pages.map((e) => e.state);
    for (const s of ['FAILED', 'RETRY_BACKOFF', 'FETCHING', 'REQUESTED', 'DECODED', 'UPLOAD_QUEUED', 'EVICTED', 'UNRESOLVED'] as const) if (states.includes(s)) return s;
    return 'RESIDENT';
  }

  /** True when no page is in a loading state (waiting for network, decode, backoff or upload). */
  isIdle(): boolean {
    for (const e of this.entries.values()) if (LOADING.has(e.state) && this.wanted(e)) return false;
    return true;
  }

  /** Explicit retry of a FAILED page (UI/debug action). */
  retry(pageId: string): void {
    const e = this.entries.get(pageId);
    if (!e || e.state !== 'FAILED') return;
    e.state = 'UNRESOLVED';
    this.request(e);
    this.changed();
  }

  /**
   * WebGL context lost: every GPU resource is gone. Resident pages keep their decoded copy and are queued for
   * re-upload (no network), all handles go stale; uploads pause until onContextRestored().
   */
  onContextLost(): void {
    this.contextLost = true;
    this.counters.contextLosses++;
    for (const e of this.entries.values()) {
      if (e.state !== 'RESIDENT') continue;
      if (e.resource) this.uploader.dispose(e.resource);
      e.resource = null;
      this.freeSlot(e);
      if (e.decoded) e.state = 'UPLOAD_QUEUED';
      else {
        e.state = 'EVICTED';
        e.evictions++;
        if (this.wanted(e)) this.request(e);
      }
    }
    this.changed();
  }

  onContextRestored(): void {
    this.contextLost = false;
    this.changed();
  }

  pageStatuses(): PageStatus[] {
    return [...this.entries.values()].map((e) => ({
      pageId: e.page.id,
      group: e.page.group,
      state: e.state,
      refs: e.refs,
      prefetch: e.prefetch,
      error: e.error,
      attempts: e.attempts,
      fetches: e.fetches,
      evictions: e.evictions,
      cancels: e.cancels,
      gpuBytes: e.gpuBytes,
    }));
  }

  private residentBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) if (e.state === 'RESIDENT') total += e.gpuBytes;
    return total;
  }

  stats(): RegistryStats {
    const byState = Object.fromEntries(ALL_STATES.map((s) => [s, 0])) as Record<PageState, number>;
    let pinnedBytes = 0;
    let decodedBytes = 0;
    for (const e of this.entries.values()) {
      byState[e.state]++;
      if (e.refs > 0) pinnedBytes += e.gpuBytes;
      if (e.decoded) decodedBytes += e.page.width * e.page.height * 4;
    }
    const residentBytes = this.residentBytes();
    return {
      pages: this.entries.size,
      byState,
      ...this.counters,
      residentBytes,
      pinnedBytes,
      decodedBytes,
      budgetBytes: this.options.budgetBytes,
      overBudget: residentBytes > this.options.budgetBytes,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) {
      e.abort?.abort();
      if (e.timer) this.scheduler.clearTimeout(e.timer);
      if (e.resource) this.uploader.dispose(e.resource);
      if (e.decoded) this.fetcher.release(e.decoded);
      e.resource = null;
      e.decoded = null;
      e.state = 'UNRESOLVED';
    }
    this.listeners.clear();
  }
}
