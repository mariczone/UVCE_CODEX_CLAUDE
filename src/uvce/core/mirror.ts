/**
 * Horizontal mirroring of sprite directions (art saving: draw E/SE/NE, get W/SW/NW).
 *
 * A mirrored direction is the exact horizontal mirror of its source direction about the foot pivot's vertical axis:
 * the image is the SAME texture (no extra memory) sampled flipped, and every coordinate is mirrored:
 *   - pixel columns / integer points (anchors, sockets): x' = 2·pivot.x − 1 − x   (pixel i ↔ pixel 2p−1−i)
 *   - rectangles [x, x+w):                               x' = 2·pivot.x − (x + w)
 * With those two rules, placement (dest = trim + socket − anchor) of a mirrored pose is the mirror of the source
 * pose pixel for pixel. Consequence accepted by the art spec: an item held in the right hand in E appears in the
 * (anatomical) left hand in W.
 */
import type { Direction8 } from './directions.ts';
import type { Rect, Vec2 } from './geometry.ts';

/** Mirrored direction -> the drawn direction it is derived from. */
export const MIRROR_SOURCE: Readonly<Partial<Record<Direction8, Direction8>>> = { W: 'E', SW: 'SE', NW: 'NE' };

export const mirrorPointX = (x: number, pivotX: number): number => 2 * pivotX - 1 - x;

export const mirrorPoint = (p: Vec2, pivotX: number): Vec2 => ({ x: mirrorPointX(p.x, pivotX), y: p.y });

export const mirrorRect = (r: Rect, pivotX: number): Rect => ({ x: 2 * pivotX - (r.x + r.w), y: r.y, w: r.w, h: r.h });

/** Rig fields that differ per direction. */
export interface MirrorableRig {
  footPivot: Vec2;
  layerOrder: Record<Direction8, string[]>;
  restSockets: Record<Direction8, Record<string, Vec2>>;
}

/**
 * A rig whose mirrored directions are exact mirrors of their sources: same painter order, mirrored rest sockets.
 * Use it when the socket-driver (body) itself is mirrored — then the whole W pose is the mirror of the E pose.
 */
export function mirrorRigDirections<R extends MirrorableRig>(rig: R): R {
  const layerOrder = { ...rig.layerOrder };
  const restSockets = { ...rig.restSockets };
  for (const [target, source] of Object.entries(MIRROR_SOURCE) as [Direction8, Direction8][]) {
    layerOrder[target] = [...rig.layerOrder[source]];
    restSockets[target] = Object.fromEntries(Object.entries(rig.restSockets[source]).map(([k, v]) => [k, mirrorPoint(v, rig.footPivot.x)]));
  }
  return { ...rig, layerOrder, restSockets };
}

/** True when every mirrored direction of the rig matches mirrorRigDirections(rig). */
export function rigMirrorsDirections(rig: MirrorableRig): boolean {
  const m = mirrorRigDirections(rig);
  return Object.keys(MIRROR_SOURCE).every((d) => {
    const dir = d as Direction8;
    const want = m.restSockets[dir];
    const have = rig.restSockets[dir];
    const sockets = Object.keys(want).length === Object.keys(have).length && Object.entries(want).every(([k, v]) => have[k]?.x === v.x && have[k]?.y === v.y);
    return sockets && m.layerOrder[dir].join() === rig.layerOrder[dir].join();
  });
}

/** Minimal frame shape shared by source-independent compiled frames. */
export interface MirrorableFrame {
  image: string;
  trim: Rect;
  anchor: Vec2;
  sockets?: Record<string, Vec2>;
  mirror?: boolean;
}

/**
 * The mirrored counterpart of a compiled frame. Root-attached frames keep the foot pivot as anchor (the pivot is
 * the mirror axis); socket-attached frames mirror their anchor like any other point.
 */
export function mirrorFrame<F extends MirrorableFrame>(frame: F, pivot: Vec2, rootAttached: boolean): F {
  const out: F = {
    ...frame,
    trim: mirrorRect(frame.trim, pivot.x),
    anchor: rootAttached ? { ...pivot } : mirrorPoint(frame.anchor, pivot.x),
  };
  if (frame.sockets) out.sockets = Object.fromEntries(Object.entries(frame.sockets).map(([k, v]) => [k, mirrorPoint(v, pivot.x)]));
  if (frame.mirror) delete out.mirror;
  else out.mirror = true;
  return out;
}
