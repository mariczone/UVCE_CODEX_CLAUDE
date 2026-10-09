/**
 * CPU reference contact sheet (NOT a browser screenshot): every direction x idle/walk frames, plus the
 * 3 hats / 3 armors / 3 weapons on the same body. Used for art review and docs.
 *   node tools/uvce/contact-sheet.ts [--out docs/screenshots/reference-contact-sheet.png]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { composePose } from '../../src/uvce/compositor/reference-compositor.ts';
import { blitOver, createImage, fillImage } from '../../src/uvce/compositor/rgba.ts';
import { resolveAppearance } from '../../src/uvce/core/appearance-resolver.ts';
import { DIRECTIONS, type Direction8 } from '../../src/uvce/core/directions.ts';
import { resolvePose } from '../../src/uvce/core/pose.ts';
import { APPEARANCE_SCHEMA_V2, type AppearanceDefinition } from '../../src/uvce/schema/appearance.ts';
import { DEFAULT_COMPILED_DIR } from './compiler.ts';
import { loadCompiledAssets } from './compiled-loader.ts';
import { encodePng } from './png.ts';

export const DEFAULT_APPEARANCE: AppearanceDefinition = {
  schemaVersion: APPEARANCE_SCHEMA_V2,
  rigProfileId: 'humanoid_2d_v1',
  slots: {
    body: { itemId: 'body_base' },
    head: { itemId: 'head_base' },
    hair: { itemId: 'hair_01' },
    armor: { itemId: 'armor_01' },
    hat: { itemId: 'hat_01' },
    weapon: { itemId: 'weapon_01' },
  },
};

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? (args[outIdx + 1] as string) : 'docs/screenshots/reference-contact-sheet.png';
const assets = await loadCompiledAssets(DEFAULT_COMPILED_DIR);
const CELL_W = 112;
const CELL_H = 232;
const rows: { appearance: AppearanceDefinition; clip: string; frame: number }[] = [
  { appearance: DEFAULT_APPEARANCE, clip: 'idle', frame: 0 },
  { appearance: DEFAULT_APPEARANCE, clip: 'walk', frame: 2 },
  { appearance: DEFAULT_APPEARANCE, clip: 'walk', frame: 6 },
  { appearance: { ...DEFAULT_APPEARANCE, slots: { ...DEFAULT_APPEARANCE.slots, hair: { itemId: 'hair_02' }, hat: { itemId: 'hat_03' }, armor: { itemId: 'armor_03' }, weapon: { itemId: 'weapon_02' } } }, clip: 'idle', frame: 0 },
  { appearance: { ...DEFAULT_APPEARANCE, slots: { ...DEFAULT_APPEARANCE.slots, hat: { itemId: 'hat_02' }, armor: { itemId: 'armor_02' }, weapon: { itemId: 'weapon_03' } } }, clip: 'idle', frame: 0 },
];
const sheet = createImage(CELL_W * DIRECTIONS.length, CELL_H * rows.length);
fillImage(sheet, 58, 64, 74, 255);
rows.forEach((row, ri) => {
  const resolved = resolveAppearance(assets.index, row.appearance);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.issues));
  DIRECTIONS.forEach((dir: Direction8, di) => {
    const pose = resolvePose(assets.index, resolved.value, { clipId: row.clip, direction: dir, frameIndex: row.frame });
    const cell = composePose(pose, assets.page);
    blitOver(sheet, cell, di * CELL_W - 72, ri * CELL_H - 4);
  });
});
await mkdir(dirname(out), { recursive: true });
await writeFile(out, encodePng(sheet));
console.log(`[contact-sheet] wrote ${out} (${sheet.width}x${sheet.height}); columns: ${DIRECTIONS.join(' ')}`);
