/**
 * Source asset registry (Milestone 0 subset of the blueprint §8.1 state machine):
 *   UNRESOLVED -> FETCHING -> RESIDENT | FAILED
 * - Logical items map to immutable source pages; a page is fetched at most once per session (concurrent
 *   requests share one promise), so equipping an item never reloads pages of unchanged equipment.
 * - FAILED pages are not retried automatically (no retry storms); `retry()` is explicit. Backoff, eviction,
 *   generation-checked handles and budgets are Milestone 2.
 * Generic over the resource type so it is unit-testable without WebGL.
 */
import type { CompiledPage, ManifestIndex } from '../schema/compiled-manifest.ts';

export type ResidencyState = 'UNRESOLVED' | 'FETCHING' | 'RESIDENT' | 'FAILED';

export interface PageLoader<T> {
  load(page: CompiledPage, url: string): Promise<T>;
  dispose(resource: T): void;
}

export interface PageStatus {
  pageId: string;
  owner: string;
  state: ResidencyState;
  error: string | null;
  bytesRGBA8: number;
  loadMs: number | null;
}

export interface RegistryStats {
  pages: number;
  resident: number;
  fetching: number;
  failed: number;
  /** Actual loader invocations (network fetch + decode + upload). */
  loads: number;
  /** ensure() calls satisfied by an in-flight or resident page without a new load. */
  sharedRequests: number;
  residentBytesRGBA8: number;
}

interface Entry<T> {
  page: CompiledPage;
  state: ResidencyState;
  resource: T | null;
  promise: Promise<boolean> | null;
  error: string | null;
  loadMs: number | null;
}

export class SourceAssetRegistry<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly listeners = new Set<() => void>();
  private readonly index: ManifestIndex;
  private readonly baseUrl: string;
  private readonly loader: PageLoader<T>;
  private loads = 0;
  private sharedRequests = 0;
  private disposed = false;
  /** Increments whenever any page changes state; renderers use it to refresh dependent layers. */
  revision = 0;

  constructor(index: ManifestIndex, baseUrl: string, loader: PageLoader<T>) {
    this.index = index;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.loader = loader;
    for (const page of index.manifest.pages) {
      this.entries.set(page.id, { page, state: 'UNRESOLVED', resource: null, promise: null, error: null, loadMs: null });
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

  /** Ensures one page; resolves true when resident, false when it failed. Never throws. */
  ensurePage(pageId: string): Promise<boolean> {
    const entry = this.entries.get(pageId);
    if (!entry) return Promise.resolve(false);
    if (entry.state === 'RESIDENT') {
      this.sharedRequests++;
      return Promise.resolve(true);
    }
    if (entry.state === 'FAILED') return Promise.resolve(false);
    if (entry.promise) {
      this.sharedRequests++;
      return entry.promise;
    }
    entry.state = 'FETCHING';
    this.loads++;
    const t0 = performance.now();
    this.changed();
    entry.promise = this.loader.load(entry.page, this.urlFor(entry.page)).then(
      (resource) => {
        entry.promise = null;
        if (this.disposed) {
          this.loader.dispose(resource);
          return false;
        }
        entry.resource = resource;
        entry.state = 'RESIDENT';
        entry.loadMs = performance.now() - t0;
        this.changed();
        return true;
      },
      (error: unknown) => {
        entry.promise = null;
        entry.state = 'FAILED';
        entry.error = error instanceof Error ? error.message : String(error);
        this.changed();
        return false;
      },
    );
    return entry.promise;
  }

  /** Ensures every page an item needs. Resolves true only if all are resident. */
  async ensureItem(itemId: string): Promise<boolean> {
    const item = this.index.items.get(itemId);
    if (!item) return false;
    const results = await Promise.all(item.pages.map((p) => this.ensurePage(p)));
    return results.every(Boolean);
  }

  itemState(itemId: string): ResidencyState {
    const item = this.index.items.get(itemId);
    if (!item) return 'FAILED';
    const states = item.pages.map((p) => this.entries.get(p)?.state ?? 'FAILED');
    if (states.includes('FAILED')) return 'FAILED';
    if (states.every((s) => s === 'RESIDENT')) return 'RESIDENT';
    if (states.includes('FETCHING')) return 'FETCHING';
    return 'UNRESOLVED';
  }

  getPage(pageId: string): T | null {
    const entry = this.entries.get(pageId);
    return entry?.state === 'RESIDENT' ? entry.resource : null;
  }

  pageState(pageId: string): ResidencyState {
    return this.entries.get(pageId)?.state ?? 'FAILED';
  }

  /** Explicitly retries a FAILED page (UI/debug action). */
  retry(pageId: string): Promise<boolean> {
    const entry = this.entries.get(pageId);
    if (!entry || entry.state !== 'FAILED') return Promise.resolve(entry?.state === 'RESIDENT');
    entry.state = 'UNRESOLVED';
    entry.error = null;
    return this.ensurePage(pageId);
  }

  pageStatuses(): PageStatus[] {
    return [...this.entries.values()].map((e) => ({
      pageId: e.page.id,
      owner: e.page.owner,
      state: e.state,
      error: e.error,
      bytesRGBA8: e.page.width * e.page.height * 4,
      loadMs: e.loadMs,
    }));
  }

  stats(): RegistryStats {
    let resident = 0;
    let fetching = 0;
    let failed = 0;
    let residentBytesRGBA8 = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'RESIDENT') {
        resident++;
        residentBytesRGBA8 += e.page.width * e.page.height * 4;
      } else if (e.state === 'FETCHING') fetching++;
      else if (e.state === 'FAILED') failed++;
    }
    return { pages: this.entries.size, resident, fetching, failed, loads: this.loads, sharedRequests: this.sharedRequests, residentBytesRGBA8 };
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) {
      if (e.resource) this.loader.dispose(e.resource);
      e.resource = null;
      e.state = 'UNRESOLVED';
    }
    this.listeners.clear();
  }
}
