/**
 * Pose model of the synthetic character. Only S, SE, E, NE, N are laid out; SW, W, NW mirror the
 * geometry around x=128 (s = -1). Limb "A" is the character's RIGHT limb in the base orientation; after
 * mirroring, the geometric A slot holds the LEFT limb (e.g. facing W the near arm is the left arm), so
 * semantics are swapped when sockets are labelled. Integer tables only (no trig) => deterministic.
 */
import type { Direction8 } from '../../src/uvce/core/directions.ts';
import type { Vec2 } from '../../src/uvce/core/geometry.ts';
import { FOOT_PIVOT, type FixtureSocket } from './fixture-spec.ts';

export type BaseDir = 'S' | 'SE' | 'E' | 'NE' | 'N';
export const X0 = FOOT_PIVOT.x;

export const DIR_FRAME: Record<Direction8, { base: BaseDir; s: 1 | -1 }> = {
  N: { base: 'N', s: 1 },
  NE: { base: 'NE', s: 1 },
  E: { base: 'E', s: 1 },
  SE: { base: 'SE', s: 1 },
  S: { base: 'S', s: 1 },
  SW: { base: 'SE', s: -1 },
  W: { base: 'E', s: -1 },
  NW: { base: 'NE', s: -1 },
};

/** Screen displacement for one pixel of forward motion (base orientation). */
const FORWARD: Record<BaseDir, { fx: number; fy: number }> = {
  S: { fx: 0, fy: 0.3 },
  SE: { fx: 0.7, fy: 0.25 },
  E: { fx: 1, fy: 0 },
  NE: { fx: 0.7, fy: -0.25 },
  N: { fx: 0, fy: -0.3 },
};

interface BaseLayout {
  /** 'sides': both arms hang beside the torso (drawn in the body layer); 'nearFar': far arm behind the torso, near arm in arm_front. */
  armMode: 'sides' | 'nearFar';
  legX: { a: number; b: number };
  shoulder: { a: Vec2; b: Vec2 };
  hand: { a: Vec2; b: Vec2 };
  torso: Vec2[];
  headDx: number;
  neckDx: number;
  chestDx: number;
  backDx: number;
}

const WIDE_TORSO: Vec2[] = [
  { x: -19, y: 104 },
  { x: 19, y: 104 },
  { x: 24, y: 112 },
  { x: 21, y: 164 },
  { x: -21, y: 164 },
  { x: -24, y: 112 },
];
const DIAG_TORSO: Vec2[] = [
  { x: -15, y: 104 },
  { x: 15, y: 104 },
  { x: 20, y: 112 },
  { x: 17, y: 164 },
  { x: -18, y: 164 },
  { x: -21, y: 112 },
];
const SIDE_TORSO: Vec2[] = [
  { x: -10, y: 104 },
  { x: 9, y: 104 },
  { x: 14, y: 113 },
  { x: 12, y: 164 },
  { x: -12, y: 164 },
  { x: -13, y: 112 },
];

const LAYOUT: Record<BaseDir, BaseLayout> = {
  S: {
    armMode: 'sides',
    legX: { a: -10, b: 10 },
    shoulder: { a: { x: -21, y: 112 }, b: { x: 21, y: 112 } },
    hand: { a: { x: -31, y: 150 }, b: { x: 31, y: 150 } },
    torso: WIDE_TORSO,
    headDx: 0,
    neckDx: 0,
    chestDx: 0,
    backDx: 0,
  },
  N: {
    armMode: 'sides',
    legX: { a: 10, b: -10 },
    shoulder: { a: { x: 21, y: 112 }, b: { x: -21, y: 112 } },
    hand: { a: { x: 31, y: 150 }, b: { x: -31, y: 150 } },
    torso: WIDE_TORSO,
    headDx: 0,
    neckDx: 0,
    chestDx: 0,
    backDx: 0,
  },
  E: {
    armMode: 'nearFar',
    legX: { a: 2, b: -2 },
    shoulder: { a: { x: 1, y: 112 }, b: { x: -2, y: 112 } },
    hand: { a: { x: 5, y: 150 }, b: { x: 2, y: 149 } },
    torso: SIDE_TORSO,
    headDx: 3,
    neckDx: 1,
    chestDx: 0,
    backDx: -11,
  },
  SE: {
    armMode: 'nearFar',
    legX: { a: -8, b: 7 },
    shoulder: { a: { x: -17, y: 112 }, b: { x: 14, y: 112 } },
    hand: { a: { x: -25, y: 150 }, b: { x: 21, y: 148 } },
    torso: DIAG_TORSO,
    headDx: 2,
    neckDx: 1,
    chestDx: -1,
    backDx: -8,
  },
  NE: {
    armMode: 'nearFar',
    legX: { a: 7, b: -8 },
    shoulder: { a: { x: 15, y: 112 }, b: { x: -17, y: 112 } },
    hand: { a: { x: 23, y: 150 }, b: { x: -23, y: 148 } },
    torso: DIAG_TORSO,
    headDx: 1,
    neckDx: 1,
    chestDx: 0,
    backDx: -8,
  },
};

// Walk cycle, 8 frames. Right leg: forward displacement along facing (px) and lift (px).
const LEG_SWING = [0, 4, 7, 4, 0, -4, -7, -4] as const;
const LIFT_RIGHT = [3, 2, 0, 0, 0, 0, 0, 2] as const;
const LIFT_LEFT = [0, 0, 0, 2, 3, 2, 0, 0] as const;
const WALK_BOB = [-1, 0, 1, 0, -1, 0, 1, 0] as const; // y down: -1 = body raised at the passing pose
const ARM_SWING_RIGHT = [0, -3, -5, -3, 0, 3, 5, 3] as const; // opposite to the right leg
// Idle breathing: upper body sinks 0..2 px; feet stay planted.
const IDLE_BOB = [0, 1, 1, 2, 2, 1, 1, 0] as const;

export interface Limb {
  /** Leg: hip; arm: shoulder. */
  root: Vec2;
  /** Leg: bottom-centre of the shoe; arm: hand centre (grip point). */
  end: Vec2;
}

export interface BodyPose {
  direction: Direction8;
  base: BaseDir;
  s: 1 | -1;
  armMode: BaseLayout['armMode'];
  bob: number;
  /** Geometric slot A (near / base-right) and B. */
  legA: Limb;
  legB: Limb;
  armA: Limb;
  armB: Limb;
  torso: Vec2[];
  neckX: number;
  sockets: Record<FixtureSocket, Vec2>;
}

const at = <T>(table: readonly T[], i: number): T => table[((i % table.length) + table.length) % table.length] as T;

export function computeBodyPose(clipId: string, direction: Direction8, frame: number): BodyPose {
  const { base, s } = DIR_FRAME[direction];
  const L = LAYOUT[base];
  const fwd = FORWARD[base];
  const walking = clipId === 'walk';
  const bob = walking ? at(WALK_BOB, frame) : at(IDLE_BOB, frame);
  // Slot A is the right limb when s=1 and the left limb when mirrored: pick that limb's phase.
  const rightIsA = s === 1;
  const legSwing = walking ? at(LEG_SWING, frame) : 0;
  const swingA = rightIsA ? legSwing : -legSwing;
  const liftA = walking ? (rightIsA ? at(LIFT_RIGHT, frame) : at(LIFT_LEFT, frame)) : 0;
  const liftB = walking ? (rightIsA ? at(LIFT_LEFT, frame) : at(LIFT_RIGHT, frame)) : 0;
  const armSwing = walking ? at(ARM_SWING_RIGHT, frame) : 0;
  const armA = rightIsA ? armSwing : -armSwing;
  const mx = (dx: number): number => X0 + s * dx;
  const leg = (legX: number, swing: number, lift: number): Limb => ({
    root: { x: mx(legX), y: 162 + bob },
    end: { x: mx(legX + Math.round(swing * fwd.fx)), y: FOOT_PIVOT.y + Math.round(swing * fwd.fy) - lift },
  });
  const arm = (shoulder: Vec2, hand: Vec2, swing: number): Limb => ({
    root: { x: mx(shoulder.x), y: shoulder.y + bob },
    end: { x: mx(hand.x + Math.round(swing * fwd.fx)), y: hand.y + bob + Math.round(swing * fwd.fy) },
  });
  const legA = leg(L.legX.a, swingA, liftA);
  const legB = leg(L.legX.b, -swingA, liftB);
  const armALimb = arm(L.shoulder.a, L.hand.a, armA);
  const armBLimb = arm(L.shoulder.b, L.hand.b, -armA);
  const right = rightIsA ? armALimb : armBLimb;
  const left = rightIsA ? armBLimb : armALimb;
  const sockets: Record<FixtureSocket, Vec2> = {
    head_top: { x: mx(L.headDx), y: 47 + bob },
    neck: { x: mx(L.neckDx), y: 104 + bob },
    chest: { x: mx(L.chestDx), y: 132 + bob },
    right_hand: { ...right.end },
    left_hand: { ...left.end },
    back: { x: mx(L.backDx), y: 118 + bob },
  };
  return {
    direction,
    base,
    s,
    armMode: L.armMode,
    bob,
    legA,
    legB,
    armA: armALimb,
    armB: armBLimb,
    torso: L.torso.map((p) => ({ x: mx(p.x), y: p.y + bob })),
    neckX: mx(L.neckDx),
    sockets,
  };
}

export function headCenter(direction: Direction8): Vec2 {
  const { base, s } = DIR_FRAME[direction];
  return { x: X0 + s * LAYOUT[base].headDx, y: 74 };
}

/** Rest pose = idle frame 0. Equipment art is authored on the canonical canvas at these socket positions. */
export function restSockets(direction: Direction8): Record<FixtureSocket, Vec2> {
  return computeBodyPose('idle', direction, 0).sockets;
}
