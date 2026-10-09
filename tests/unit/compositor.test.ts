import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { heroAppearance } from '../../src/uvce/bench/crowd.ts';
import { composePose } from '../../src/uvce/compositor/reference-compositor.ts';
import { blitOver, createImage, diffImages, overPixel } from '../../src/uvce/compositor/rgba.ts';
import { resolveAppearance, withSlot } from '../../src/uvce/core/appearance-resolver.ts';
import { DIRECTIONS } from '../../src/uvce/core/directions.ts';
import { resolvePose } from '../../src/uvce/core/pose.ts';
import { imageContentHash } from '../../tools/uvce/compiler.ts';
import { decodePng, encodePng } from '../../tools/uvce/png.ts';
import { compiledAssets } from './helpers.ts';

const UPDATE = process.env.UVCE_UPDATE_GOLDENS === '1';

describe('straight-alpha over (reference blend math)', () => {
  it('matches the closed-form result for opaque, transparent and partial sources', () => {
    const px = (r: number, g: number, b: number, a: number) => new Uint8Array([r, g, b, a]);
    let d = px(10, 20, 30, 255);
    overPixel(d, 0, 200, 100, 0, 0);
    expect([...d]).toEqual([10, 20, 30, 255]);
    overPixel(d, 0, 200, 100, 0, 255);
    expect([...d]).toEqual([200, 100, 0, 255]);
    d = px(0, 0, 0, 255);
    overPixel(d, 0, 255, 255, 255, 128); // 128/255 white over opaque black
    expect([...d]).toEqual([128, 128, 128, 255]);
    d = px(0, 0, 0, 0);
    overPixel(d, 0, 90, 60, 30, 100); // over transparent: colour preserved (no premultiply darkening)
    expect([...d]).toEqual([90, 60, 30, 100]);
    d = px(255, 0, 0, 128);
    overPixel(d, 0, 0, 0, 255, 128); // semi over semi: A = .502 + .502*.498
    expect(d[3]).toBe(192);
    expect(d[0]).toBe(85);
    expect(d[2]).toBe(170);
  });

  it('is order dependent (layer order matters) and clips at canvas bounds', () => {
    const red = createImage(2, 2);
    red.data.set([255, 0, 0, 128, 255, 0, 0, 128, 255, 0, 0, 128, 255, 0, 0, 128]);
    const blue = createImage(2, 2);
    blue.data.set([0, 0, 255, 128, 0, 0, 255, 128, 0, 0, 255, 128, 0, 0, 255, 128]);
    const a = createImage(2, 2);
    blitOver(a, red, 0, 0);
    blitOver(a, blue, 0, 0);
    const b = createImage(2, 2);
    blitOver(b, blue, 0, 0);
    blitOver(b, red, 0, 0);
    expect(diffImages(a, b, 0).mismatched).toBe(4);
    const c = createImage(2, 2);
    blitOver(c, red, 1, 1); // only one pixel lands inside
    expect(c.data[15]).toBe(128);
    expect(c.data[3]).toBe(0);
  });

  it('diff ignores the colour of fully transparent pixels', () => {
    const a = createImage(1, 1);
    const b = createImage(1, 1);
    b.data.set([99, 99, 99, 0]);
    expect(diffImages(a, b, 0).mismatched).toBe(0);
  });
});

describe('reference composites (golden images)', () => {
  it('match committed goldens for the default look in 8 directions (idle frame 0)', async () => {
    const { index, page } = await compiledAssets();
    const r = resolveAppearance(index, heroAppearance());
    if (!r.ok) throw new Error('resolve failed');
    for (const d of DIRECTIONS) {
      const img = composePose(resolvePose(index, r.value, { clipId: 'idle', direction: d, frameIndex: 0 }), page);
      const file = `tests/golden/default-${d}-idle-0.png`;
      if (UPDATE) await writeFile(file, encodePng(img));
      const golden = decodePng(await readFile(file)).image;
      expect(diffImages(img, golden, 0).mismatched, file).toBe(0);
    }
  });

  it('match the committed hash table for 3 looks x 2 clips x 8 directions x 8 frames', async () => {
    const { index, page } = await compiledAssets();
    const looks = {
      default: heroAppearance(),
      mixed: withSlot(withSlot(withSlot(withSlot(heroAppearance(), 'hair', 'hair_02'), 'hat', 'hat_03'), 'armor', 'armor_03'), 'weapon', 'weapon_02'),
      bare: withSlot(withSlot(withSlot(withSlot(heroAppearance(), 'hair', null), 'hat', null), 'armor', null), 'weapon', null),
    };
    const table: Record<string, string> = {};
    for (const [name, look] of Object.entries(looks)) {
      const r = resolveAppearance(index, look);
      if (!r.ok) throw new Error('resolve failed');
      for (const clip of ['idle', 'walk'])
        for (const d of DIRECTIONS)
          for (let f = 0; f < 8; f++) table[`${name}/${clip}/${d}/${f}`] = imageContentHash(composePose(resolvePose(index, r.value, { clipId: clip, direction: d, frameIndex: f }), page)).slice(0, 16);
    }
    const file = 'tests/golden/reference-hashes.json';
    if (UPDATE) await writeFile(file, `${JSON.stringify(table, null, 1)}\n`);
    expect(table).toEqual(JSON.parse(await readFile(file, 'utf8')));
  });
});
