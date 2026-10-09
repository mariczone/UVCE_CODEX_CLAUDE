import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { type PageFetcher, PageFetchError, type PageUploader, type RegistryOptions, SourceAssetRegistry } from '../../src/uvce/assets/source-registry.ts';
import { companionAppearance, heroAppearance } from '../../src/uvce/bench/crowd.ts';
import { withSlot } from '../../src/uvce/core/appearance-resolver.ts';
import type { CharacterInstance } from '../../src/uvce/render/contracts.ts';
import { DEFAULT_LOD_POLICY, type LodPolicy } from '../../src/uvce/render/lod.ts';
import { LayeredCharacterRenderer, type LayeredRendererOptions } from '../../src/uvce/render/webgl/layered-renderer.ts';
import type { ManifestIndex } from '../../src/uvce/schema/compiled-manifest.ts';
import { compiledAssets } from './helpers.ts';

/** Real registry with instant fake network/GPU ports; counts every pin/prefetch call the renderer makes. */
function setup(index: ManifestIndex, options: Partial<RegistryOptions> = {}, extra: { mode?: 'LAYERED' | 'SHADER'; failPage?: string; lod?: LayeredRendererOptions['lod'] } = {}) {
  const fetchLog: string[] = [];
  const fetcher: PageFetcher<string> = {
    fetch: (page) => {
      fetchLog.push(page.id);
      if (page.id === extra.failPage) return Promise.reject(new PageFetchError('HTTP 404', false, 404));
      return Promise.resolve(page.id);
    },
    release: () => {},
  };
  const uploader: PageUploader<string, THREE.Texture> = {
    upload: (page) => Object.assign(new THREE.Texture(), { name: page.id }),
    dispose: (texture) => texture.dispose(),
    gpuBytes: () => 1000,
  };
  const registry = new SourceAssetRegistry(index, '/assets', fetcher, uploader, { uploadsPerFrame: 100, ...options });
  const calls = { acquire: 0, release: 0, prefetch: 0 };
  for (const name of ['acquire', 'release', 'prefetch'] as const) {
    const method = `${name}Item` as const;
    const original = registry[method].bind(registry);
    registry[method] = (itemId: string) => {
      calls[name]++;
      original(itemId);
    };
  }
  const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 120);
  camera.position.set(0, 3, 6);
  camera.lookAt(0, 0.8, 0);
  const renderer = new LayeredCharacterRenderer({ index, registry, scene: new THREE.Scene(), camera, shadows: false, mode: extra.mode, lod: extra.lod });
  let frame = 0;
  return {
    registry,
    renderer,
    calls,
    fetchLog,
    /** One app frame: residency pump, prepare (walk clip advances), then let fetch promises settle. */
    async frame(characters: CharacterInstance[], n = 1) {
      for (let i = 0; i < n; i++) {
        registry.beginFrame(++frame);
        renderer.prepareFrame(characters, frame * 50);
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
}

const character = (entityId: string, x: number, appearance = heroAppearance()): CharacterInstance => ({
  entityId,
  position: { x, y: 0, z: 0 },
  facingYaw: 0,
  appearance,
  animation: { clipId: 'walk', clipStartMs: 0, speed: 1, phaseOffsetMs: 0 },
  visible: true,
});

describe('layered renderer residency bookkeeping', () => {
  it('pins once per appearance: animating frames make no residency calls, a swap touches only the changed item', async () => {
    const { index } = await compiledAssets();
    const t = setup(index);
    const hero = character('hero', 0);
    const npc = character('npc', 0.6, companionAppearance());
    await t.frame([hero, npc], 6); // 9 pages at 4 concurrent fetches: request, 3 fetch waves, last upload
    expect(t.renderer.getMetrics().pendingLayers).toBe(0);
    expect(t.renderer.getMetrics().visibleLayers).toBeGreaterThan(10);
    expect(t.calls).toEqual({ acquire: 12, release: 0, prefetch: 0 }); // 6 items per character, once
    let poseUpdates = 0;
    for (let i = 0; i < 60; i++) {
      await t.frame([hero, npc]);
      poseUpdates += t.renderer.getMetrics().poseUpdates;
    }
    expect(poseUpdates).toBeGreaterThan(20); // the walk cycle really re-poses...
    expect(t.calls).toEqual({ acquire: 12, release: 0, prefetch: 0 }); // ...without any residency traffic
    hero.appearance = withSlot(hero.appearance, 'hat', 'hat_02');
    await t.frame([hero, npc], 3);
    expect(t.calls).toEqual({ acquire: 13, release: 1, prefetch: 0 });
    expect(t.renderer.getMetrics().pendingLayers).toBe(0);
    expect(t.renderer.auditBindings().violations).toBe(0);
  });

  it('defence in depth: a stale handle is never drawn, even if the registry forgot to bump its revision', async () => {
    const { index } = await compiledAssets();
    const t = setup(index);
    const hero = character('hero', 0);
    await t.frame([hero], 4);
    const layers = t.renderer.getMetrics().visibleLayers;
    // Simulated registry bug: the hat page loses its GPU slot but the revision (part of the pose key) stays put.
    const internals = t.registry as unknown as { entries: Map<string, unknown>; evict(entry: unknown): void; revision: number };
    const revision = internals.revision;
    internals.evict(internals.entries.get('page-hat_01-0'));
    internals.revision = revision;
    await t.frame([hero]);
    expect(t.renderer.getMetrics().staleBindings).toBe(1);
    expect(t.renderer.getMetrics().visibleLayers).toBe(layers - 1); // the hat layer is hidden, not drawn stale
    expect(t.renderer.auditBindings().violations).toBe(0);
    await t.frame([hero], 2);
    expect(t.renderer.getMetrics().staleBindings).toBe(0);
    expect(t.renderer.getMetrics().pendingLayers).toBe(1); // rebound: waiting for the page instead
  });

  it('a culled character prefetches once per culling, within headroom, and evicted prefetches are not refetched', async () => {
    const { index } = await compiledAssets();
    const t = setup(index, { budgetBytes: 7000, lowWaterRatio: 1 });
    const hero = character('hero', 0); // 5 pages (body + head share the core page)
    const far = character('far', 500, companionAppearance()); // off screen; 4 pages of its own + core
    await t.frame([hero, far], 5);
    expect(t.renderer.getMetrics().culledCharacters).toBe(1);
    expect(t.calls.prefetch).toBe(6);
    // 5 pinned pages + prefetches up to the 7000 B low watermark: 2 of far's 4 pages fit, 2 are dropped.
    expect(t.registry.stats().byState.RESIDENT).toBe(7);
    expect(t.registry.stats().prefetchSkipped).toBe(2);
    await t.frame([hero, far], 30);
    expect(t.calls.prefetch).toBe(6); // not once per frame
    expect(t.fetchLog).toHaveLength(7);
    // A demand swap needs 2 new pages: the unpinned prefetched pages are evicted first (least recently used)...
    hero.appearance = withSlot(withSlot(hero.appearance, 'hat', 'hat_02'), 'weapon', 'weapon_03');
    await t.frame([hero, far], 5);
    expect(t.registry.stats().evictions).toBe(2);
    expect(t.registry.pageState('page-hat_01-0')).toBe('RESIDENT'); // released later than the prefetches
    // ...and are not requested again while the character stays culled (no fetch/evict thrash).
    await t.frame([hero, far], 30);
    expect(t.fetchLog).toHaveLength(9);
    expect(t.calls.prefetch).toBe(6);
    // Visible again: demand loads; culled again: exactly one renewed prefetch.
    far.position.x = 0.7;
    await t.frame([hero, far], 5);
    expect(t.renderer.getMetrics().pendingLayers).toBe(0);
    expect(t.registry.stats().overBudget).toBe(true); // 2 x 5 pinned pages > budget: reported, nothing pinned evicted
    far.position.x = 500;
    await t.frame([hero, far], 10);
    expect(t.calls.prefetch).toBe(12);
    expect(t.renderer.auditBindings().violations).toBe(0);
  });
});

describe('SHADER render mode (one composited quad per character)', () => {
  it('composites every layer into one quad in painter order; the per-layer quads stay hidden', async () => {
    const { index } = await compiledAssets();
    const t = setup(index, {}, { mode: 'SHADER' });
    const hero = character('hero', 0);
    await t.frame([hero], 6);
    const m = t.renderer.getMetrics();
    expect(m.mode).toBe('SHADER');
    expect(m.compositedCharacters).toBe(1);
    expect(m.pendingLayers).toBe(0);
    const group = t.renderer.root.children.find((c) => c.name === 'character:hero') as THREE.Group;
    const visible = group.children.filter((c) => c.visible);
    expect(visible.map((c) => c.name)).toEqual(['composite:hero']);
    const u = (visible[0] as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>).material.uniforms;
    const count = u.uCount?.value as number;
    expect(count).toBe(m.visibleLayers);
    // Slots hold the pose's layers sorted back to front (the order LAYERED would draw them).
    const pose = t.renderer.debugInfo('hero')?.pose;
    const expectedPages = [...(pose?.layers ?? [])].sort((a, b) => a.order - b.order).map((l) => l.region.page);
    const boundPages = Array.from({ length: count }, (_, i) => (u[`uMap${i}`]?.value as THREE.Texture).name);
    expect(boundPages).toEqual(expectedPages);
    expect(t.renderer.auditBindings()).toEqual({ visibleLayers: count, violations: 0 });
  });

  it('falls back to LAYERED quads for a character whose page FAILED (placeholder stays visible)', async () => {
    const { index } = await compiledAssets();
    const t = setup(index, {}, { mode: 'SHADER', failPage: 'page-hat_01-0' });
    const hero = character('hero', 0); // wears hat_01: its page 404s
    const npc = character('npc', 0.6, companionAppearance()); // hat_03: fine
    await t.frame([hero, npc], 8);
    const m = t.renderer.getMetrics();
    expect(m.failedLayers).toBe(1);
    expect(m.compositedCharacters).toBe(1); // only the companion
    const group = t.renderer.root.children.find((c) => c.name === 'character:hero') as THREE.Group;
    expect(group.children.find((c) => c.name === 'composite:hero')?.visible ?? false).toBe(false);
    // Hero drawn with per-layer quads, one of them the missing-page checker.
    const heroQuads = group.children.filter((c) => c.visible) as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[];
    expect(heroQuads.length).toBeGreaterThan(1);
    expect(heroQuads.filter((q) => (q.material.uniforms.uOpacity?.value as number) < 1)).toHaveLength(1); // placeholder: opacity 0.75
    expect(t.renderer.auditBindings().violations).toBe(0);
  });

  it('defence in depth: a composite holding a stale handle is hidden, then rebuilt', async () => {
    const { index } = await compiledAssets();
    const t = setup(index, {}, { mode: 'SHADER' });
    const hero = character('hero', 0);
    await t.frame([hero], 6);
    const internals = t.registry as unknown as { entries: Map<string, unknown>; evict(entry: unknown): void; revision: number };
    const revision = internals.revision;
    internals.evict(internals.entries.get('page-hat_01-0'));
    internals.revision = revision; // simulated registry bug: no revision bump
    await t.frame([hero]);
    expect(t.renderer.getMetrics().staleBindings).toBe(1);
    expect(t.renderer.getMetrics().compositedCharacters).toBe(0); // hidden rather than drawn with a recycled texture
    expect(t.renderer.auditBindings().violations).toBe(0);
    await t.frame([hero], 2);
    // Rebuilt from fresh handles: the evicted hat now counts as pending, every other layer is composited again.
    expect(t.renderer.getMetrics().compositedCharacters).toBe(1);
    expect(t.renderer.getMetrics().pendingLayers).toBe(1);
    expect(t.renderer.getMetrics().staleBindings).toBe(0);
    expect(t.renderer.auditBindings().violations).toBe(0);
  });
});

describe('projected-size LOD (Milestone 4)', () => {
  /** HIGH above 300 px, otherwise TINY at 2 Hz: makes the rate difference obvious at 50 ms test frames. */
  const POLICY: LodPolicy = { levels: [{ name: 'HIGH', minHeightPx: 300, animationHz: null }, { name: 'TINY', minHeightPx: 0, animationHz: 2 }], hysteresis: 0.1 };
  const far = (id: string, x: number): CharacterInstance => ({ ...character(id, x), position: { x, y: 0, z: -10 } });

  it('small characters animate at the lower visual rate, frames stay in clip order; the near hero is untouched', async () => {
    const { index } = await compiledAssets();
    const t = setup(index, {}, { lod: { policy: POLICY } });
    const hero = character('hero', 0);
    const npc = far('npc', 0.5);
    await t.frame([hero, npc], 6);
    expect(t.renderer.debugInfo('hero')?.lodLevel).toBe(0);
    expect(t.renderer.debugInfo('npc')?.lodLevel).toBe(1);
    const changes = { hero: 0, npc: 0 };
    const last = { hero: -1, npc: -1 };
    for (let i = 0; i < 60; i++) {
      await t.frame([hero, npc]);
      for (const id of ['hero', 'npc'] as const) {
        const f = t.renderer.debugInfo(id)?.pose?.frameIndex ?? -1;
        if (f !== last[id]) {
          // walk has 8 frames of 100 ms: 2 Hz shows every 5th frame; never backwards (mod 8)
          if (last[id] >= 0) expect((f - last[id] + 8) % 8, id).toBeLessThanOrEqual(id === 'hero' ? 1 : 5);
          changes[id]++;
          last[id] = f;
        }
      }
    }
    expect(changes.hero).toBeGreaterThanOrEqual(25); // 3 s of a 10 fps walk cycle
    expect(changes.npc).toBeGreaterThanOrEqual(5);
    expect(changes.npc).toBeLessThanOrEqual(7); // 2 Hz over 3 s
    const m = t.renderer.getMetrics();
    expect(m.lodEnabled).toBe(true);
    expect(m.lodLevels).toEqual([1, 1, 0, 0]);
    expect(t.renderer.auditBindings().violations).toBe(0);
  });

  it('LOD off (default): no levels, every frame sampled', async () => {
    const { index } = await compiledAssets();
    const t = setup(index);
    await t.frame([far('npc', 0)], 3);
    expect(t.renderer.debugInfo('npc')?.lodLevel).toBe(-1);
    expect(t.renderer.getMetrics().lodLevels).toEqual([0, 0, 0, 0]);
  });

  it('the animation budget defers animation-only updates (bounded) but never appearance changes or the HIGH hero', async () => {
    const { index } = await compiledAssets();
    const t = setup(index, {}, { lod: { policy: { ...POLICY, levels: [POLICY.levels[0] as LodPolicy['levels'][number], { name: 'TINY', minHeightPx: 0, animationHz: null }] }, animationBudget: 2 } });
    const hero = character('hero', 0);
    const npcs = Array.from({ length: 12 }, (_, i) => far(`npc-${i}`, -3 + i * 0.5));
    await t.frame([hero, ...npcs], 6);
    const shown = new Map<string, number>();
    const stale = new Map<string, number>();
    let deferred = 0;
    let heroChanges = 0;
    for (let i = 0; i < 40; i++) {
      const heroBefore = t.renderer.debugInfo('hero')?.pose?.frameIndex;
      await t.frame([hero, ...npcs]);
      if (t.renderer.debugInfo('hero')?.pose?.frameIndex !== heroBefore) heroChanges++;
      deferred += t.renderer.getMetrics().animationDeferred;
      for (const n of npcs) {
        const f = t.renderer.debugInfo(n.entityId)?.pose?.frameIndex ?? -1;
        stale.set(n.entityId, f === shown.get(n.entityId) ? (stale.get(n.entityId) ?? 0) + 1 : 0);
        shown.set(n.entityId, f);
        // 100 ms frames at 50 ms steps change every 2nd step; with up to 3 deferrals a frame is held <= 2 + 3 steps
        expect(stale.get(n.entityId), n.entityId).toBeLessThanOrEqual(5);
      }
    }
    expect(deferred).toBeGreaterThan(0);
    expect(heroChanges).toBeGreaterThanOrEqual(19);
    // An appearance change goes through immediately even when the budget is spent.
    const target = npcs[11] as CharacterInstance;
    target.appearance = withSlot(target.appearance, 'hat', 'hat_02');
    await t.frame([hero, ...npcs], 3);
    expect(t.renderer.debugInfo(target.entityId)?.pose?.layers.some((l) => l.itemId === 'hat_02')).toBe(true);
    expect(t.renderer.auditBindings().violations).toBe(0);
  });

  it('the default policy uses the projected canvas height (perspective camera, 720 px viewport)', async () => {
    const { index } = await compiledAssets();
    const t = setup(index, {}, { lod: { policy: DEFAULT_LOD_POLICY } });
    await t.frame([character('near', 0), far('far', 0)], 2);
    const near = t.renderer.projectedHeightPx({ x: 0, y: 0, z: 0 });
    const farPx = t.renderer.projectedHeightPx({ x: 0, y: 0, z: -10 });
    // 2 world units at ~6.2 / ~16.3 units distance, fov 35°, 720 px: ~370 px and ~140 px
    expect(near).toBeGreaterThan(330);
    expect(near).toBeLessThan(410);
    expect(farPx).toBeGreaterThan(120);
    expect(farPx).toBeLessThan(160);
    expect(t.renderer.debugInfo('near')?.lodLevel).toBe(0);
    expect(t.renderer.debugInfo('far')?.lodLevel).toBe(1);
  });
});