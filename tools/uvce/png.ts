import { PNG } from 'pngjs';
import { type RgbaImage } from '../../src/uvce/compositor/rgba.ts';

/** Deterministic RGBA8 PNG encoding (no gAMA/iCCP/time chunks; fixed deflate settings). */
export function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height, colorType: 6, inputColorType: 6, bitDepth: 8, inputHasAlpha: true });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return PNG.sync.write(png, { colorType: 6, inputColorType: 6, inputHasAlpha: true, bitDepth: 8, deflateLevel: 9, filterType: -1 });
}

export interface DecodedPng {
  image: RgbaImage;
  /** PNG colour type of the file (0 grey, 2 RGB, 4 grey+alpha, 6 RGBA; palette images report 3 via `palette`). */
  colorType: number;
  /** True if the file carries alpha (alpha channel or tRNS). */
  hasAlpha: boolean;
  palette: boolean;
  depth: number;
  interlace: boolean;
}

/** Decodes any PNG to 8-bit straight RGBA plus the source format facts the validator needs. */
export function decodePng(buffer: Buffer): DecodedPng {
  const png = PNG.sync.read(buffer);
  return {
    image: { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) },
    colorType: png.colorType,
    hasAlpha: png.alpha,
    palette: png.palette,
    depth: png.depth,
    interlace: png.interlace,
  };
}
