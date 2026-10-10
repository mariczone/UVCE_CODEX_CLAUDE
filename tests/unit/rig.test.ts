import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { companionAppearance } from '../../src/uvce/bench/crowd.ts';
import { blitOver, blitOverRotated, createImage, diffImages } from '../../src/uvce/compositor/rgba.ts';
import { resolveAppearance } from '../../src/uvce/core/appearance-resolver.ts';
import { resolvePose } from '../../src/uvce/core/pose.ts';
import { rotatedBounds, secondaryTransform } from '../../src/uvce/core/secondary-motion.ts';
import { BuildError, buildAssets } from '../../tools/uvce/compiler.ts';
import { type SourceManifest, parseSourceManifest } from '../../tools/uvce/source-schema.ts';
import { compiledAssets, fixtures } from './helpers.ts';

const temp: string[] = [];
afterAll(async () => {
  for (const d of temp) await rm(d, { recursive: true, force: true });
});

const MOTION = { lagFrames: 1, gain: 1, maxOffsetPx: 3, degPerPx: 2, maxDeg: 8 };

describe('secondary motion math', () => {
  it('trails the socket movement over the lag, wraps looping clips, clamps, rounds to whole pixels', () => {
    const xs = [100, 104, 110, 110];
    const at = (f: number) => ({ x: xs[f] as number, y: 50 + f });
    expect(secondaryTransform(MOTION, at, 1, 4, true)).toEqual({ dx: -3, dy: -1, rotation: { deg: 8, pivot: { x: 0, y: 0 } } }); // moved +4: clamp 3 px / 8°
    expect(secondaryTransform(MOTION, at, 3, 4, true)).toEqual({ dx: 0, dy: -1, rotation: null }); // no x movement
    expect(secondaryTransform(MOTION, at, 0, 4, true)).toEqual({ dx: 3, dy: 3, rotation: { deg: -8, pivot: { x: 0, y: 0 } } }); // wraps to frame 3
    expect(secondaryTransform(MOTION, at, 0, 4, false)).toEqual({ dx: 0, dy: 0, rotation: null }); // clamps to frame 0
    expect(Object.is(secondaryTransform({ ...MOTION, gain: 0 }, at, 1, 4, true).dx, 0)).toBe(true); // never -0
  });

  it('rotated bounds contain the rotated rect', () => {
    const b = rotatedBounds({ x: 0, y: 0, w: 10, h: 2 }, { deg: 90, pivot: { x: 0, y: 0 } });
    expect(b).toEqual({ x: -2, y: 0, w: 2, h: 10 });
  });
});

describe('rotated blit (CPU reference for RIG layers)', () => {
  it('0 degrees equals the plain blit; 90 degrees maps pixels exactly; mirror flips the source', () => {
    const src = createImage(4, 2);
    src.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255], 0); // row 0: R G B gray
    src.data.set([1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255, 4, 4, 4, 255], 16);
    const a = createImage(16, 16);
    const b = createImage(16, 16);
    blitOver(a, src, 5, 6, { x: 0, y: 0, w: 4, h: 2 });
    blitOverRotated(b, src, 5, 6, { x: 0, y: 0, w: 4, h: 2 }, false, 0, { x: 5, y: 6 });
    expect(diffImages(a, b, 0).mismatched).toBe(0);
    const c = createImage(16, 16);
    blitOverRotated(c, src, 5, 6, { x: 0, y: 0, w: 4, h: 2 }, false, 90, { x: 5, y: 6 }); // clockwise about the top-left corner
    const px = (img: typeof c, x: number, y: number) => [...img.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 3)];
    expect(px(c, 4, 6)).toEqual([255, 0, 0]); // source (0,0) -> left of the pivot column, same row
    expect(px(c, 4, 9)).toEqual([9, 9, 9]); // source (3,0) -> 3 px down
    expect(px(c, 3, 6)).toEqual([1, 1, 1]); // source row 1 -> one more column left
    const d = createImage(16, 16);
    blitOverRotated(d, src, 5, 6, { x: 0, y: 0, w: 4, h: 2 }, true, 90, { x: 5, y: 6 });
    expect(px(d, 4, 6)).toEqual([9, 9, 9]);
  });
});

describe('RIG fixture parts (hair_02 back hair, weapon_02 staff)', () => {
  it('compile as RIG with motion; the walk tilts the staff and moves the hair, deterministically', async () => {
    const { index } = await compiledAssets();
    expect(index.items.get('hair_02')?.parts.find((p) => p.layer === 'hair_back')?.representation).toBe('RIG');
    expect(index.items.get('weapon_02')?.parts[0]?.motion).toEqual({ lagFrames: 1, gain: 0.5, maxOffsetPx: 2, degPerPx: 2, maxDeg: 8 });
    const r = resolveAppearance(index, companionAppearance());
    if (!r.ok) throw new Error('resolve');
    const degs = new Set<number>();
    const hairY = new Set<number>();
    for (let f = 0; f < 8; f++) {
      const pose = resolvePose(index, r.value, { clipId: 'walk', direction: 'E', frameIndex: f });
      const again = resolvePose(index, r.value, { clipId: 'walk', direction: 'E', frameIndex: f });
      expect(again.layers).toEqual(pose.layers);
      const staff = pose.layers.find((l) => l.layer === 'weapon');
      degs.add(staff?.rotation?.deg ?? 0);
      hairY.add(pose.layers.find((l) => l.layer === 'hair_back')?.dest.y ?? -1);
      // pose bounds include the rotated staff
      if (staff?.rotation) {
        const rb = rotatedBounds(staff.dest, staff.rotation);
        expect(pose.bounds && rb.x >= pose.bounds.x && rb.y >= pose.bounds.y).toBe(true);
      }
    }
    expect(degs.size).toBeGreaterThanOrEqual(3);
    expect(hairY.size).toBeGreaterThanOrEqual(3);
  });
});

describe('HYBRID (experimental): sparse keyframes', () => {
  async function hybridSource(experimental: boolean, dropFirst = false): Promise<{ dir: string; manifest: SourceManifest }> {
    const dir = await mkdtemp(join(tmpdir(), 'uvce-hybrid-'));
    temp.push(dir);
    await cp(fixtures().sourceDir, join(dir, 'src'), { recursive: true });
    const manifest = JSON.parse(await readFile(join(dir, 'src', 'source-manifest.json'), 'utf8')) as SourceManifest;
    if (experimental) manifest.experimental = { hybrid: true };
    const body = manifest.items.find((i) => i.id === 'body_base')?.parts.find((p) => p.layer === 'body');
    if (!body?.clips) throw new Error('body');
    body.representation = 'HYBRID';
    for (const byDir of Object.values(body.clips)) {
      for (const frames of Object.values(byDir)) {
        frames.forEach((f, i) => {
          if (i % 2 === 1 || (dropFirst && i === 0)) delete f.file; // every 2nd frame holds the previous keyframe
        });
      }
    }
    await writeFile(join(dir, 'src', 'source-manifest.json'), JSON.stringify(manifest));
    return { dir, manifest };
  }

  it('is rejected without the experimental flag, and a clip must start with a keyframe', async () => {
    const off = await hybridSource(false);
    const r = parseSourceManifest(off.manifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.message.includes('HYBRID is experimental'))).toBe(true);
    const first = await hybridSource(true, true);
    const r2 = parseSourceManifest(first.manifest);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues.some((i) => i.message.includes('must be a keyframe'))).toBe(true);
    const err = await buildAssets({ sourceDir: join(off.dir, 'src'), outDir: join(off.dir, 'out') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildError);
  });

  it('compiles held frames to the keyframe image with their own sockets: fewer images, same frame count', async () => {
    const { dir } = await hybridSource(true);
    const { manifest, report } = await buildAssets({ sourceDir: join(dir, 'src'), outDir: join(dir, 'out') });
    const { index } = await compiledAssets();
    const body = manifest.items.find((i) => i.id === 'body_base')?.parts.find((p) => p.layer === 'body');
    const original = index.items.get('body_base')?.parts.find((p) => p.layer === 'body');
    const frames = body?.clips?.walk?.SE ?? [];
    expect(body?.representation).toBe('HYBRID');
    expect(frames).toHaveLength(8);
    expect(frames[1]?.image).toBe(frames[0]?.image);
    expect(frames[1]?.sockets).toEqual(original?.clips?.walk?.SE?.[1]?.sockets); // equipment still follows every frame
    expect(frames[2]?.image).not.toBe(frames[0]?.image);
    expect(manifest.stats.sourceFrames).toBeLessThan(index.manifest.stats.sourceFrames);
    expect(report.warnings).toEqual([]);
  });
});
