/**
 * Minimal deterministic software rasterizer for synthetic fixture art.
 * Anti-aliasing = fixed 4x4 supersampling with sample positions (i+0.5)/4; coverage uses only + - * / and
 * comparisons (no trig), so the same inputs give bit-identical pixels on every platform.
 */
import { type RgbaImage, overPixel } from '../../src/uvce/compositor/rgba.ts';
import type { Vec2 } from '../../src/uvce/core/geometry.ts';

export interface Paint {
  r: number;
  g: number;
  b: number;
  /** 0..255; < 255 draws translucent paint (used to exercise alpha compositing). */
  a: number;
}

export function hex(color: string, alpha = 255): Paint {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(color);
  if (!m) throw new Error(`bad colour ${color}`);
  return { r: parseInt(m[1] as string, 16), g: parseInt(m[2] as string, 16), b: parseInt(m[3] as string, 16), a: alpha };
}

export function shade(p: Paint, factor: number): Paint {
  const f = (v: number): number => Math.max(0, Math.min(255, Math.round(v * factor)));
  return { r: f(p.r), g: f(p.g), b: f(p.b), a: p.a };
}

const SS = 4;
const SUB: readonly number[] = [0.125, 0.375, 0.625, 0.875];

type InsideFn = (x: number, y: number) => boolean;

export class Raster {
  readonly image: RgbaImage;

  constructor(image: RgbaImage) {
    this.image = image;
  }

  private coverShape(x0: number, y0: number, x1: number, y1: number, inside: InsideFn, paint: Paint): void {
    const { width, height, data } = this.image;
    const px0 = Math.max(0, Math.floor(x0));
    const py0 = Math.max(0, Math.floor(y0));
    const px1 = Math.min(width - 1, Math.ceil(x1));
    const py1 = Math.min(height - 1, Math.ceil(y1));
    for (let py = py0; py <= py1; py++) {
      for (let px = px0; px <= px1; px++) {
        let hits = 0;
        for (let j = 0; j < SS; j++) {
          const sy = py + (SUB[j] as number);
          for (let i = 0; i < SS; i++) if (inside(px + (SUB[i] as number), sy)) hits++;
        }
        if (hits === 0) continue;
        const alpha = Math.round((paint.a * hits) / (SS * SS));
        overPixel(data, (py * width + px) * 4, paint.r, paint.g, paint.b, alpha);
      }
    }
  }

  /** Pixel-aligned rectangle [x0,x1) x [y0,y1) (integers), no anti-aliasing. */
  rect(x0: number, y0: number, x1: number, y1: number, paint: Paint): void {
    const { width, height, data } = this.image;
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) overPixel(data, (y * width + x) * 4, paint.r, paint.g, paint.b, paint.a);
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, paint: Paint): void {
    const irx2 = 1 / (rx * rx);
    const iry2 = 1 / (ry * ry);
    this.coverShape(cx - rx, cy - ry, cx + rx, cy + ry, (x, y) => (x - cx) * (x - cx) * irx2 + (y - cy) * (y - cy) * iry2 <= 1, paint);
  }

  circle(cx: number, cy: number, r: number, paint: Paint): void {
    this.ellipse(cx, cy, r, r, paint);
  }

  /** Thick segment with round caps (a capsule): all points within `radius` of segment AB. */
  capsule(ax: number, ay: number, bx: number, by: number, radius: number, paint: Paint): void {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const r2 = radius * radius;
    this.coverShape(Math.min(ax, bx) - radius, Math.min(ay, by) - radius, Math.max(ax, bx) + radius, Math.max(ay, by) + radius, (x, y) => {
      let t = len2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ex = ax + t * dx - x;
      const ey = ay + t * dy - y;
      return ex * ex + ey * ey <= r2;
    }, paint);
  }

  /** Filled polygon, even-odd rule. */
  polygon(points: readonly Vec2[], paint: Paint): void {
    if (points.length < 3) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of points) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    const n = points.length;
    this.coverShape(x0, y0, x1, y1, (x, y) => {
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const pi = points[i] as Vec2;
        const pj = points[j] as Vec2;
        if (pi.y > y !== pj.y > y && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside;
      }
      return inside;
    }, paint);
  }

  /** Outline made of capsules along the edges (straddles the edge). */
  strokePolygon(points: readonly Vec2[], width: number, paint: Paint, closed = true): void {
    const n = points.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = points[i] as Vec2;
      const b = points[(i + 1) % n] as Vec2;
      this.capsule(a.x, a.y, b.x, b.y, width / 2, paint);
    }
  }

  /** Fill + outline drawn as a larger shape behind the fill, so the outline stays outside the fill. */
  ellipseOutlined(cx: number, cy: number, rx: number, ry: number, fill: Paint, outline: Paint, width: number): void {
    this.ellipse(cx, cy, rx + width, ry + width, outline);
    this.ellipse(cx, cy, rx, ry, fill);
  }

  capsuleOutlined(ax: number, ay: number, bx: number, by: number, radius: number, fill: Paint, outline: Paint, width: number): void {
    this.capsule(ax, ay, bx, by, radius + width, outline);
    this.capsule(ax, ay, bx, by, radius, fill);
  }

  polygonOutlined(points: readonly Vec2[], fill: Paint, outline: Paint, width: number): void {
    this.polygon(points, fill);
    this.strokePolygon(points, width, outline);
  }
}

/** 3x5 bitmap digits, used to label equipment variants so swaps are visible in screenshots. */
const DIGITS: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

/** Draws `text` with its top-left at integer (x, y); each font pixel is `scale` x `scale`. Never mirrored. */
export function drawDigits(raster: Raster, text: string, x: number, y: number, scale: number, paint: Paint): void {
  let cursor = Math.round(x);
  const top = Math.round(y);
  for (const ch of text) {
    const glyph = DIGITS[ch];
    if (!glyph) throw new Error(`no glyph for "${ch}"`);
    glyph.forEach((row, gy) => {
      for (let gx = 0; gx < row.length; gx++) {
        if (row[gx] === '1') raster.rect(cursor + gx * scale, top + gy * scale, cursor + (gx + 1) * scale, top + (gy + 1) * scale, paint);
      }
    });
    cursor += 4 * scale;
  }
}
