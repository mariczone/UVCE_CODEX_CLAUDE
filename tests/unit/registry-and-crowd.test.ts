import { describe, expect, it } from 'vitest';
import { type PageLoader, SourceAssetRegistry } from '../../src/uvce/assets/source-registry.ts';
import { HERO_ID, generateCrowd, patrolPose } from '../../src/uvce/bench/crowd.ts';
import { percentile, summarize } from '../../src/uvce/bench/frame-stats.ts';
import { resolveAppearance } from '../../src/uvce/core/appearance-resolver.ts';
import { appearanceKey } from '../../src/uvce/core/cache-keys.ts';
import type { CompiledPage } from '../../src/uvce/schema/compiled-manifest.ts';
import { compiledAssets } from './helpers.ts';

function fakeLoader(fail: Set<string> = new Set()) {
  const calls: string[] = [];
  const disposed: string[] = [];
  const pending: { page: CompiledPage; resolve: () => void; reject: (e: Error) => void }[] = [];
  const loader: PageLoader<{ id: string }> = {
    load(page, url) {
      calls.push(url);
      return new Promise((resolve, reject) => {
        pending.push({ page, resolve: () => (fail.has(page.owner) ? reject(new Error('404')) : resolve({ id: page.id })), reject });
      });
    },
    dispose(r) {
      disposed.push(r.id);
    },
  };
  const flush = async (): Promise<void> => {
    while (pending.length) pending.shift()?.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { loader, calls, disposed, flush };
}

describe('source asset registry', () => {
  it('fetches each page once, shares in-flight requests and reports residency', async () => {
    const { index } = await compiledAssets();
    const f = fakeLoader();
    const reg = new SourceAssetRegistry(index, '/assets/', f.loader);
    expect(reg.itemState('hat_01')).toBe('UNRESOLVED');
    const a = reg.ensureItem('hat_01');
    const b = reg.ensureItem('hat_01');
    expect(reg.itemState('hat_01')).toBe('FETCHING');
    await f.flush();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(reg.itemState('hat_01')).toBe('RESIDENT');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatch(/^\/assets\/pages\/hat_01-0-[0-9a-f]{12}\.png$/);
    expect(await reg.ensureItem('hat_01')).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(reg.stats()).toMatchObject({ resident: 1, loads: 1 });
    expect(reg.stats().sharedRequests).toBeGreaterThanOrEqual(2);
  });

  it('equipping a new hat loads only that hat; unchanged equipment is never re-fetched', async () => {
    const { index } = await compiledAssets();
    const f = fakeLoader();
    const reg = new SourceAssetRegistry(index, '', f.loader);
    const look = ['body_base', 'head_base', 'hair_01', 'armor_01', 'hat_01', 'weapon_01'];
    const all = Promise.all(look.map((i) => reg.ensureItem(i)));
    await f.flush();
    await all;
    const before = f.calls.length;
    const swap = Promise.all(['body_base', 'head_base', 'hair_01', 'armor_01', 'hat_02', 'weapon_01'].map((i) => reg.ensureItem(i)));
    await f.flush();
    await swap;
    expect(f.calls.slice(before)).toHaveLength(1);
    expect(f.calls.at(-1)).toContain('/pages/hat_02-');
  });

  it('marks failures without retry storms; explicit retry works; dispose releases resources', async () => {
    const { index } = await compiledAssets();
    const fail = new Set(['weapon_02']);
    const f = fakeLoader(fail);
    const reg = new SourceAssetRegistry(index, '', f.loader);
    const changes: number[] = [];
    reg.onChange(() => changes.push(reg.revision));
    const p = reg.ensureItem('weapon_02');
    await f.flush();
    expect(await p).toBe(false);
    expect(reg.itemState('weapon_02')).toBe('FAILED');
    for (let i = 0; i < 5; i++) expect(await reg.ensureItem('weapon_02')).toBe(false);
    expect(f.calls).toHaveLength(1); // no automatic retry
    expect(reg.pageStatuses().find((s) => s.owner === 'weapon_02')?.error).toBe('404');
    fail.delete('weapon_02');
    const pageId = index.items.get('weapon_02')?.pages[0] as string;
    const retry = reg.retry(pageId);
    await f.flush();
    expect(await retry).toBe(true);
    expect(changes.length).toBeGreaterThanOrEqual(4);
    expect(await reg.ensureItem('unknown_item')).toBe(false);
    reg.dispose();
    expect(f.disposed).toEqual([pageId]);
  });
});

describe('deterministic crowd fixture', () => {
  it('is a pure function of seed and index; members are stable as the crowd grows', async () => {
    const { index } = await compiledAssets();
    const a = generateCrowd(index, { count: 100, seed: 42 });
    const b = generateCrowd(index, { count: 100, seed: 42 });
    expect(a).toEqual(b);
    const small = generateCrowd(index, { count: 20, seed: 42 });
    expect(small).toEqual(a.slice(0, 20));
    const other = generateCrowd(index, { count: 100, seed: 43 });
    expect(other.slice(1)).not.toEqual(a.slice(1));
    expect(a[0]?.entityId).toBe(HERO_ID);
    expect(new Set(a.map((m) => m.entityId)).size).toBe(100);
    expect(generateCrowd(index, { count: 0, seed: 1 })).toEqual([]);
  });

  it('places characters without exact overlaps and with resolvable, varied appearances', async () => {
    const { index } = await compiledAssets();
    const crowd = generateCrowd(index, { count: 300, seed: 7 });
    let minD = Infinity;
    for (let i = 0; i < crowd.length; i++)
      for (let j = i + 1; j < crowd.length; j++) {
        const p = crowd[i];
        const q = crowd[j];
        if (p && q) minD = Math.min(minD, Math.hypot(p.x - q.x, p.z - q.z));
      }
    expect(minD).toBeGreaterThan(0.3);
    const keys = new Set<string>();
    for (const m of crowd) {
      const r = resolveAppearance(index, m.appearance);
      expect(r.ok && r.value.issues).toEqual([]);
      if (r.ok) keys.add(appearanceKey(r.value));
    }
    expect(keys.size).toBeGreaterThan(100); // many unique looks, without any per-combination sheet
    expect(crowd.some((m) => m.clipId === 'walk') && crowd.some((m) => m.clipId === 'idle')).toBe(true);
  });

  it('patrol motion is a pure function of time (deterministic replay)', async () => {
    const { index } = await compiledAssets();
    const walker = generateCrowd(index, { count: 50, seed: 3 }).find((m) => m.patrol);
    if (!walker?.patrol) throw new Error('no walker');
    expect(patrolPose(walker, 12_345)).toEqual(patrolPose(walker, 12_345));
    const period = ((2 * walker.patrol.length) / walker.patrol.speed) * 1000;
    const p0 = patrolPose(walker, 1000);
    const p1 = patrolPose(walker, 1000 + period);
    expect(p1.x).toBeCloseTo(p0.x, 9);
    expect(p1.z).toBeCloseTo(p0.z, 9);
  });
});

describe('frame statistics', () => {
  it('uses nearest-rank percentiles', () => {
    const v = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile([], 50)).toBeNaN();
    expect(summarize([2, 4])).toMatchObject({ samples: 2, mean: 3, max: 4 });
  });
});
