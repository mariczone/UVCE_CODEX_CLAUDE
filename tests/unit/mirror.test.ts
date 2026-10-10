import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { companionAppearance, heroAppearance } from '../../src/uvce/bench/crowd.ts';
import { composePose } from '../../src/uvce/compositor/reference-compositor.ts';
import type { RgbaImage } from '../../src/uvce/compositor/rgba.ts';
import { resolveAppearance, withSlot } from '../../src/uvce/core/appearance-resolver.ts';
import type { Direction8 } from '../../src/uvce/core/directions.ts';
import type { Issue } from '../../src/uvce/core/issues.ts';
import { MIRROR_SOURCE, mirrorFrame, mirrorPointX, mirrorRect, rigMirrorsDirections } from '../../src/uvce/core/mirror.ts';
import { resolvePose } from '../../src/uvce/core/pose.ts';
import { type CompiledPart, validateCompiledManifestSemantics } from '../../src/uvce/schema/compiled-manifest.ts';
import { loadCompiledAssets } from '../../tools/uvce/compiled-loader.ts';
import { buildAssets, deriveMirroredDirections } from '../../tools/uvce/compiler.ts';
import { fullyMirroredManifest } from '../../tools/uvce/mirror-source.ts';
import type { SourceManifest } from '../../tools/uvce/source-schema.ts';
import { compiledAssets, fixtures, manifestJson } from './helpers.ts';

const PIVOT = { x: 128, y: 228 };
const PAIRS = Object.entries(MIRROR_SOURCE) as [Direction8, Direction8][];

const temp: string[] = [];
afterAll(async () => {
  for (const d of temp) await rm(d, { recursive: true, force: true });
});

/** Pixel x of `img` compared with pixel 2·pivot−1−x of `ref`: 0 when img is the exact mirror of ref. */
function mirrorMismatches(img: RgbaImage, ref: RgbaImage): number {
  let bad = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const a = (y * img.width + x) * 4;
      const b = (y * ref.width + mirrorPointX(x, PIVOT.x)) * 4;
      const ia = img.data[a + 3] as number;
      const ib = ref.data[b + 3] as number;
      if (ia === 0 && ib === 0) continue;
      for (let c = 0; c < 4; c++) if (img.data[a + c] !== ref.data[b + c]) {
        bad++;
        break;
      }
    }
  }
  return bad;
}

describe('mirror math', () => {
  it('maps pixel columns, rects and frames onto their mirror and back (involution)', () => {
    expect(mirrorPointX(0, 128)).toBe(255);
    expect(mirrorPointX(127, 128)).toBe(128);
    const r = { x: 100, y: 10, w: 20, h: 5 };
    expect(mirrorRect(r, 128)).toEqual({ x: 136, y: 10, w: 20, h: 5 }); // columns 100..119 -> 136..155
    expect(mirrorRect(mirrorRect(r, 128), 128)).toEqual(r);
    const f = { image: 'k', trim: r, anchor: { x: 129, y: 104 }, sockets: { neck: { x: 130, y: 100 } } };
    const m = mirrorFrame(f, PIVOT, false);
    expect(m).toEqual({ image: 'k', trim: mirrorRect(r, 128), anchor: { x: 126, y: 104 }, sockets: { neck: { x: 125, y: 100 } }, mirror: true });
    expect(mirrorFrame(m, PIVOT, false)).toEqual(f);
    expect(mirrorFrame(f, PIVOT, true).anchor).toEqual(PIVOT); // root-attached: the pivot is the axis
  });

  it('mirrored placement (trim + socket - anchor) is the mirror of the source placement', () => {
    const f = { image: 'k', trim: { x: 90, y: 40, w: 31, h: 12 }, anchor: { x: 129, y: 104 } };
    const socket = { x: 133, y: 150 };
    const dest = f.trim.x + socket.x - f.anchor.x;
    const m = mirrorFrame(f, PIVOT, false);
    expect(m.trim.x + mirrorPointX(socket.x, 128) - m.anchor.x).toBe(mirrorRect({ ...f.trim, x: dest }, 128).x);
  });

  it('derives only missing directions: an explicitly drawn direction wins', () => {
    const frame = { image: 'e', trim: { x: 120, y: 30, w: 10, h: 10 }, anchor: { x: 129, y: 47 } };
    const drawnW = { image: 'w', trim: { x: 126, y: 30, w: 10, h: 10 }, anchor: { x: 125, y: 47 } };
    const part: CompiledPart = { layer: 'hat', attach: 'head_top', representation: 'FRAME', allowMirror: true, static: { E: frame, W: drawnW, SE: frame } };
    const issues: Issue[] = [];
    deriveMirroredDirections(part, { id: 'r', footPivot: PIVOT, canonicalCanvas: { width: 256, height: 256 }, socketDriverLayer: 'body' } as never, '/p', issues);
    expect(part.static?.W).toBe(drawnW);
    expect(part.static?.SW).toEqual(mirrorFrame(frame, PIVOT, false));
    expect(part.static?.NW).toBeUndefined(); // no NE source
    expect(issues).toEqual([]);
  });

  it('the semantic validator rejects mirrored frames in parts without allowMirror', async () => {
    const m = await manifestJson();
    const hat = m.items.find((i) => i.id === 'hat_01')?.parts[0];
    if (!hat?.static?.W) throw new Error('hat_01 W missing');
    hat.static.W.mirror = true;
    expect(validateCompiledManifestSemantics(m).map((i) => i.code)).toContain('frame.mirror');
  });
});

describe('mirrored fixture items (hair_02, hat_03, armor_03, weapon_02)', () => {
  it('reuse the source image of E/SE/NE in W/SW/NW (no extra texture memory)', async () => {
    const { index } = await compiledAssets();
    for (const id of ['hair_02', 'hat_03', 'armor_03', 'weapon_02']) {
      const item = index.items.get(id);
      if (!item) throw new Error(`${id} missing`);
      for (const part of item.parts) {
        expect(part.allowMirror, id).toBe(true);
        for (const [target, source] of PAIRS) {
          const t = part.static?.[target];
          const s = part.static?.[source];
          expect(t?.image, `${id}/${part.layer}/${target}`).toBe(s?.image);
          if (t) expect(t.mirror).toBe(true);
        }
      }
    }
    const hat = index.items.get('hat_01')?.parts[0];
    expect(hat?.allowMirror).toBe(false);
    expect(hat?.static?.W?.mirror).toBeUndefined();
  });

    it('a mirrored layer samples its source image flipped: column i of W = column w-1-i of E', async () => {
    const { index, page } = await compiledAssets();
    const r = resolveAppearance(index, withSlot(withSlot(heroAppearance(), 'hat', 'hat_03'), 'armor', 'armor_03'));
    if (!r.ok) throw new Error('resolve failed');
    for (const layerName of ['hat', 'armor'])
      for (const [target, source] of PAIRS) {
        const draw = (d: Direction8): { img: RgbaImage; dest: { x: number; y: number; w: number; h: number } } => {
          const pose = resolvePose(index, r.value, { clipId: 'idle', direction: d, frameIndex: 0 });
          const layers = pose.layers.filter((l) => l.layer === layerName);
          expect(layers.map((l) => l.mirror), `${layerName}/${d}`).toEqual([d === target]);
          return { img: composePose({ ...pose, layers }, page), dest: (layers[0] as (typeof layers)[number]).dest };
        };
        const t = draw(target);
        const s = draw(source);
        expect(t.dest.w).toBe(s.dest.w);
        let bad = 0;
        for (let y = 0; y < t.dest.h; y++)
          for (let i = 0; i < t.dest.w; i++) {
            const a = ((t.dest.y + y) * 256 + t.dest.x + i) * 4;
            const b = ((s.dest.y + y) * 256 + s.dest.x + s.dest.w - 1 - i) * 4;
            for (let c = 0; c < 4; c++) if (t.img.data[a + c] !== s.img.data[b + c]) {
              bad++;
              break;
            }
          }
        expect(bad, `${layerName} ${target}<-${source}`).toBe(0);
      }
  });
});
describe('fully mirrored character (every part allowMirror, W/SW/NW not drawn)', () => {
  async function build(mirroredRig: boolean): Promise<{ dir: string; warnings: Issue[] }> {
    const dir = await mkdtemp(join(tmpdir(), 'uvce-mirror-'));
    temp.push(dir);
    const src = join(dir, 'src');
    await cp(fixtures().sourceDir, src, { recursive: true });
    const source = JSON.parse(await readFile(join(src, 'source-manifest.json'), 'utf8')) as SourceManifest;
    const manifest = fullyMirroredManifest(source);
    if (!mirroredRig) manifest.rigs = source.rigs;
    await writeFile(join(src, 'source-manifest.json'), JSON.stringify(manifest));
    const { report } = await buildAssets({ sourceDir: src, outDir: join(dir, 'out') });
    return { dir: join(dir, 'out'), warnings: report.warnings };
  }

  it('renders W/SW/NW as the pixel-exact horizontal mirror of E/SE/NE for every look, clip and frame', async () => {
    const { dir, warnings } = await build(true);
    expect(warnings).toEqual([]);
    const { index, page } = await loadCompiledAssets(dir);
    expect(rigMirrorsDirections(index.manifest.rigs[0] as never)).toBe(true);
    // The companion wears the RIG parts (hair_02 back hair, weapon_02 staff): rotation must mirror too.
    const looks = [heroAppearance(), withSlot(withSlot(withSlot(heroAppearance(), 'hat', 'hat_02'), 'armor', 'armor_02'), 'weapon', 'weapon_03'), companionAppearance()];
    let compared = 0;
    for (const look of looks) {
      const r = resolveAppearance(index, look);
      if (!r.ok) throw new Error('resolve failed');
      for (const clipId of ['idle', 'walk'])
        for (const [target, source] of PAIRS)
          for (let f = 0; f < 8; f++) {
            const img = composePose(resolvePose(index, r.value, { clipId, direction: target, frameIndex: f }), page);
            const ref = composePose(resolvePose(index, r.value, { clipId, direction: source, frameIndex: f }), page);
            expect(mirrorMismatches(img, ref), `${clipId}/${target}/${f}`).toBe(0);
            compared++;
          }
    }
    expect(compared).toBe(144);
  });

  it('warns when the socket driver is mirrored but the rig directions are not', async () => {
    const { warnings } = await build(false);
    expect(warnings.map((w) => w.code)).toContain('mirror.rig');
  });
});
