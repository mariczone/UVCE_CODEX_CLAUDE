import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { type PageFetcher, type PageUploader, SourceAssetRegistry } from '../../src/uvce/assets/source-registry.ts';
import { companionAppearance, generateCrowd, heroAppearance } from '../../src/uvce/bench/crowd.ts';
import { appearanceKey } from '../../src/uvce/core/cache-keys.ts';
import { resolveAppearance } from '../../src/uvce/core/appearance-resolver.ts';
import type { CharacterInstance } from '../../src/uvce/render/contracts.ts';
import { type BakeJob, type CacheCell, type FrameCacheBackend, FrameCacheAllocator } from '../../src/uvce/render/webgl/frame-cache.ts';
import { LayeredCharacterRenderer } from '../../src/uvce/render/webgl/layered-renderer.ts';
import type { ManifestIndex } from '../../src/uvce/schema/compiled-manifest.ts';
import { compiledAssets } from './helpers.ts';

describe('frame cache allocator', () => {
  it('reuses keys, grows pages up to the limit, then evicts LRU cells not used this frame', () => {
    const a = new FrameCacheAllocator({ cellsPerPage: 2, maxPages: 2 });
    a.beginFrame(1);
    const k1 = a.allocate('k1') as CacheCell;
    const k2 = a.allocate('k2') as CacheCell;
    expect(a.pages).toBe(1);
    a.allocate('k3');
    expect(a.pages).toBe(2);
    a.allocate('k4');
    expect(a.lookup('k1')).toBe(k1);
    // Every cell was used in frame 1: no room left this frame (caller falls back).
    expect(a.allocate('k5')).toBeNull();
    a.beginFrame(2);
    a.touch(k1); // k1 is still drawn in frame 2
    const k5 = a.allocate('k5') as CacheCell;
    expect(k5).toBe(k2); // LRU among cells not used in frame 2 (k2, k3, k4 tie at frame 1: first wins)
    expect(a.lookup('k2')).toBeNull();
    expect(a.stats()).toMatchObject({ pages: 2, cells: 4, usedCells: 4, evictions: 1 });
  });

  it('generations: a holder notices its cell was reassigned or the cache was cleared', () => {
    const a = new FrameCacheAllocator({ cellsPerPage: 1, maxPages: 1 });
    a.beginFrame(1);
    const cell = a.allocate('walk-3') as CacheCell;
    const held = { key: 'walk-3', generation: cell.generation };
    expect(a.isValid(cell, held.key, held.generation)).toBe(true);
    a.beginFrame(2);
    expect(a.allocate('walk-4')).toBe(cell); // same cell, new content
    expect(a.isValid(cell, held.key, held.generation)).toBe(false);
    const again = { key: 'walk-4', generation: cell.generation };
    a.clear(); // context loss
    expect(a.isValid(cell, again.key, again.generation)).toBe(false);
    expect(a.lookup('walk-4')).toBeNull();
  });

  it('admission: a frame is admitted on its second request within the window, never on the first', () => {
    const a = new FrameCacheAllocator({ cellsPerPage: 4, maxPages: 1, admitWindow: 10 });
    a.beginFrame(1);
    expect(a.admit('x')).toBe(false);
    expect(a.admit('x')).toBe(true); // a second character wants the same frame in the same frame
    expect(a.admit('y')).toBe(false);
    a.beginFrame(20);
    expect(a.admit('y')).toBe(false); // seen too long ago: counts as a first request again
    expect(a.admit('y')).toBe(true);
    expect(a.stats().rejected).toBe(3);
  });
});

describe('crowd workload knobs', () => {
  it('looks=N limits NPC outfits without moving anyone; sync=1 only zeroes the phases', async () => {
    const { index } = await compiledAssets();
    const base = generateCrowd(index, { count: 60, seed: 7 });
    const looks = generateCrowd(index, { count: 60, seed: 7, looks: 4 });
    const synced = generateCrowd(index, { count: 60, seed: 7, syncPhases: true });
    const key = (m: (typeof base)[number]): string => {
      const r = resolveAppearance(index, m.appearance);
      return r.ok ? appearanceKey(r.value) : 'bad';
    };
    expect(new Set(looks.slice(1).map(key)).size).toBeLessThanOrEqual(4);
    expect(new Set(base.slice(1).map(key)).size).toBeGreaterThan(20);
    for (let i = 0; i < base.length; i++) {
      const [b, l, s] = [base[i], looks[i], synced[i]] as [(typeof base)[number], (typeof base)[number], (typeof base)[number]];
      expect([l.x, l.z, l.facingYaw, l.clipId, l.phaseOffsetMs]).toEqual([b.x, b.z, b.facingYaw, b.clipId, b.phaseOffsetMs]);
      expect([s.x, s.z, s.facingYaw, s.clipId, s.appearance]).toEqual([b.x, b.z, b.facingYaw, b.clipId, b.appearance]);
      if (i > 0) expect(s.phaseOffsetMs).toBe(0);
    }
  });
});

/** Renderer in FULL_CACHE mode with a fake GPU side: bake() only records jobs. */
function setup(index: ManifestIndex, cache: { cellsPerPage: number; maxPages: number; admitWindow?: number }, bakeBudget = 24) {
  const fetcher: PageFetcher<string> = { fetch: (page) => Promise.resolve(page.id), release: () => {} };
  const uploader: PageUploader<string, THREE.Texture> = { upload: (page) => Object.assign(new THREE.Texture(), { name: page.id }), dispose: (t) => t.dispose(), gpuBytes: () => 1000 };
  const registry = new SourceAssetRegistry(index, '/assets', fetcher, uploader, { uploadsPerFrame: 100 });
  const allocator = new FrameCacheAllocator(cache);
  const pageTextures: THREE.Texture[] = [];
  const baked: BakeJob[][] = [];
  const backend: FrameCacheBackend = {
    allocator,
    bytesPerPage: 4096,
    pageTexture: (page) => (pageTextures[page] ??= Object.assign(new THREE.Texture(), { name: `cache-${page}` })),
    bake: (jobs) => baked.push([...jobs]),
    uvRect: (_cell, _rect, out) => out.set(0, 1, 1, 0),
    onContextLost: () => allocator.clear(),
    onContextRestored: () => {},
    dispose: () => {},
  };
  const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 120);
  camera.position.set(0, 3, 6);
  camera.lookAt(0, 0.8, 0);
  const renderer = new LayeredCharacterRenderer({ index, registry, scene: new THREE.Scene(), camera, shadows: false, mode: 'FULL_CACHE', frameCache: backend, bakeBudget });
  let frame = 0;
  return {
    renderer,
    allocator,
    baked,
    async frame(characters: CharacterInstance[], n = 1, nowMs?: number) {
      for (let i = 0; i < n; i++) {
        registry.beginFrame(++frame);
        renderer.prepareFrame(characters, nowMs ?? 0);
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
}

const idle = (entityId: string, x: number, appearance = heroAppearance()): CharacterInstance => ({
  entityId,
  position: { x, y: 0, z: 0 },
  facingYaw: 0,
  appearance,
  animation: { clipId: 'idle', clipStartMs: 0, speed: 1, phaseOffsetMs: 0 },
  visible: true,
});

describe('FULL_CACHE render mode', () => {
  it('first sight draws directly, second sight bakes once, later frames reuse the cell without baking', async () => {
    const { index } = await compiledAssets();
    const t = setup(index, { cellsPerPage: 8, maxPages: 1 });
    const hero = idle('hero', 0);
    await t.frame([hero], 6); // pages load
    const m = t.renderer.getMetrics();
    expect(m.cachedCharacters).toBe(1);
    expect(t.baked.flat()).toHaveLength(1); // baked exactly once
    expect(t.baked.flat()[0]?.layers).toHaveLength(m.visibleLayers);
    await t.frame([hero], 20);
    expect(t.baked.flat()).toHaveLength(1); // still once: every later frame was a cache hit
    expect(t.renderer.getMetrics().cacheHitRatio).toBe(1);
    expect(t.renderer.auditBindings().violations).toBe(0);
  });

  it('two characters with the same look and frame share one cell (one bake)', async () => {
    const { index } = await compiledAssets();
    const t = setup(index, { cellsPerPage: 8, maxPages: 1 });
    const a = idle('a', -0.4);
    const b = idle('b', 0.4); // same appearance, clip, frame; same direction from this camera
    await t.frame([a, b], 6);
    expect(t.renderer.getMetrics().cachedCharacters).toBe(2);
    expect(t.baked.flat()).toHaveLength(1);
  });

  it('an evicted cell is noticed: the character re-bakes or falls back, never draws the other frame', async () => {
    const { index } = await compiledAssets();
    const t = setup(index, { cellsPerPage: 1, maxPages: 1, admitWindow: 1000 });
    const hero = idle('hero', 0);
    const npc = idle('npc', 0.6, companionAppearance());
    await t.frame([hero], 6);
    expect(t.renderer.getMetrics().cachedCharacters).toBe(1);
    // The npc is processed first and takes the only cell (the hero last touched it a frame ago): the hero must notice
    // and never draw the npc's frame.
    for (let i = 0; i < 12; i++) {
      await t.frame([npc, hero]);
      expect(t.renderer.auditBindings().violations).toBe(0);
      expect(t.renderer.getMetrics().cachedCharacters).toBeLessThanOrEqual(1);
      expect(t.renderer.getMetrics().cachedCharacters + t.renderer.getMetrics().compositedCharacters).toBe(2);
    }
  });

  it('thrash breaker: a working set larger than the cache pauses baking; misses use SHADER meanwhile', async () => {
    const { index } = await compiledAssets();
    const t = setup(index, { cellsPerPage: 1, maxPages: 1, admitWindow: 10_000 }, 2);
    const crowd = [idle('a', -0.6), idle('b', 0, companionAppearance()), idle('c', 0.6, { ...heroAppearance(), slots: { ...heroAppearance().slots, hat: { itemId: 'hat_02' } } })];
    await t.frame(crowd, 6);
    let bakesBefore = 0;
    for (let f = 0; f < 70; f++) {
      await t.frame(crowd, 1, f * 167); // idle frames advance: new keys keep arriving, one cell cannot hold them
      bakesBefore = t.baked.flat().length;
    }
    const m = t.renderer.getMetrics();
    expect(m.frameCachePauses).toBeGreaterThanOrEqual(1);
    expect(m.frameCachePaused).toBe(true);
    await t.frame(crowd, 30, 99_000);
    expect(t.baked.flat().length).toBe(bakesBefore); // no baking while paused
    expect(t.renderer.getMetrics().compositedCharacters).toBeGreaterThanOrEqual(2);
    expect(t.renderer.auditBindings().violations).toBe(0);
  });

  it('context loss drops every cached frame; characters fall back until baked again', async () => {
    const { index } = await compiledAssets();
    const t = setup(index, { cellsPerPage: 8, maxPages: 1 });
    const hero = idle('hero', 0);
    await t.frame([hero], 6);
    expect(t.renderer.getMetrics().cachedCharacters).toBe(1);
    t.renderer.onContextLost();
    await t.frame([hero]);
    expect(t.renderer.getMetrics().cachedCharacters).toBe(0);
    expect(t.renderer.getMetrics().compositedCharacters).toBe(1);
    t.renderer.onContextRestored();
    await t.frame([hero], 3);
    expect(t.renderer.getMetrics().cachedCharacters).toBe(1);
    expect(t.baked.flat()).toHaveLength(2);
  });
});
