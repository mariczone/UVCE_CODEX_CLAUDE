/**
 * Generates the images of the artwork specification in art-spec/ (templates + examples) from the real rig and the
 * synthetic fixture set, so the spec always matches what the compiler and runtime use.
 *   pnpm assets && node tools/uvce/make-art-spec.ts
 * Output: art-spec/templates/*.png (guides + overlays per direction), art-spec/examples/raw/** (exact-format layer
 * PNGs) and art-spec/examples/sheets/*.png (explanatory sheets). The example art is SYNTHETIC placeholder art.
 */
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { composePose } from '../../src/uvce/compositor/reference-compositor.ts';
import { type RgbaImage, blitOver, createImage, fillImage } from '../../src/uvce/compositor/rgba.ts';
import { resolveAppearance } from '../../src/uvce/core/appearance-resolver.ts';
import { DIRECTIONS, type Direction8 } from '../../src/uvce/core/directions.ts';
import { resolvePose } from '../../src/uvce/core/pose.ts';
import { DEFAULT_COMPILED_DIR } from './compiler.ts';
import { loadCompiledAssets } from './compiled-loader.ts';
import { APPEARANCE_SCHEMA_V2, type AppearanceDefinition } from '../../src/uvce/schema/appearance.ts';
import { CANVAS, FOOT_PIVOT, SOCKETS } from './fixture-spec.ts';
import { restSockets } from './fixture-pose.ts';
import { DEFAULT_SOURCE_DIR } from './generate-fixtures.ts';
import { encodePng } from './png.ts';
import { Raster, drawDigits, hex } from './raster.ts';

const OUT = 'art-spec';
const SAFE = 8;
const DEFAULT_APPEARANCE: AppearanceDefinition = {
  schemaVersion: APPEARANCE_SCHEMA_V2,
  rigProfileId: 'humanoid_2d_v1',
  slots: { body: { itemId: 'body_base' }, head: { itemId: 'head_base' }, hair: { itemId: 'hair_01' }, armor: { itemId: 'armor_01' }, hat: { itemId: 'hat_01' }, weapon: { itemId: 'weapon_01' } },
};

/** Socket marker colours (documented in art-spec/03-rig-layers-sockets.md). */
export const SOCKET_COLORS: Record<string, string> = {
  head_top: '#e5383b',
  neck: '#f48c06',
  chest: '#ffd60a',
  right_hand: '#2f6fed',
  left_hand: '#00b4d8',
  back: '#c724b1',
  root: '#2dc653',
};

function checker(w: number, h: number): RgbaImage {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = ((x >> 3) + (y >> 3)) % 2 === 0 ? 236 : 214;
      img.data.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return img;
}

function marker(r: Raster, x: number, y: number, color: string): void {
  r.circle(x + 0.5, y + 0.5, 3.2, hex('#ffffff'));
  r.circle(x + 0.5, y + 0.5, 2.2, hex(color));
}

function pivotCross(r: Raster, x: number, y: number): void {
  r.rect(x - 6, y, x + 7, y + 1, hex(SOCKET_COLORS.root as string));
  r.rect(x, y - 6, x + 1, y + 7, hex(SOCKET_COLORS.root as string));
}

/** Guide lines for one direction: grid (opaque guide only), safe area, ground line, pivot and rest sockets. */
function guide(direction: Direction8, opaque: boolean): RgbaImage {
  const img = createImage(CANVAS, CANVAS);
  if (opaque) fillImage(img, 250, 250, 252, 255);
  const r = new Raster(img);
  if (opaque) {
    for (let v = 0; v <= CANVAS; v += 16) {
      const p = hex(v % 64 === 0 ? '#c9ccd6' : '#e6e8ee');
      r.rect(v, 0, v + 1, CANVAS, p);
      r.rect(0, v, CANVAS, v + 1, p);
    }
  }
  const safe = hex('#8a8f9c', opaque ? 255 : 160);
  r.rect(SAFE, SAFE, CANVAS - SAFE, SAFE + 1, safe);
  r.rect(SAFE, CANVAS - SAFE - 1, CANVAS - SAFE, CANVAS - SAFE, safe);
  r.rect(SAFE, SAFE, SAFE + 1, CANVAS - SAFE, safe);
  r.rect(CANVAS - SAFE - 1, SAFE, CANVAS - SAFE, CANVAS - SAFE, safe);
  r.rect(SAFE, FOOT_PIVOT.y, CANVAS - SAFE, FOOT_PIVOT.y + 1, hex('#2dc653', opaque ? 200 : 140)); // ground line
  r.rect(FOOT_PIVOT.x, SAFE, FOOT_PIVOT.x + 1, CANVAS - SAFE, hex('#2dc653', opaque ? 90 : 60)); // centre line
  pivotCross(r, FOOT_PIVOT.x, FOOT_PIVOT.y);
  const sockets = restSockets(direction);
  for (const s of SOCKETS) marker(r, sockets[s].x, sockets[s].y, SOCKET_COLORS[s] as string);
  return img;
}

function upscale(src: RgbaImage, k: number): RgbaImage {
  const out = createImage(src.width * k, src.height * k);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const si = (Math.floor(y / k) * src.width + Math.floor(x / k)) * 4;
      out.data.set(src.data.subarray(si, si + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

async function save(path: string, img: RgbaImage): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encodePng(img));
}

// 1) Templates: one opaque guide and one transparent overlay per direction, plus a 2x sheet of all guides.
const sheet = createImage(CANVAS * DIRECTIONS.length, CANVAS);
for (const [i, d] of DIRECTIONS.entries()) {
  const g = guide(d, true);
  await save(join(OUT, 'templates', `guide-${d}.png`), g);
  await save(join(OUT, 'templates', `overlay-${d}.png`), guide(d, false));
  blitOver(sheet, g, i * CANVAS, 0);
}
await save(join(OUT, 'templates', 'guide-sheet-x2.png'), upscale(sheet, 2));

// 2) Raw example layers: exact files the compiler accepts (256x256 RGBA, straight alpha, sRGB).
const raw: string[] = [
  'body_base/body/idle/S/000.png',
  'body_base/body/idle/SE/000.png',
  'body_base/body/walk/SE/000.png',
  'body_base/body/walk/SE/004.png',
  'body_base/arm_front/idle/SE/000.png',
  'head_base/head/static/S.png',
  'head_base/head/static/SE.png',
  'hair_01/hair_back/static/S.png',
  'hair_01/hair_front/static/S.png',
  'hair_01/hair_back/static/N.png',
  'armor_01/armor/static/S.png',
  'armor_01/armor/static/SE.png',
  'weapon_01/weapon/static/SE.png',
  'weapon_01/weapon/static/W.png',
  ...DIRECTIONS.map((d) => `hat_01/hat/static/${d}.png`),
];
for (const f of raw) {
  const dst = join(OUT, 'examples', 'raw', f);
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(join(DEFAULT_SOURCE_DIR, f), dst);
}

// 3) Sheets from the compiled fixture set via the CPU reference compositor (the same oracle the GPU is tested against).
const assets = await loadCompiledAssets(DEFAULT_COMPILED_DIR);
const resolved = resolveAppearance(assets.index, DEFAULT_APPEARANCE);
if (!resolved.ok) throw new Error(JSON.stringify(resolved.issues));
const look = resolved.value;

function tile(content: RgbaImage, marks: { x: number; y: number; color: string }[] = [], label?: string): RgbaImage {
  const t = checker(CANVAS, CANVAS);
  blitOver(t, content, 0, 0);
  const r = new Raster(t);
  r.rect(SAFE, FOOT_PIVOT.y, CANVAS - SAFE, FOOT_PIVOT.y + 1, hex('#2dc653', 150));
  pivotCross(r, FOOT_PIVOT.x, FOOT_PIVOT.y);
  for (const m of marks) marker(r, m.x, m.y, m.color);
  if (label !== undefined) drawDigits(r, label, 6, 6, 3, hex('#1d2433'));
  return t;
}

function strip(tiles: RgbaImage[]): RgbaImage {
  const out = createImage(CANVAS * tiles.length + 4 * (tiles.length - 1), CANVAS);
  fillImage(out, 255, 255, 255, 255);
  tiles.forEach((t, i) => blitOver(out, t, i * (CANVAS + 4), 0));
  return out;
}

// 3a) The full character in all 8 directions (idle frame 0), N NE E SE S SW W NW.
await save(
  join(OUT, 'examples', 'sheets', 'directions-idle.png'),
  strip(DIRECTIONS.map((d) => tile(composePose(resolvePose(assets.index, look, { clipId: 'idle', direction: d, frameIndex: 0 }), assets.page)))),
);

// 3b) Layer breakdown: each layer alone in painter order (number = order), then the composite.
for (const d of ['SE', 'NW'] as const) {
  const pose = resolvePose(assets.index, look, { clipId: 'idle', direction: d, frameIndex: 0 });
  const layers = [...pose.layers].sort((a, b) => a.order - b.order);
  const tiles = layers.map((l, i) => tile(composePose({ ...pose, layers: [l] }, assets.page), [], String(i + 1)));
  tiles.push(tile(composePose(pose, assets.page)));
  await save(join(OUT, 'examples', 'sheets', `layer-breakdown-${d}.png`), strip(tiles));
}

// 3c) Walk SE: body + front arm per frame, with that frame's sockets (equipment follows these points).
await save(
  join(OUT, 'examples', 'sheets', 'walk-SE-sockets.png'),
  strip(
    Array.from({ length: 8 }, (_, f) => {
      const pose = resolvePose(assets.index, look, { clipId: 'walk', direction: 'SE', frameIndex: f });
      const body = { ...pose, layers: pose.layers.filter((l) => l.layer === 'body' || l.layer === 'arm_front') };
      const marks = SOCKETS.map((s) => ({ x: (pose.sockets[s] as { x: number }).x, y: (pose.sockets[s] as { y: number }).y, color: SOCKET_COLORS[s] as string }));
      return tile(composePose(body, assets.page), marks, String(f));
    }),
  ),
);

// 3d) Anchor example (S): body with its head_top socket | hat alone with its anchor | composite.
{
  const pose = resolvePose(assets.index, look, { clipId: 'idle', direction: 'S', frameIndex: 0 });
  const headTop = pose.sockets.head_top as { x: number; y: number };
  const bodyHead = { ...pose, layers: pose.layers.filter((l) => l.layer === 'body' || l.layer === 'head') };
  const hatSrc = resolvePose(assets.index, look, { clipId: 'idle', direction: 'S', frameIndex: 0 });
  const hat = { ...hatSrc, layers: hatSrc.layers.filter((l) => l.layer === 'hat') };
  const anchor = restSockets('S').head_top;
  await save(
    join(OUT, 'examples', 'sheets', 'anchor-hat-S.png'),
    strip([
      tile(composePose(bodyHead, assets.page), [{ ...headTop, color: SOCKET_COLORS.head_top as string }]),
      tile(composePose(hat, assets.page), [{ ...anchor, color: SOCKET_COLORS.head_top as string }]),
      tile(composePose(pose, assets.page)),
    ]),
  );
}

console.log(`[art-spec] wrote templates (${DIRECTIONS.length * 2 + 1}), raw examples (${raw.length}) and 5 sheets to ${OUT}/`);
