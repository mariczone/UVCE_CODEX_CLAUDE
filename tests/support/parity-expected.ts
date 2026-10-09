/**
 * CPU expectation for the pixel-parity scene (src/app/stage.ts PARITY): clear colour, wall (behind),
 * back character, opaque box (between the characters in depth), front character. Same manifest, same
 * resolver, straight-alpha "over" in 8-bit sRGB: the GPU render must match this within tolerance.
 */
import { composePose } from '../../src/uvce/compositor/reference-compositor.ts';
import { type RgbaImage, createImage, fillImage } from '../../src/uvce/compositor/rgba.ts';
import { heroAppearance } from '../../src/uvce/bench/crowd.ts';
import { resolveAppearance } from '../../src/uvce/core/appearance-resolver.ts';
import { sampleClip } from '../../src/uvce/core/animation.ts';
import type { Direction8 } from '../../src/uvce/core/directions.ts';
import { resolvePose } from '../../src/uvce/core/pose.ts';
import type { AppearanceDefinition } from '../../src/uvce/schema/appearance.ts';
import { PARITY } from '../../src/app/stage.ts';
import type { LoadedCompiledAssets } from '../../tools/uvce/compiled-loader.ts';

export function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export function companionAppearance(): AppearanceDefinition {
  const base = heroAppearance();
  return { ...base, slots: { ...base.slots, hair: { itemId: 'hair_02' }, hat: { itemId: 'hat_03' }, armor: { itemId: 'armor_03' }, weapon: { itemId: 'weapon_02' } } };
}

export interface ParityOptions {
  width: number;
  height: number;
  direction: Direction8;
  clipId: string;
  timeMs: number;
  pixelsPerUnit: number;
  /** Negative control: draw the box before both characters (what a broken depth test would show). */
  boxBehindEverything?: boolean;
}

export function buildParityExpected(assets: LoadedCompiledAssets, o: ParityOptions): RgbaImage {
  const img = createImage(o.width, o.height);
  fillImage(img, ...hexRgb(PARITY.clearColor), 255);
  const [cx, cy] = PARITY.cameraCenter;
  const sx = (wx: number): number => Math.round(o.width / 2 + (wx - cx) * o.pixelsPerUnit);
  const sy = (wy: number): number => Math.round(o.height / 2 - (wy - cy) * o.pixelsPerUnit);
  const rect = (spec: { color: string; center: readonly number[]; size: readonly number[] }): void => {
    const [r, g, b] = hexRgb(spec.color);
    const [x, y] = [spec.center[0] as number, spec.center[1] as number];
    const [w, h] = [spec.size[0] as number, spec.size[1] as number];
    const x0 = sx(x - w / 2);
    const x1 = sx(x + w / 2);
    const y0 = sy(y + h / 2);
    const y1 = sy(y - h / 2);
    for (let py = Math.max(0, y0); py < Math.min(o.height, y1); py++) {
      for (let px = Math.max(0, x0); px < Math.min(o.width, x1); px++) img.data.set([r, g, b, 255], (py * o.width + px) * 4);
    }
  };
  const character = (appearance: AppearanceDefinition, wx: number): void => {
    const resolved = resolveAppearance(assets.index, appearance);
    if (!resolved.ok) throw new Error('parity appearance failed to resolve');
    const clip = assets.index.clips.get(o.clipId);
    if (!clip) throw new Error(`unknown clip ${o.clipId}`);
    const frameIndex = sampleClip(clip, o.timeMs).frameIndex;
    const pose = resolvePose(assets.index, resolved.value, { clipId: o.clipId, direction: o.direction, frameIndex });
    const pivot = resolved.value.rig.footPivot;
    composePose(pose, assets.page, { target: img, origin: { x: sx(wx) - pivot.x, y: sy(0) - pivot.y } });
  };
  const [back, front] = PARITY.characters;
  rect(PARITY.wall);
  if (o.boxBehindEverything) rect(PARITY.box);
  character(heroAppearance(), back.x);
  if (!o.boxBehindEverything) rect(PARITY.box);
  character(companionAppearance(), front.x);
  return img;
}
