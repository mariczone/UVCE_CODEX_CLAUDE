export { createImage, cropImage, opaqueBounds } from '../../src/uvce/compositor/rgba.ts';

/** True if the rects overlap or are closer than `gap` pixels. */
export function rectsOverlapWithGap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, gap: number): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}
