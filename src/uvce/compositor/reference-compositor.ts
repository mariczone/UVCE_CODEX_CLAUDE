/**
 * CPU reference compositor: the ground truth the GPU renderer is compared against.
 * Draws the resolved layers back-to-front with straight-alpha "over" in 8-bit sRGB space, integer-aligned,
 * no filtering. Pure TS (runs in Node tests and in the browser).
 */
import type { Vec2 } from '../core/geometry.ts';
import type { ResolvedPose } from '../core/pose.ts';
import { type RgbaImage, blitOver, createImage } from './rgba.ts';

export type PageLookup = (pageId: string) => RgbaImage | undefined;

/**
 * Composites `pose` onto `target` (or a new transparent canvas of the rig size) with the canonical canvas
 * origin placed at `origin` in target pixels.
 */
export function composePose(
  pose: ResolvedPose,
  pages: PageLookup,
  options: { canvas?: { width: number; height: number }; target?: RgbaImage; origin?: Vec2 } = {},
): RgbaImage {
  const target = options.target ?? createImage(options.canvas?.width ?? 256, options.canvas?.height ?? 256);
  const origin = options.origin ?? { x: 0, y: 0 };
  for (const layer of pose.layers) {
    const page = pages(layer.region.page);
    if (!page) throw new Error(`reference compositor: page ${layer.region.page} not loaded`);
    blitOver(target, page, origin.x + layer.dest.x, origin.y + layer.dest.y, {
      x: layer.region.x,
      y: layer.region.y,
      w: layer.region.w,
      h: layer.region.h,
    });
  }
  return target;
}
