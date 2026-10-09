/**
 * GPU (WebGL2 LAYERED renderer) vs CPU reference compositor, pixel by pixel, on a scene with two overlapping
 * characters, an opaque 3D box between them in depth and a wall behind. 1 canvas px == 1 sprite px.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { type RgbaImage, diffImages } from '../../src/uvce/compositor/rgba.ts';
import { loadCompiledAssets } from '../../tools/uvce/compiled-loader.ts';
import { decodePng, encodePng } from '../../tools/uvce/png.ts';
import { buildParityExpected, parityPaintOrder } from '../support/parity-expected.ts';
import { api, openApp } from './helpers.ts';

const TOLERANCE = 3; // 8-bit units per channel: premultiply-on-upload + blend rounding (observed max 2 on SwiftShader)

/** One evidence line per parity case in the test output (quoted by the milestone reports). */
function logParity(name: string, actual: RgbaImage, expected: RgbaImage, diff: { mismatched: number; maxChannelDelta: number }): void {
  const notExact = diffImages(actual, expected, 0).mismatched;
  console.log(`[parity] ${name}: beyond ±${TOLERANCE} ${diff.mismatched}, max delta ${diff.maxChannelDelta}, not bit-exact ${notExact} of ${actual.width * actual.height} px`);
}
const CASES = [
  { direction: 'SE', clipId: 'idle', timeMs: 0 },
  { direction: 'S', clipId: 'idle', timeMs: 480 },
  { direction: 'E', clipId: 'walk', timeMs: 250 },
  { direction: 'NW', clipId: 'walk', timeMs: 350 },
  { direction: 'W', clipId: 'walk', timeMs: 720 },
  { direction: 'N', clipId: 'idle', timeMs: 900 },
] as const;

async function capture(page: import('@playwright/test').Page, query: string): Promise<RgbaImage> {
  await openApp(page, query);
  return decodePng(await page.locator('#scene').screenshot()).image;
}

// Milestone 1 scene variants: crossing characters, arch occlusion, translucent glass sorted with sprites.
const VARIANT_CASES_SHARED = [
  { variant: 'crossing', timeMs: 400, order: ['hero', 'npc-static'] }, // hero still behind the companion
  { variant: 'crossing', timeMs: 2000, order: ['npc-static', 'hero'] }, // after crossing: hero in front
  { variant: 'arch', timeMs: 0, order: ['hero', 'npc-front'] },
  { variant: 'glass', timeMs: 0, order: ['hero', 'obj:glass', 'npc-front'] },
] as const;

async function saveArtifacts(name: string, images: Record<string, RgbaImage>): Promise<void> {
  await mkdir('test-results/parity', { recursive: true });
  for (const [k, img] of Object.entries(images)) await writeFile(`test-results/parity/${name}-${k}.png`, encodePng(img));
}

test.describe('GPU vs CPU reference parity', () => {
  for (const c of CASES) {
    test(`${c.direction} ${c.clipId} t=${c.timeMs}ms matches the reference compositor`, async ({ page }) => {
      const assets = await loadCompiledAssets('public/uvce-compiled');
      const actual = await capture(page, `scene=parity&test=1&dir=${c.direction}&clip=${c.clipId}&t=${c.timeMs}`);
      const expected = buildParityExpected(assets, { width: actual.width, height: actual.height, direction: c.direction, clipId: c.clipId, timeMs: c.timeMs, pixelsPerUnit: 128 });
      const diff = diffImages(actual, expected, TOLERANCE);
      logParity(`${c.direction} ${c.clipId} t=${c.timeMs}`, actual, expected, diff);
      if (diff.mismatched > 0) await saveArtifacts(`${c.direction}-${c.clipId}-${c.timeMs}`, { actual, expected, heatmap: diff.heatmap });
      expect([actual.width, actual.height]).toEqual([1280, 720]);
      expect(diff.mismatched, `max channel delta ${diff.maxChannelDelta}`).toBe(0);
    });
  }

  test('negative controls: a missing layer or a broken depth test would be detected', async ({ page }) => {
    const assets = await loadCompiledAssets('public/uvce-compiled');
    const opts = { width: 1280, height: 720, direction: 'SE' as const, clipId: 'idle', timeMs: 0, pixelsPerUnit: 128 };
    const expected = buildParityExpected(assets, opts);
    // 1) Hiding the hat layer must produce many mismatches against the full expectation.
    const noHat = await capture(page, 'scene=parity&test=1&dir=SE&hide=hat');
    const hatMissing = diffImages(noHat, expected, TOLERANCE).mismatched;
    expect(hatMissing).toBeGreaterThan(500);
    // 2) The box really occludes the back character: an expectation that ignores depth (box drawn first)
    //    differs from the correct one, and the GPU output matches only the correct one.
    const actual = await capture(page, 'scene=parity&test=1&dir=SE');
    const noDepth = buildParityExpected(assets, { ...opts, drawFirst: ['box'] });
    const occluded = diffImages(noDepth, expected, TOLERANCE).mismatched;
    console.log(`[parity] negative controls: hat hidden ${hatMissing} px differ, depth ignored ${occluded} px differ`);
    expect(occluded).toBeGreaterThan(800);
    expect(diffImages(actual, noDepth, TOLERANCE).mismatched).toBeGreaterThan(occluded * 0.95);
    expect(diffImages(actual, expected, TOLERANCE).mismatched).toBe(0);
  });

  for (const c of VARIANT_CASES_SHARED) {
    test(`variant ${c.variant} t=${c.timeMs}ms: painter order and pixels match the reference`, async ({ page }) => {
      const assets = await loadCompiledAssets('public/uvce-compiled');
      const actual = await capture(page, `scene=parity&variant=${c.variant}&test=1&dir=SE&t=${c.timeMs}`);
      expect(await api(page, (u) => u.paintOrder())).toEqual(c.order);
      const expected = buildParityExpected(assets, { width: actual.width, height: actual.height, variant: c.variant, direction: 'SE', clipId: 'idle', timeMs: c.timeMs, pixelsPerUnit: 128 });
      const diff = diffImages(actual, expected, TOLERANCE);
      logParity(`variant ${c.variant} t=${c.timeMs}`, actual, expected, diff);
      if (diff.mismatched > 0) await saveArtifacts(`${c.variant}-${c.timeMs}`, { actual, expected, heatmap: diff.heatmap });
      expect(diff.mismatched, `max channel delta ${diff.maxChannelDelta}`).toBe(0);
    });
  }

  test('negative controls for the variants: wrong crossing order and unsorted glass are detectable', async ({ page }) => {
    const assets = await loadCompiledAssets('public/uvce-compiled');
    const base = { width: 1280, height: 720, direction: 'SE' as const, clipId: 'idle', pixelsPerUnit: 128 };
    // Crossing: the order really flips between the two sampled times.
    expect(parityPaintOrder('crossing', 400).map((e) => e.id)).toEqual(['wall', 'hero', 'npc-static']);
    expect(parityPaintOrder('crossing', 2000).map((e) => e.id)).toEqual(['wall', 'npc-static', 'hero']);
    const late = await capture(page, 'scene=parity&variant=crossing&test=1&t=2000');
    const stale = buildParityExpected(assets, { ...base, variant: 'crossing', timeMs: 2000, drawFirst: ['hero'] });
    const staleOrder = diffImages(late, stale, TOLERANCE).mismatched;
    expect(staleOrder).toBeGreaterThan(300);
    // Glass: drawing it before all sprites (what three.js does for an unsorted transparent mesh) differs.
    const glass = await capture(page, 'scene=parity&variant=glass&test=1&dir=SE');
    const unsorted = buildParityExpected(assets, { ...base, variant: 'glass', timeMs: 0, drawFirst: ['glass'] });
    const unsortedGlass = diffImages(glass, unsorted, TOLERANCE).mismatched;
    console.log(`[parity] variant negative controls: stale crossing order ${staleOrder} px differ, unsorted glass ${unsortedGlass} px differ`);
    expect(unsortedGlass).toBeGreaterThan(300);
  });
});

// Milestone 3: SHADER (one composited quad per character) and FULL_CACHE (one baked frame per character) must pass
// the same oracle as LAYERED.
for (const MODE of ['SHADER', 'FULL_CACHE'] as const) {
test.describe(`${MODE} mode parity`, () => {
  /** Every visible character must really use the mode (composited / drawn from the cache): a silent fallback would make this suite meaningless. */
  async function expectAllComposited(page: import('@playwright/test').Page): Promise<void> {
    const c = (await api(page, (u) => u.snapshot())).character;
    expect(MODE === 'SHADER' ? c.compositedCharacters : c.cachedCharacters).toBe(c.visibleCharacters);
    expect(c.visibleCharacters).toBeGreaterThan(0);
  }

  for (const c of CASES) {
    test(`${MODE} ${c.direction} ${c.clipId} t=${c.timeMs}ms matches the reference compositor`, async ({ page }) => {
      const assets = await loadCompiledAssets('public/uvce-compiled');
      const actual = await capture(page, `scene=parity&test=1&mode=${MODE}&dir=${c.direction}&clip=${c.clipId}&t=${c.timeMs}`);
      await expectAllComposited(page);
      const expected = buildParityExpected(assets, { width: actual.width, height: actual.height, direction: c.direction, clipId: c.clipId, timeMs: c.timeMs, pixelsPerUnit: 128 });
      const diff = diffImages(actual, expected, TOLERANCE);
      logParity(`${MODE} ${c.direction} ${c.clipId} t=${c.timeMs}`, actual, expected, diff);
      if (diff.mismatched > 0) await saveArtifacts(`${MODE}-${c.direction}-${c.clipId}-${c.timeMs}`, { actual, expected, heatmap: diff.heatmap });
      expect(diff.mismatched, `max channel delta ${diff.maxChannelDelta}`).toBe(0);
    });
  }

  for (const c of VARIANT_CASES_SHARED) {
    test(`${MODE} variant ${c.variant} t=${c.timeMs}ms: painter order and pixels match the reference`, async ({ page }) => {
      const assets = await loadCompiledAssets('public/uvce-compiled');
      const actual = await capture(page, `scene=parity&variant=${c.variant}&test=1&mode=${MODE}&dir=SE&t=${c.timeMs}`);
      await expectAllComposited(page);
      expect(await api(page, (u) => u.paintOrder())).toEqual(c.order);
      const expected = buildParityExpected(assets, { width: actual.width, height: actual.height, variant: c.variant, direction: 'SE', clipId: 'idle', timeMs: c.timeMs, pixelsPerUnit: 128 });
      const diff = diffImages(actual, expected, TOLERANCE);
      logParity(`${MODE} variant ${c.variant} t=${c.timeMs}`, actual, expected, diff);
      if (diff.mismatched > 0) await saveArtifacts(`${MODE}-${c.variant}-${c.timeMs}`, { actual, expected, heatmap: diff.heatmap });
      expect(diff.mismatched, `max channel delta ${diff.maxChannelDelta}`).toBe(0);
    });
  }

  test(`${MODE} negative control and draw-call reduction: a hidden hat is detected; one draw per character`, async ({ page }) => {
    const assets = await loadCompiledAssets('public/uvce-compiled');
    const expected = buildParityExpected(assets, { width: 1280, height: 720, direction: 'SE', clipId: 'idle', timeMs: 0, pixelsPerUnit: 128 });
    const noHat = await capture(page, `scene=parity&test=1&mode=${MODE}&dir=SE&hide=hat`);
    const hatMissing = diffImages(noHat, expected, TOLERANCE).mismatched;
    expect(hatMissing).toBeGreaterThan(500);
    const shaderDraws = (await api(page, (u) => u.snapshot())).drawCalls;
    await capture(page, 'scene=parity&test=1&dir=SE&hide=hat');
    const layeredDraws = (await api(page, (u) => u.snapshot())).drawCalls;
    console.log(`[parity] ${MODE} negative control: hat hidden ${hatMissing} px differ; draw calls LAYERED ${layeredDraws} -> ${MODE} ${shaderDraws}`);
    // Parity scene: 2 characters (+ wall, box): LAYERED draws every layer, SHADER one quad per character.
    expect(shaderDraws).toBeLessThan(layeredDraws);
  });
});
}
