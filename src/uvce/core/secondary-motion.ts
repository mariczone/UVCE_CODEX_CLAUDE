/**
 * RIG secondary motion (Milestone 4): a part (hair, cape) trails the movement of a driver socket.
 *
 * movement = socket(frame) − socket(frame − lagFrames)        (wrapping for looping clips, clamped otherwise)
 * offset   = clamp(round(−gain · movement), ±maxOffsetPx)     (whole pixels, rounded half away from zero so mirrored
 *                                                              directions get exactly the negated offset)
 * rotation = clamp(degPerPx · movement.x, ±maxDeg) degrees     (y-down canvas: positive = clockwise on screen, so
 *                                                              something hanging below its pivot swings back)
 * pivot    = the attach socket after the offset, at its pixel centre (+0.5).
 *
 * Pure function of the clip's socket track: identical for every character with the same (appearance, clip,
 * direction, frame), so pose and frame caches stay valid. A mirrored direction has mirrored sockets, so the offset's
 * x and the rotation flip sign by themselves and the mirrored pose stays the mirror of its source.
 */
import type { SecondaryMotion } from '../schema/common.ts';
import type { Rect, Vec2 } from './geometry.ts';

export interface LayerRotation {
  deg: number;
  /** Canvas coordinates (continuous; pixel X covers [X, X+1)). */
  pivot: Vec2;
}

export interface SecondaryTransform {
  dx: number;
  dy: number;
  rotation: LayerRotation | null;
}

const clamp = (v: number, m: number): number => Math.max(-m, Math.min(m, v));
/** Round half away from zero: symmetric, so a mirrored direction's offset is exactly the negated source offset. */
const roundSym = (v: number): number => Math.sign(v) * Math.round(Math.abs(v));
/** Avoids -0 (keeps keys/snapshots stable). */
const clean = (v: number): number => (v === 0 ? 0 : v);

export function secondaryTransform(
  motion: SecondaryMotion,
  socketAt: (frameIndex: number) => Vec2 | undefined,
  frameIndex: number,
  frameCount: number,
  loop: boolean,
): SecondaryTransform {
  const prevIndex = loop ? (((frameIndex - motion.lagFrames) % frameCount) + frameCount) % frameCount : Math.max(0, frameIndex - motion.lagFrames);
  const cur = socketAt(frameIndex);
  const prev = socketAt(prevIndex);
  if (!cur || !prev) return { dx: 0, dy: 0, rotation: null };
  const mx = cur.x - prev.x;
  const my = cur.y - prev.y;
  const dx = clean(clamp(roundSym(-motion.gain * mx), motion.maxOffsetPx));
  const dy = clean(clamp(roundSym(-motion.gain * my), motion.maxOffsetPx));
  const deg = clean(clamp(motion.degPerPx * mx, motion.maxDeg));
  return { dx, dy, rotation: deg === 0 ? null : { deg, pivot: { x: 0, y: 0 } } };
}

/** Rotates canvas point p about `pivot` by `deg` (y-down: positive = clockwise on screen). */
export function rotatePoint(p: Vec2, r: LayerRotation): Vec2 {
  const a = (r.deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = p.x - r.pivot.x;
  const y = p.y - r.pivot.y;
  return { x: r.pivot.x + c * x - s * y, y: r.pivot.y + s * x + c * y };
}

/** Integer bounding box of a rect rotated about a pivot (the pixels a rotated layer can touch). */
export function rotatedBounds(rect: Rect, r: LayerRotation): Rect {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x, y: rect.y + rect.h },
    { x: rect.x + rect.w, y: rect.y + rect.h },
  ].map((p) => rotatePoint(p, r));
  // 1e-9 snaps float noise (cos 90° = 6e-17) so exact corners don't grow the box by a pixel.
  const x0 = Math.floor(Math.min(...corners.map((p) => p.x)) + 1e-9);
  const y0 = Math.floor(Math.min(...corners.map((p) => p.y)) + 1e-9);
  const x1 = Math.ceil(Math.max(...corners.map((p) => p.x)) - 1e-9);
  const y1 = Math.ceil(Math.max(...corners.map((p) => p.y)) - 1e-9);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
