import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { type PageFetcher, type PageUploader, SourceAssetRegistry } from '../../src/uvce/assets/source-registry.ts';
import { companionAppearance, heroAppearance } from '../../src/uvce/bench/crowd.ts';
import type { CharacterInstance } from '../../src/uvce/render/contracts.ts';
import { RenderPlanner } from '../../src/uvce/render/planner.ts';
import { type FrameCacheBackend, FrameCacheAllocator } from '../../src/uvce/render/webgl/frame-cache.ts';
import { LayeredCharacterRenderer } from '../../src/uvce/render/webgl/layered-renderer.ts';
import { compiledAssets } from './helpers.ts';

/** Feeds `frames` frames: each frame, every group requests `perFrame(group, frame)` frame keys. */
function drive(p: RenderPlanner, from: number, frames: number, perFrame: (frame: number) => [string, string][]): void {
  for (let f = from; f < from + frames; f++) {
    p.beginFrame(f);
    for (const [group, key] of perFrame(f)) p.observe(group, key);
    p.endFrame();
  }
}

describe('render planner', () => {
  it('promotes a group whose frames repeat (formation), keeps a group of one-off frames on SHADER', () => {
    const p = new RenderPlanner({ capacityCells: 100 });
    drive(p, 1, 60, (f) => [
      // 10 characters of look A all on the same frame (synchronised): 1 distinct key per frame-step of 10 frames
      ...Array.from({ length: 10 }, () => ['A', `A|walk|S|${Math.floor(f / 10) % 8}`] as [string, string]),
      // look B: 10 characters, each on its own frame and direction: almost every request is a new frame
      ...Array.from({ length: 10 }, (_, i) => ['B', `B|walk|${i}|${f}`] as [string, string]),
    ]);
    expect(p.isCached('A')).toBe(true);
    expect(p.isCached('B')).toBe(false);
    expect(p.stats()).toMatchObject({ cachedGroups: 1, promotions: 1, demotions: 0 });
  });

  it('demotes on a low measured hit ratio, but only after the minimum residence (hysteresis)', () => {
    const p = new RenderPlanner({ capacityCells: 100, minResidenceFrames: 240 });
    drive(p, 1, 60, () => [['A', 'A|idle|S|0']]); // one frame, seen every frame: potential 0.98 -> promoted at frame 60
    expect(p.isCached('A')).toBe(true);
    // Now every lookup misses (e.g. the cache keeps losing the frame): too early to switch back...
    for (let f = 61; f <= 240; f++) {
      p.beginFrame(f);
      p.observe('A', 'A|idle|S|0');
      p.recordLookup('A', false);
      p.endFrame();
    }
    expect(p.isCached('A')).toBe(true); // 180 frames < 240 frames residence
    for (let f = 241; f <= 360; f++) {
      p.beginFrame(f);
      p.observe('A', 'A|idle|S|0');
      p.recordLookup('A', false);
      p.endFrame();
    }
    expect(p.isCached('A')).toBe(false);
    expect(p.stats().demotions).toBe(1);
    // ...and it cannot be promoted again before another full residence, even though its potential is high.
    drive(p, 361, 120, () => [['A', 'A|idle|S|0']]);
    expect(p.isCached('A')).toBe(false);
  });

  it('respects cache capacity: the biggest repeating groups win the room', () => {
    const p = new RenderPlanner({ capacityCells: 10, capacityShare: 1 }); // room for 10 distinct frames
    drive(p, 1, 60, () => [
      ...Array.from({ length: 24 }, (_, i) => ['big', `big|${i % 12}`] as [string, string]), // 12 frames
      ...Array.from({ length: 16 }, (_, i) => ['mid', `mid|${i % 8}`] as [string, string]), // 8 frames
      ...Array.from({ length: 4 }, (_, i) => ['small', `small|${i % 2}`] as [string, string]), // 2 frames
      ...Array.from({ length: 2 }, () => ['tiny', 'tiny|0'] as [string, string]), // 1 frame
    ]);
    // Largest first: big (12 frames) does not fit in 10; mid (8) does; small (2) fills it to 10; tiny has no room left.
    expect([p.isCached('big'), p.isCached('mid'), p.isCached('small'), p.isCached('tiny')]).toEqual([false, true, true, false]);
    expect(p.stats().capacityUsed).toBe(10);
  });

  it('forgets groups that left the view and resets on demand', () => {
    const p = new RenderPlanner({ capacityCells: 100 });
    drive(p, 1, 60, () => [['A', 'A|0']]);
    expect(p.isCached('A')).toBe(true);
    drive(p, 61, 130, () => []); // A gone for more than a window
    expect(p.stats().groups).toBe(0);
    drive(p, 191, 60, () => [['B', 'B|0']]);
    p.reset();
    expect(p.isCached('B')).toBe(false);
  });
});

describe('AUTO render mode (renderer + planner)', () => {
  function setup() {
    return compiledAssets().then(({ index }) => {
      const fetcher: PageFetcher<string> = { fetch: (page) => Promise.resolve(page.id), release: () => {} };
      const uploader: PageUploader<string, THREE.Texture> = { upload: (page) => Object.assign(new THREE.Texture(), { name: page.id }), dispose: (t) => t.dispose(), gpuBytes: () => 1000 };
      const registry = new SourceAssetRegistry(index, '/assets', fetcher, uploader, { uploadsPerFrame: 100 });
      const allocator = new FrameCacheAllocator({ cellsPerPage: 16, maxPages: 2 });
      const textures: THREE.Texture[] = [];
      let bakes = 0;
      const backend: FrameCacheBackend = {
        allocator,
        bytesPerPage: 4096,
        pageTexture: (page) => (textures[page] ??= new THREE.Texture()),
        bake: (jobs) => {
          bakes += jobs.length;
        },
        uvRect: (_c, _r, out) => out.set(0, 1, 1, 0),
        onContextLost: () => allocator.clear(),
        onContextRestored: () => {},
        dispose: () => {},
      };
      const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 120);
      camera.position.set(0, 3, 6);
      camera.lookAt(0, 0.8, 0);
      const renderer = new LayeredCharacterRenderer({ index, registry, scene: new THREE.Scene(), camera, shadows: false, mode: 'AUTO', frameCache: backend });
      let frame = 0;
      return {
        renderer,
        bakes: () => bakes,
        async frames(characters: CharacterInstance[], n: number, timeMs: (f: number) => number) {
          for (let i = 0; i < n; i++) {
            registry.beginFrame(++frame);
            renderer.prepareFrame(characters, timeMs(frame));
            await new Promise((r) => setTimeout(r, 0));
          }
        },
      };
    });
  }
  const at = (id: string, x: number, appearance = heroAppearance(), clipId = 'idle', phaseOffsetMs = 0): CharacterInstance => ({
    entityId: id,
    position: { x, y: 0, z: 0 },
    facingYaw: 0,
    appearance,
    animation: { clipId, clipStartMs: 0, speed: 1, phaseOffsetMs },
    visible: true,
  });

  it('starts on SHADER, moves a repeating look to the cache after a window, keeps the rest on SHADER', async () => {
    const t = await setup();
    // Look A: 6 idle characters in step (frames shared). Look B: 1 walker (a new frame every few frames).
    const crowd = [...Array.from({ length: 6 }, (_, i) => at(`a${i}`, -1 + i * 0.4)), at('b0', 0.3, companionAppearance(), 'walk')];
    await t.frames(crowd, 5, (f) => f * 16);
    let m = t.renderer.getMetrics();
    expect(m.mode).toBe('AUTO');
    expect(m.compositedCharacters).toBe(7); // everyone on SHADER before the first decision
    expect(t.bakes()).toBe(0);
    await t.frames(crowd, 70, (f) => f * 16);
    m = t.renderer.getMetrics();
    expect(m.plannerCachedGroups).toBe(1);
    expect(m.cachedCharacters).toBe(6);
    expect(m.compositedCharacters).toBe(1);
    expect(t.renderer.auditBindings().violations).toBe(0);
  });

  it('context loss puts every group back on SHADER', async () => {
    const t = await setup();
    const crowd = Array.from({ length: 6 }, (_, i) => at(`a${i}`, -1 + i * 0.4));
    await t.frames(crowd, 75, (f) => f * 16);
    expect(t.renderer.getMetrics().cachedCharacters).toBe(6);
    t.renderer.onContextLost();
    t.renderer.onContextRestored();
    await t.frames(crowd, 2, (f) => f * 16);
    expect(t.renderer.getMetrics().plannerCachedGroups).toBe(0);
    expect(t.renderer.getMetrics().compositedCharacters).toBe(6);
  });
});
