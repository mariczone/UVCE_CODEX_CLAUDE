import type { Rect } from '../core/geometry.ts';

/** 8-bit RGBA image, STRAIGHT (non-premultiplied) alpha, sRGB-encoded values, row-major, top-left origin. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function createImage(width: number, height: number): RgbaImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`invalid image size ${width}x${height}`);
  }
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function fillImage(image: RgbaImage, r: number, g: number, b: number, a: number): void {
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = r;
    image.data[i + 1] = g;
    image.data[i + 2] = b;
    image.data[i + 3] = a;
  }
}

/**
 * Straight-alpha "over" for one pixel, in 8-bit sRGB-encoded space (the same space the WebGL canvas blends in).
 *   A = As + Ad(1-As);  C = (Cs*As + Cd*Ad*(1-As)) / A
 * Results are rounded half-up; this rounding rule is part of the reference definition.
 */
export function overPixel(dst: Uint8Array, di: number, sr: number, sg: number, sb: number, sa255: number): void {
  if (sa255 <= 0) return;
  if (sa255 >= 255) {
    dst[di] = sr;
    dst[di + 1] = sg;
    dst[di + 2] = sb;
    dst[di + 3] = 255;
    return;
  }
  const as = sa255 / 255;
  const ad = (dst[di + 3] as number) / 255;
  const wd = ad * (1 - as);
  const outA = as + wd;
  dst[di] = Math.round((sr * as + (dst[di] as number) * wd) / outA);
  dst[di + 1] = Math.round((sg * as + (dst[di + 1] as number) * wd) / outA);
  dst[di + 2] = Math.round((sb * as + (dst[di + 2] as number) * wd) / outA);
  dst[di + 3] = Math.round(outA * 255);
}

/** Draws `src` (or its `srcRect`) with its top-left at (dx, dy) using straight-alpha over. Clips to dst. */
export function blitOver(dst: RgbaImage, src: RgbaImage, dx: number, dy: number, srcRect?: Rect): void {
  const sx0 = srcRect?.x ?? 0;
  const sy0 = srcRect?.y ?? 0;
  const w = srcRect?.w ?? src.width;
  const h = srcRect?.h ?? src.height;
  for (let y = 0; y < h; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < w; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const si = ((sy0 + y) * src.width + sx0 + x) * 4;
      const a = src.data[si + 3] as number;
      if (a === 0) continue;
      overPixel(dst.data, (ty * dst.width + tx) * 4, src.data[si] as number, src.data[si + 1] as number, src.data[si + 2] as number, a);
    }
  }
}

export function cropImage(src: RgbaImage, rect: Rect): RgbaImage {
  const out = createImage(rect.w, rect.h);
  for (let y = 0; y < rect.h; y++) {
    const from = ((rect.y + y) * src.width + rect.x) * 4;
    out.data.set(src.data.subarray(from, from + rect.w * 4), y * rect.w * 4);
  }
  return out;
}

/** Bounding box of pixels with alpha > 0, or null for a fully transparent image. */
export function opaqueBounds(image: RgbaImage): Rect | null {
  let x0 = image.width;
  let y0 = image.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if ((image.data[(y * image.width + x) * 4 + 3] as number) > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export interface ImageDiff {
  width: number;
  height: number;
  /** Pixels where any channel differs by more than the tolerance. */
  mismatched: number;
  maxChannelDelta: number;
  /** Red = mismatch beyond tolerance, yellow = within tolerance but not identical, grey = equal (dimmed reference). */
  heatmap: RgbaImage;
}

/**
 * Alpha-aware comparison: fully transparent pixels compare equal regardless of their RGB (hidden colour is
 * irrelevant). Sizes must match.
 */
export function diffImages(actual: RgbaImage, expected: RgbaImage, tolerance: number): ImageDiff {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new RangeError(`size mismatch ${actual.width}x${actual.height} vs ${expected.width}x${expected.height}`);
  }
  const heatmap = createImage(actual.width, actual.height);
  let mismatched = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < actual.data.length; i += 4) {
    const aa = actual.data[i + 3] as number;
    const ea = expected.data[i + 3] as number;
    let delta = Math.abs(aa - ea);
    if (aa !== 0 || ea !== 0) {
      for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs((actual.data[i + c] as number) - (expected.data[i + c] as number)));
    }
    if (delta > maxChannelDelta) maxChannelDelta = delta;
    const grey = Math.round(((expected.data[i] as number) + (expected.data[i + 1] as number) + (expected.data[i + 2] as number)) / 6);
    if (delta > tolerance) {
      mismatched++;
      heatmap.data.set([255, 0, 0, 255], i);
    } else if (delta > 0) heatmap.data.set([255, 210, 0, 255], i);
    else heatmap.data.set([grey, grey, grey, 255], i);
  }
  return { width: actual.width, height: actual.height, mismatched, maxChannelDelta, heatmap };
}
