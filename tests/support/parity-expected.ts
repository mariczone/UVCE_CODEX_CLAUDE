/**
 * CPU expectation for the pixel-parity scenes (src/app/parity-scenes.ts). Every element is a plane at its own
 * depth (gaps exceed the sprite depth bias), so painter's order by depth gives the correct image: opaque boxes
 * overwrite, translucent boxes blend (straight-alpha over), characters go through the reference compositor.
 * Same manifest, same resolver as the GPU path.
 */
import { companionAppearance, heroAppearance } from '../../src/uvce/bench/crowd.ts';
import { composePose } from '../../src/uvce/compositor/reference-compositor.ts';
import { type RgbaImage, createImage, fillImage, overPixel } from '../../src/uvce/compositor/rgba.ts';
import { sampleClip } from '../../src/uvce/core/animation.ts';
import { resolveAppearance } from '../../src/uvce/core/appearance-resolver.ts';
import type { Direction8 } from '../../src/uvce/core/directions.ts';
import { resolvePose } from '../../src/uvce/core/pose.ts';
import { PARITY_CAMERA_CENTER, PARITY_CLEAR, PARITY_VARIANTS, type ParityBox, type ParityElement, type ParityVariantId, parityElementZ } from '../../src/app/parity-scenes.ts';
import type { LoadedCompiledAssets } from '../../tools/uvce/compiled-loader.ts';

export function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export interface ParityOptions {
  width: number;
  height: number;
  variant?: ParityVariantId;
  direction: Direction8;
  clipId: string;
  timeMs: number;
  pixelsPerUnit: number;
  /** Negative controls: draw these element ids before everything else (what a missing depth test / sort shows). */
  drawFirst?: readonly string[];
}

export function parityPaintOrder(variant: ParityVariantId, timeMs: number, drawFirst: readonly string[] = []): ParityElement[] {
  const elements = PARITY_VARIANTS[variant].elements.map((e, i) => ({ e, i, z: parityElementZ(e, timeMs) }));
  elements.sort((a, b) => a.z - b.z || a.i - b.i);
  const first = elements.filter((x) => drawFirst.includes(x.e.id));
  const rest = elements.filter((x) => !drawFirst.includes(x.e.id));
  return [...first, ...rest].map((x) => x.e);
}

export function buildParityExpected(assets: LoadedCompiledAssets, o: ParityOptions): RgbaImage {
  const img = createImage(o.width, o.height);
  fillImage(img, ...hexRgb(PARITY_CLEAR), 255);
  const [cx, cy] = PARITY_CAMERA_CENTER;
  const sx = (wx: number): number => Math.round(o.width / 2 + (wx - cx) * o.pixelsPerUnit);
  const sy = (wy: number): number => Math.round(o.height / 2 - (wy - cy) * o.pixelsPerUnit);
  const box = (b: ParityBox): void => {
    const [r, g, bl] = hexRgb(b.color);
    const a = (b.opacity ?? 1) * 255;
    const x0 = sx(b.center[0] - b.size[0] / 2);
    const x1 = sx(b.center[0] + b.size[0] / 2);
    const y0 = sy(b.center[1] + b.size[1] / 2);
    const y1 = sy(b.center[1] - b.size[1] / 2);
    for (let py = Math.max(0, y0); py < Math.min(o.height, y1); py++) {
      for (let px = Math.max(0, x0); px < Math.min(o.width, x1); px++) overPixel(img.data, (py * o.width + px) * 4, r, g, bl, a);
    }
  };
  for (const e of parityPaintOrder(o.variant ?? 'default', o.timeMs, o.drawFirst)) {
    if (e.kind === 'box') {
      box(e);
      continue;
    }
    const resolved = resolveAppearance(assets.index, e.appearance === 'hero' ? heroAppearance() : companionAppearance());
    if (!resolved.ok) throw new Error('parity appearance failed to resolve');
    const clipId = e.clip ?? o.clipId;
    const clip = assets.index.clips.get(clipId);
    if (!clip) throw new Error(`unknown clip ${clipId}`);
    const pose = resolvePose(assets.index, resolved.value, { clipId, direction: e.facing ?? o.direction, frameIndex: sampleClip(clip, o.timeMs).frameIndex });
    const pivot = resolved.value.rig.footPivot;
    composePose(pose, assets.page, { target: img, origin: { x: sx(e.x) - pivot.x, y: sy(0) - pivot.y } });
  }
  return img;
}
