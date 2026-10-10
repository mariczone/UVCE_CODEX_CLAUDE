import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createImage, cropImage, opaqueBounds, rectsOverlapWithGap } from './image-helpers.ts';
import { BuildError, buildAssets, imageContentHash, packShelves } from '../../tools/uvce/compiler.ts';
import { generateFixtures } from '../../tools/uvce/generate-fixtures.ts';
import { decodePng, encodePng } from '../../tools/uvce/png.ts';
import { type SourceManifest, parseSourceManifest, sourcePartFrames } from '../../tools/uvce/source-schema.ts';
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
          const png = decodePng(await readFile(join(fixtures().sourceDir, frame.file as string)));
          expect(png.hasAlpha && png.colorType === 6 && png.depth === 8).toBe(true);
          expect([png.image.width, png.image.height]).toEqual([256, 256]);
          const b = opaqueBounds(png.image);
          expect(b && b.x > 0 && b.y > 0 && b.x + b.w < 256 && b.y + b.h < 256).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBe(316); // 330 drawn before 4 companion items became mirrored (W/SW/NW derived)
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
    expect(m.stats.sourceFrames).toBe(316);
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
          const original = decodePng(await readFile(join(fixtures().sourceDir, frame.file as string))).image;
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

  it('groups co-used items into shared pages and lists every item on its pages (compiler v2)', async () => {
    const { index } = await compiledAssets();
    const m = index.manifest;
    const core = m.pages.filter((pg) => pg.group === 'core');
    expect(core).toHaveLength(1);
    expect(core[0]?.items).toEqual(['body_base', 'head_base']);
    expect(index.items.get('body_base')?.pages).toEqual(['page-core-0']);
    expect(index.items.get('head_base')?.atlasGroup).toBe('core');
    expect(m.pages).toHaveLength(12);
    expect(m.stats.pageBytesWithMips).toBeGreaterThan(m.stats.pageBytesRGBA8);
    expect(m.compilerVersion).toBe('uvce-compiler/0.2.0');
  });

  it('mip-safe layout: GL box mips never mix two images at levels 1..L and bilinear taps stay in-image', async () => {
    const { index } = await compiledAssets();
    for (const page of index.manifest.pages) {
      expect(page.mipLevels).toBe(3);
      const regions = Object.values(index.manifest.images).filter((r) => r.page === page.id);
      let w = page.width;
      let h = page.height;
      // 0 = transparent gutter, k > 0 = image k, -1 = a texel mixing two images (forbidden).
      let owner = new Int32Array(w * h);
      regions.forEach((r, i) => {
        for (let y = r.y; y < r.y + r.h; y++) owner.fill(i + 1, y * w + r.x, y * w + r.x + r.w);
      });
      for (let level = 1; level <= page.mipLevels; level++) {
        const nw = Math.max(1, w >> 1);
        const nh = Math.max(1, h >> 1);
        const next = new Int32Array(nw * nh);
        for (let y = 0; y < nh; y++) {
          for (let x = 0; x < nw; x++) {
            let o = 0;
            for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
              const sx = Math.min(w - 1, 2 * x + dx);
              const sy = Math.min(h - 1, 2 * y + dy);
              const c = owner[sy * w + sx] as number;
              if (c === 0) continue;
              o = o === 0 || o === c ? c : -1;
            }
            next[y * nw + x] = o;
          }
        }
        owner = next;
        w = nw;
        h = nh;
        let mixed = 0;
        let reach = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const o = owner[y * w + x] as number;
            if (o < 0) mixed++;
            if (o <= 0) continue;
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const n = owner[ny * w + nx] as number;
                if (n !== 0 && n !== o) reach++;
              }
          }
        }
        expect({ page: page.id, level, mixed, reach }).toEqual({ page: page.id, level, mixed: 0, reach: 0 });
      }
    }
  });

  it('stores an image used by items of different atlas groups once (global dedupe)', async () => {
    const dir = await tempDir();
    const src = join(dir, 'src');
    await cp(fixtures().sourceDir, src, { recursive: true });
    const manifest = await sourceManifest(src);
    const hat = manifest.items.find((i) => i.id === 'hat_01');
    if (!hat) throw new Error('hat_01 missing');
    manifest.items.push({ ...hat, id: 'hat_01_recolor_pending', atlasGroup: 'zz_shared_test', displayName: 'Same pixels, other group' });
    await writeFile(join(src, 'source-manifest.json'), JSON.stringify(manifest));
    const { manifest: out, report } = await buildAssets({ sourceDir: src, outDir: join(dir, 'out') });
    const original = out.items.find((i) => i.id === 'hat_01');
    const copy = out.items.find((i) => i.id === 'hat_01_recolor_pending');
    expect(copy?.pages).toEqual(original?.pages);
    expect(out.pages).toHaveLength(12); // no page for the duplicate group
    expect(out.pages.find((pg) => pg.id === 'page-hat_01-0')?.items).toEqual(['hat_01', 'hat_01_recolor_pending']);
    expect(out.stats.crossGroupSharedImages).toBe(new Set(Object.values(original?.parts[0]?.static ?? {}).map((f) => f.image)).size);
    expect(report.crossGroupShared.every((c) => c.page === 'page-hat_01-0')).toBe(true);
    // Item content hashes ignore grouping/placement: identical content => identical hash except for the id.
    expect(copy?.contentHash).not.toBe(original?.contentHash);
  });

  it('rejects atlas groups that mix filtering or mip settings', async () => {
    const manifest = await sourceManifest();
    const head = manifest.items.find((i) => i.id === 'head_base');
    if (!head) throw new Error('head_base missing');
    head.filter = 'nearest';
    const r = parseSourceManifest(manifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain('item.atlas-group');
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
