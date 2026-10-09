import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { type PageFetcher, PageFetchError, type PageUploader, type RegistryOptions, SourceAssetRegistry } from '../../src/uvce/assets/source-registry.ts';
import { companionAppearance, heroAppearance } from '../../src/uvce/bench/crowd.ts';
import { withSlot } from '../../src/uvce/core/appearance-resolver.ts';
import type { CharacterInstance } from '../../src/uvce/render/contracts.ts';
import { LayeredCharacterRenderer } from '../../src/uvce/render/webgl/layered-renderer.ts';
import type { ManifestIndex } from '../../src/uvce/schema/compiled-manifest.ts';
import { compiledAssets } from './helpers.ts';

/** Real registry with instant fake network/GPU ports; counts every pin/prefetch call the renderer makes. */
function setup(index: ManifestIndex, options: Partial<RegistryOptions> = {}, extra: { mode?: 'LAYERED' | 'SHADER'; failPage?: string } = {}) {
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
  const renderer = new LayeredCharacterRenderer({ index, registry, scene: new THREE.Scene(), camera, shadows: false, mode: extra.mode });
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
