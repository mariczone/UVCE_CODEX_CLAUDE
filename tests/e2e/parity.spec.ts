/**
 * GPU (WebGL2 LAYERED renderer) vs CPU reference compositor, pixel by pixel, on a scene with two overlapping
 * characters, an opaque 3D box between them in depth and a wall behind. 1 canvas px == 1 sprite px.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { type RgbaImage, diffImages } from '../../src/uvce/compositor/rgba.ts';
import { PARITY } from '../../src/app/stage.ts';
import { loadCompiledAssets } from '../../tools/uvce/compiled-loader.ts';
import { decodePng, encodePng } from '../../tools/uvce/png.ts';
import { buildParityExpected } from '../support/parity-expected.ts';
import { openApp } from './helpers.ts';

const TOLERANCE = 3; // 8-bit units per channel: premultiply-on-upload + blend rounding (observed max 2 on SwiftShader)
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
    expect(diffImages(noHat, expected, TOLERANCE).mismatched).toBeGreaterThan(500);
    // 2) The box really occludes the back character: an expectation that ignores depth (box drawn first)
    //    differs from the correct one, and the GPU output matches only the correct one.
    const actual = await capture(page, 'scene=parity&test=1&dir=SE');
    const noDepth = buildParityExpected(assets, { ...opts, boxBehindEverything: true });
    const occluded = diffImages(noDepth, expected, TOLERANCE).mismatched;
    expect(occluded).toBeGreaterThan(800);
    expect(diffImages(actual, noDepth, TOLERANCE).mismatched).toBeGreaterThan(occluded * 0.95);
    expect(diffImages(actual, expected, TOLERANCE).mismatched).toBe(0);
    expect(PARITY.characters).toHaveLength(2);
  });
});
