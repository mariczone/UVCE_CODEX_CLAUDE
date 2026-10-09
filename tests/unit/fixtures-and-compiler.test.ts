import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createImage, cropImage, opaqueBounds, rectsOverlapWithGap } from './image-helpers.ts';
import { BuildError, buildAssets, imageContentHash, packShelves } from '../../tools/uvce/compiler.ts';
import { generateFixtures } from '../../tools/uvce/generate-fixtures.ts';
import { decodePng, encodePng } from '../../tools/uvce/png.ts';
import { type SourceManifest, sourcePartFrames } from '../../tools/uvce/source-schema.ts';
import { compiledAssets, fixtures } from './helpers.ts';

const temp: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'uvce-unit-'));
  temp.push(d);
  return d;
}
afterAll(async () => {
  for (const d of temp) await rm(d, { recursive: true, force: true });
});

async function sourceManifest(dir = fixtures().sourceDir): Promise<SourceManifest> {
  return JSON.parse(await readFile(join(dir, 'source-manifest.json'), 'utf8')) as SourceManifest;
}

describe('deterministic seeded fixture generator', () => {
  it('produces byte-identical output for the same seed and different art for another seed', async () => {
    const again = await tempDir();
    await generateFixtures({ outDir: again, seed: fixtures().seed });
    const files = (await readdir(fixtures().sourceDir, { recursive: true })).filter((f) => f.endsWith('.png') || f.endsWith('.json')).sort();
    expect(files.length).toBeGreaterThan(300);
    for (const f of files) expect(Buffer.compare(await readFile(join(fixtures().sourceDir, f)), await readFile(join(again, f))), f).toBe(0);
    const other = await tempDir();
    await generateFixtures({ outDir: other, seed: 7 });
    const m = await sourceManifest(other);
    expect(m.generator?.seed).toBe(7);
    // Seeded details (studs, star, strands) differ; unseeded parts (body) stay identical.
    const differs = async (rel: string) => Buffer.compare(await readFile(join(fixtures().sourceDir, rel)), await readFile(join(other, rel))) !== 0;
    expect(await differs('armor_02/armor/static/S.png')).toBe(true);
    expect(await differs('body_base/body/walk/E/003.png')).toBe(false);
  });

  it('writes 256x256 true-RGBA frames with transparent borders and declares synthetic status', async () => {
    const m = await sourceManifest();
    expect(m.generator?.artStatus).toBe('synthetic-placeholder-not-for-production');
    let checked = 0;
    for (const item of m.items) {
      for (const part of item.parts) {
        for (const { frame } of sourcePartFrames(part)) {
          const png = decodePng(await readFile(join(fixtures().sourceDir, frame.file)));
          expect(png.hasAlpha && png.colorType === 6 && png.depth === 8).toBe(true);
          expect([png.image.width, png.image.height]).toEqual([256, 256]);
          const b = opaqueBounds(png.image);
          expect(b && b.x > 0 && b.y > 0 && b.x + b.w < 256 && b.y + b.h < 256).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBe(330);
  });

  it('provides 3 hats, 3 armors, 3 weapons, 2 hairs over 8 directions and idle+walk body clips', async () => {
    const m = await sourceManifest();
    const bySlot = (s: string) => m.items.filter((i) => i.slot === s).map((i) => i.id);
    expect(bySlot('hat')).toEqual(['hat_01', 'hat_02', 'hat_03']);
    expect(bySlot('armor')).toEqual(['armor_01', 'armor_02', 'armor_03']);
    expect(bySlot('weapon')).toEqual(['weapon_01', 'weapon_02', 'weapon_03']);
    expect(bySlot('hair')).toEqual(['hair_01', 'hair_02']);
    const body = m.items.find((i) => i.id === 'body_base')?.parts.find((p) => p.layer === 'body');
    expect(Object.keys(body?.clips ?? {})).toEqual(['idle', 'walk']);
    for (const clip of ['idle', 'walk']) expect(Object.keys(body?.clips?.[clip] ?? {})).toHaveLength(8);
    // Equipment is static per direction (never per animation frame).
    for (const id of ['hat_01', 'armor_02', 'weapon_03']) {
      const part = m.items.find((i) => i.id === id)?.parts[0];
      expect(part?.clips).toBeUndefined();
      expect(Object.keys(part?.static ?? {})).toHaveLength(8);
    }
  });
});

describe('asset compiler', () => {
  it('dedupes identical frames, reports stats and keeps every region inside its page with a gutter', async () => {
    const { index } = await compiledAssets();
    const m = index.manifest;
    expect(m.stats.sourceFrames).toBe(330);
    expect(m.stats.uniqueImages).toBeLessThan(m.stats.sourceFrames);
    expect(m.stats.dedupedFrames).toBe(m.stats.sourceFrames - m.stats.uniqueImages);
    const byPage = new Map<string, { x: number; y: number; w: number; h: number }[]>();
    for (const r of Object.values(m.images)) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r]);
    for (const [pageId, regions] of byPage) {
      const page = index.pages.get(pageId);
      if (!page) throw new Error(pageId);
      for (const r of regions) {
        expect(r.x >= 2 && r.y >= 2 && r.x + r.w <= page.width - 2 && r.y + r.h <= page.height - 2).toBe(true);
      }
      for (let i = 0; i < regions.length; i++)
        for (let j = i + 1; j < regions.length; j++) expect(rectsOverlapWithGap(regions[i] as never, regions[j] as never, 2)).toBe(false);
    }
  });

  it('round-trips every source frame exactly: page region + trim reconstructs the source PNG', async () => {
    const { index, page } = await compiledAssets();
    const src = await sourceManifest();
    for (const item of src.items) {
      const compiled = index.items.get(item.id);
      for (const [pi, part] of item.parts.entries()) {
        const cpart = compiled?.parts[pi];
        for (const { frame, clipId, direction, index: fi } of sourcePartFrames(part)) {
          const cf = clipId ? cpart?.clips?.[clipId]?.[direction]?.[fi] : cpart?.static?.[direction];
          if (!cf) throw new Error(`missing compiled frame for ${frame.file}`);
          const region = index.manifest.images[cf.image];
          const pageImg = region && page(region.page);
          if (!region || !pageImg) throw new Error('missing region/page');
          const restored = createImage(256, 256);
          const pixels = cropImage(pageImg, region);
          for (let y = 0; y < pixels.height; y++) restored.data.set(pixels.data.subarray(y * pixels.width * 4, (y + 1) * pixels.width * 4), ((cf.trim.y + y) * 256 + cf.trim.x) * 4);
          const original = decodePng(await readFile(join(fixtures().sourceDir, frame.file))).image;
          expect(Buffer.compare(Buffer.from(restored.data), Buffer.from(original.data)), frame.file).toBe(0);
        }
      }
    }
  });

  it('is deterministic: same input => identical manifest and page bytes', async () => {
    const out = await tempDir();
    const second = await buildAssets({ sourceDir: fixtures().sourceDir, outDir: out });
    const first = await readFile(join(fixtures().compiledDir, 'manifest.json'), 'utf8');
    expect(JSON.stringify(second.manifest, null, 2) + '\n').toBe(first);
    for (const p of second.manifest.pages) expect(Buffer.compare(await readFile(join(out, p.file)), await readFile(join(fixtures().compiledDir, p.file)))).toBe(0);
  });

  it('content hashes depend on pixels, not on PNG encoding or atlas placement', () => {
    const a = createImage(4, 4);
    a.data[3] = 255;
    const b = decodePng(encodePng(a)).image;
    expect(imageContentHash(b)).toBe(imageContentHash(a));
    b.data[3] = 254;
    expect(imageContentHash(b)).not.toBe(imageContentHash(a));
  });

  it('packs deterministically without overlaps and splits pages when full', () => {
    const imgs = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, w: 30 + (i % 7) * 9, h: 20 + (i % 5) * 13 }));
    const a = packShelves(imgs, 256, 2);
    const b = packShelves([...imgs].reverse(), 256, 2);
    expect(a).toEqual(b);
    expect(a.pages.length).toBeGreaterThan(1);
    for (let i = 0; i < a.placements.length; i++)
      for (let j = i + 1; j < a.placements.length; j++) {
        const p = a.placements[i];
        const q = a.placements[j];
        if (!p || !q || p.page !== q.page) continue;
        const ip = imgs.find((x) => x.key === p.key);
        const iq = imgs.find((x) => x.key === q.key);
        if (!ip || !iq) throw new Error('lost image');
        expect(rectsOverlapWithGap({ x: p.x, y: p.y, w: ip.w, h: ip.h }, { x: q.x, y: q.y, w: iq.w, h: iq.h }, 2)).toBe(false);
      }
    expect(() => packShelves([{ key: 'huge', w: 300, h: 10 }], 256, 2)).toThrow(RangeError);
    // Non-power-of-two limits are respected for both page width and (rounded) height.
    for (const limit of [298, 300, 1000]) {
      const packed = packShelves(imgs, limit, 2);
      expect(packed.pages.every((pg) => pg.width <= limit && pg.height <= limit)).toBe(true);
    }
  });

  it('rejects invalid source art with specific errors and writes no partial output', async () => {
    const dir = await tempDir();
    const srcDir = join(dir, 'src');
    await generateFixtures({ outDir: srcDir, seed: 1 });
    const rgb = (w: number, h: number): Buffer => {
      const img = createImage(w, h);
      img.data.fill(255);
      return encodePng(img);
    };
    const blank = encodePng(createImage(256, 256));
    await writeFile(join(srcDir, 'hat_01/hat/static/S.png'), rgb(256, 256)); // opaque matte
    await writeFile(join(srcDir, 'hat_02/hat/static/S.png'), blank); // blank layer
    await writeFile(join(srcDir, 'hat_03/hat/static/S.png'), encodePng(createImage(128, 128))); // wrong size
    const outDir = join(dir, 'out');
    await mkdir(outDir, { recursive: true });
    const err = await buildAssets({ sourceDir: srcDir, outDir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildError);
    const codes = (err as BuildError).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['png.matte', 'png.blank', 'png.size']));
    await expect(readdir(outDir)).rejects.toThrow();
  });
});
