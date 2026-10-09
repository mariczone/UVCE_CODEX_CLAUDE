import { describe, expect, it } from 'vitest';
import { type PageFetcher, PageFetchError, type PageUploader, type RegistryOptions, SourceAssetRegistry } from '../../src/uvce/assets/source-registry.ts';
import type { ManifestIndex } from '../../src/uvce/schema/compiled-manifest.ts';
import { compiledAssets } from './helpers.ts';

interface Decoded {
  id: string;
}
interface Gpu {
  id: string;
  upload: number;
}

/** Registry with fake network/decode/GPU ports, a manual clock and explicit frame stepping. */
function harness(index: ManifestIndex, options: Partial<RegistryOptions> = {}) {
  const jobs: { pageId: string; signal: AbortSignal; resolve(): void; fail(e: unknown): void }[] = [];
  const fetchLog: string[] = [];
  const released: string[] = [];
  const uploads: string[] = [];
  const disposed: string[] = [];
  const fetcher: PageFetcher<Decoded> = {
    fetch(page, _url, signal) {
      fetchLog.push(page.id);
      return new Promise<Decoded>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        jobs.push({ pageId: page.id, signal, resolve: () => resolve({ id: page.id }), fail: (e) => reject(e) });
      });
    },
    release: (d) => released.push(d.id),
  };
  let uploadCount = 0;
  const uploader: PageUploader<Decoded, Gpu> = {
    upload: (page, d) => {
      uploads.push(page.id);
      return { id: d.id, upload: ++uploadCount };
    },
    dispose: (r) => disposed.push(r.id),
    gpuBytes: () => 1000, // uniform size keeps budget arithmetic obvious
  };
  let now = 0;
  let nextTimer = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  const scheduler = {
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ at: now + ms, fn, id: ++nextTimer });
      return nextTimer;
    },
    clearTimeout: (h: unknown) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const reg = new SourceAssetRegistry(index, '/assets', fetcher, uploader, { uploadsPerFrame: 100, ...options }, scheduler);
  let frame = 0;
  const tickMacro = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    reg,
    fetchLog,
    released,
    uploads,
    disposed,
    jobs,
    step: () => reg.beginFrame(++frame),
    /** Completes every pending fetch successfully. */
    async settle() {
      const open = jobs.splice(0);
      for (const j of open) j.resolve();
      await tickMacro();
    },
    async fail(pageId: string, error: unknown) {
      const i = jobs.findIndex((j) => j.pageId === pageId && !j.signal.aborted);
      if (i < 0) throw new Error(`no pending fetch for ${pageId}`);
      const [job] = jobs.splice(i, 1);
      job?.fail(error);
      await tickMacro();
    },
    advance(ms: number) {
      now += ms;
      for (const t of [...timers].filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
    /** step (start fetches) -> settle (decode) -> step (upload + budget). */
    async load() {
      reg.beginFrame(++frame);
      const open = jobs.splice(0);
      for (const j of open) j.resolve();
      await tickMacro();
      reg.beginFrame(++frame);
    },
    status: (pageId: string) => reg.pageStatuses().find((s) => s.pageId === pageId),
  };
}

const HAT1 = 'page-hat_01-0';
const HAT2 = 'page-hat_02-0';
const HAT3 = 'page-hat_03-0';

describe('source asset registry v2', () => {
  it('fetches each page once, shares pins, serves demand before prefetch and caps concurrency', async () => {
    const { index } = await compiledAssets();
    const h = harness(index, { maxConcurrentFetches: 1 });
    h.reg.prefetchItem('hat_02'); // requested first, but only prefetch
    h.reg.acquireItem('hat_01');
    h.reg.acquireItem('hat_01'); // a second character with the same hat
    h.step();
    expect(h.fetchLog).toEqual([HAT1]);
    await h.settle();
    h.step();
    expect(h.reg.pageState(HAT1)).toBe('RESIDENT');
    expect(h.fetchLog).toEqual([HAT1, HAT2]);
    expect(h.status(HAT1)?.refs).toBe(2);
    // body_base and head_base share the 'core' page: acquiring both costs one fetch.
    h.reg.acquireItem('body_base');
    h.reg.acquireItem('head_base');
    await h.settle();
    await h.load();
    expect(h.fetchLog.filter((p) => p === 'page-core-0')).toHaveLength(1);
    expect(h.status('page-core-0')?.refs).toBe(2);
  });

  it('bounds GPU uploads per frame', async () => {
    const { index } = await compiledAssets();
    const h = harness(index, { uploadsPerFrame: 1 });
    for (const id of ['hat_01', 'hat_02', 'hat_03']) h.reg.acquireItem(id);
    h.step();
    await h.settle();
    expect(h.uploads).toHaveLength(0);
    h.step();
    expect(h.uploads).toHaveLength(1);
    h.step();
    expect(h.uploads).toHaveLength(2);
    h.step();
    expect(h.uploads).toHaveLength(3);
    expect(h.reg.isIdle()).toBe(true);
  });

  it('an equipment swap fetches only the new item; unchanged pages are never refetched', async () => {
    const { index } = await compiledAssets();
    const h = harness(index);
    for (const id of ['body_base', 'head_base', 'hair_01', 'armor_01', 'hat_01', 'weapon_01']) h.reg.acquireItem(id);
    await h.load();
    expect([...h.fetchLog].sort()).toEqual(['page-armor_01-0', 'page-core-0', 'page-hair_01-0', HAT1, 'page-weapon_01-0']);
    h.reg.releaseItem('hat_01');
    h.reg.acquireItem('hat_02');
    await h.load();
    expect(h.fetchLog.slice(5)).toEqual([HAT2]);
  });

  it('cancels loads nobody needs: aborts in-flight fetches and drops decoded copies', async () => {
    const { index } = await compiledAssets();
    const h = harness(index);
    h.reg.acquireItem('hat_02');
    h.step();
    const job = h.jobs[0];
    h.reg.releaseItem('hat_02');
    expect(job?.signal.aborted).toBe(true);
    expect(h.reg.pageState(HAT2)).toBe('UNRESOLVED');
    h.reg.acquireItem('hat_03');
    h.step();
    await h.settle(); // decoded, waiting for upload
    expect(h.reg.pageState(HAT3)).toBe('UPLOAD_QUEUED');
    h.reg.releaseItem('hat_03');
    expect(h.released).toContain(HAT3);
    expect(h.reg.pageState(HAT3)).toBe('UNRESOLVED');
    expect(h.reg.stats().cancelled).toBe(2);
    expect(h.status(HAT2)?.cancels).toBe(1);
    h.step();
    expect(h.uploads).toEqual([]);
  });

  it('retries transient failures with exponential backoff, fails fast on 404, never storms', async () => {
    const { index } = await compiledAssets();
    const h = harness(index, { retryBaseMs: 100, maxAttempts: 3 });
    h.reg.acquireItem('hat_01');
    h.step();
    await h.fail(HAT1, new PageFetchError('HTTP 503', true, 503));
    expect(h.reg.pageState(HAT1)).toBe('RETRY_BACKOFF');
    h.advance(99);
    h.step();
    expect(h.fetchLog).toHaveLength(1);
    h.advance(1);
    h.step();
    expect(h.fetchLog).toHaveLength(2); // after 100 ms
    await h.fail(HAT1, new Error('network down')); // plain errors are treated as transient
    h.advance(199);
    h.step();
    expect(h.fetchLog).toHaveLength(2);
    h.advance(1);
    h.step();
    expect(h.fetchLog).toHaveLength(3); // after 200 ms
    await h.fail(HAT1, new PageFetchError('HTTP 503', true, 503));
    expect(h.reg.pageState(HAT1)).toBe('FAILED'); // 3 attempts used
    for (let i = 0; i < 5; i++) {
      h.reg.acquireItem('hat_01');
      h.advance(10_000);
      h.step();
    }
    expect(h.fetchLog).toHaveLength(3);
    expect(h.reg.stats().retries).toBe(2);
    h.reg.retry(HAT1); // explicit user/debug action
    await h.load();
    expect(h.reg.pageState(HAT1)).toBe('RESIDENT');
    // Not transient: no backoff at all.
    h.reg.acquireItem('hat_02');
    h.step();
    await h.fail(HAT2, new PageFetchError('HTTP 404', false, 404));
    expect(h.reg.pageState(HAT2)).toBe('FAILED');
    expect(h.reg.stats().retries).toBe(2);
    expect(h.reg.itemState('hat_02')).toBe('FAILED');
  });

  it('evicts unpinned pages LRU-first down to the low watermark and never evicts pinned pages', async () => {
    const { index } = await compiledAssets();
    const h = harness(index, { budgetBytes: 3000, lowWaterRatio: 0.67 });
    for (const id of ['hat_01', 'hat_02', 'hat_03']) h.reg.acquireItem(id);
    await h.load();
    expect(h.reg.stats().residentBytes).toBe(3000);
    h.reg.releaseItem('hat_01');
    h.reg.releaseItem('hat_02');
    h.step();
    h.reg.touch(HAT2); // hat_02 used more recently than hat_01
    expect(h.reg.stats().evictions).toBe(0); // still within budget
    h.reg.acquireItem('weapon_01');
    await h.load(); // 4000 > 3000: evict unpinned LRU-first down to <= 2010
    expect(h.reg.pageState(HAT1)).toBe('EVICTED');
    expect(h.reg.pageState(HAT2)).toBe('EVICTED');
    expect(h.disposed).toEqual([HAT1, HAT2]);
    expect(h.released).toEqual(expect.arrayContaining([HAT1, HAT2]));
    expect(h.reg.stats().residentBytes).toBe(2000);
    // Pinned set larger than the budget: report it, evict nothing pinned.
    for (const id of ['armor_01', 'armor_02', 'armor_03']) h.reg.acquireItem(id);
    await h.load();
    const s = h.reg.stats();
    expect(s.byState.EVICTED).toBe(2);
    expect(s.overBudget).toBe(true);
    expect(s.pinnedBytes).toBe(5000);
    // An evicted page is refetched on demand and counted as a reload.
    h.reg.acquireItem('hat_01');
    await h.load();
    expect(h.reg.pageState(HAT1)).toBe('RESIDENT');
    expect(h.reg.stats().reloads).toBe(1);
  });

  it('handles are generation-checked: stale after eviction even when the slot is reused (ABA)', async () => {
    const { index } = await compiledAssets();
    const h = harness(index, { budgetBytes: 500, lowWaterRatio: 1 });
    h.reg.acquireItem('hat_01');
    await h.load(); // pinned: over budget but kept
    const old = h.reg.handleFor(HAT1);
    if (!old) throw new Error('no handle');
    expect(h.reg.resolve(old)?.id).toBe(HAT1);
    h.reg.releaseItem('hat_01');
    h.step(); // unpinned and over budget: evicted, slot freed
    expect(h.reg.pageState(HAT1)).toBe('EVICTED');
    expect(h.reg.resolve(old)).toBeNull();
    h.reg.acquireItem('hat_02');
    await h.load();
    const fresh = h.reg.handleFor(HAT2);
    if (!fresh) throw new Error('no handle');
    expect(fresh.index).toBe(old.index); // same slot reused...
    expect(fresh.generation).toBe(old.generation + 1); // ...new generation
    expect(h.reg.resolve(old)).toBeNull(); // the old handle can never see hat_02
    expect(h.reg.resolve(fresh)?.id).toBe(HAT2);
    expect(h.reg.stats().staleResolves).toBe(2);
  });

  it('recovers from context loss by re-uploading decoded copies without any network request', async () => {
    const { index } = await compiledAssets();
    const h = harness(index);
    h.reg.acquireItem('hat_01');
    h.reg.acquireItem('weapon_01');
    await h.load();
    const fetches = h.fetchLog.length;
    const old = h.reg.handleFor(HAT1);
    if (!old) throw new Error('no handle');
    h.reg.onContextLost();
    expect(h.reg.pageState(HAT1)).toBe('UPLOAD_QUEUED');
    expect(h.reg.resolve(old)).toBeNull();
    h.step();
    expect(h.uploads).toHaveLength(2); // uploads paused while lost
    h.reg.onContextRestored();
    h.step();
    expect(h.uploads).toHaveLength(4);
    expect(h.reg.pageState(HAT1)).toBe('RESIDENT');
    expect(h.fetchLog).toHaveLength(fetches);
    expect(h.reg.stats().contextLosses).toBe(1);
    // Without decoded copies the pages must be fetched again.
    const h2 = harness(index, { keepDecodedCopies: false });
    h2.reg.acquireItem('hat_01');
    await h2.load();
    h2.reg.onContextLost();
    expect(h2.reg.pageState(HAT1)).toBe('REQUESTED');
    h2.reg.onContextRestored();
    await h2.load();
    expect(h2.reg.pageState(HAT1)).toBe('RESIDENT');
    expect(h2.fetchLog).toEqual([HAT1, HAT1]);
  });

  it('reports idle/item state across the lifecycle', async () => {
    const { index } = await compiledAssets();
    const h = harness(index);
    expect(h.reg.isIdle()).toBe(true);
    expect(h.reg.itemState('body_base')).toBe('UNRESOLVED');
    h.reg.acquireItem('body_base');
    expect(h.reg.isIdle()).toBe(false);
    expect(h.reg.itemState('body_base')).toBe('REQUESTED');
    h.step();
    expect(h.reg.itemState('body_base')).toBe('FETCHING');
    await h.settle();
    expect(h.reg.itemState('head_base')).toBe('UPLOAD_QUEUED'); // same core page
    h.step();
    expect(h.reg.itemState('body_base')).toBe('RESIDENT');
    expect(h.reg.isIdle()).toBe(true);
    expect(h.reg.itemState('no_such_item')).toBe('FAILED');
    h.reg.dispose();
    expect(h.disposed).toEqual(['page-core-0']);
  });
});
