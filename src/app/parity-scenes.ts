/**
 * Pixel-parity scenes as pure data, shared by the app (GPU) and the CPU expectation builder (tests).
 * Pixel camera: ortho, looking along -Z, 1 canvas px == 1 sprite px; every coordinate is a multiple of 1/128
 * so edges land on pixel boundaries. Depth gaps between elements exceed the sprite depth bias (0.1).
 */
import type { Direction8 } from '../uvce/core/directions.ts';

export const PARITY_CLEAR = '#3a404a';
export const PARITY_CAMERA_CENTER = [0, 1.0] as const;

export interface ParityBox {
  kind: 'box';
  id: string;
  color: string;
  center: readonly [number, number, number];
  size: readonly [number, number, number];
  /** < 1 => transparent "glass": ranked in the painter sort together with characters. */
  opacity?: number;
}

export interface ParityCharacter {
  kind: 'character';
  id: string;
  appearance: 'hero' | 'companion';
  x: number;
  z: number;
  /** Optional straight-line motion in depth: z -> zEnd over moveMs (pure function of time). */
  zEnd?: number;
  moveMs?: number;
  /** Fixed facing / clip; otherwise the URL `dir` / `clip` parameters apply. */
  facing?: Direction8;
  clip?: string;
}

export type ParityElement = ParityBox | ParityCharacter;

export interface ParityVariant {
  description: string;
  elements: readonly ParityElement[];
}

const WALL: ParityBox = { kind: 'box', id: 'wall', color: '#5a6f8f', center: [1.0, 0.75, -1.0], size: [1.0, 1.5, 0.1] };
const FRONT_X = 40 / 128;

export type ParityVariantId = 'default' | 'crossing' | 'arch' | 'glass';

export const PARITY_VARIANTS: Record<ParityVariantId, ParityVariant> = {
  default: {
    description: 'opaque box between two overlapping characters in depth, wall behind',
    elements: [
      WALL,
      { kind: 'character', id: 'hero', appearance: 'hero', x: 0, z: 0 },
      { kind: 'box', id: 'box', color: '#c04848', center: [-0.0625, 0.3125, 0.25], size: [0.5, 0.5, 0.1] },
      { kind: 'character', id: 'npc-front', appearance: 'companion', x: FRONT_X, z: 0.5 },
    ],
  },
  crossing: {
    description: 'hero walks toward the camera through the depth of a static companion: painter order flips mid-walk',
    elements: [
      WALL,
      { kind: 'character', id: 'hero', appearance: 'hero', x: 0, z: -0.6, zEnd: 0.6, moveMs: 2400, facing: 'S', clip: 'walk' },
      { kind: 'character', id: 'npc-static', appearance: 'companion', x: FRONT_X, z: 0 },
    ],
  },
  arch: {
    description: 'opaque arch (two pillars + lintel) between the characters: back one framed by it, front one over it',
    elements: [
      WALL,
      { kind: 'character', id: 'hero', appearance: 'hero', x: 0, z: 0 },
      { kind: 'box', id: 'pillar-left', color: '#8d8478', center: [-0.375, 0.875, 0.3], size: [0.125, 1.75, 0.1] },
      { kind: 'box', id: 'pillar-right', color: '#8d8478', center: [0.375, 0.875, 0.3], size: [0.125, 1.75, 0.1] },
      { kind: 'box', id: 'lintel', color: '#6c655d', center: [0, 1.5, 0.3], size: [0.875, 0.25, 0.1] },
      { kind: 'character', id: 'npc-front', appearance: 'companion', x: FRONT_X, z: 0.6 },
    ],
  },
  glass: {
    description: 'translucent glass panel between the characters, depth-sorted with them (not drawn before all sprites)',
    elements: [
      WALL,
      { kind: 'character', id: 'hero', appearance: 'hero', x: 0, z: 0 },
      { kind: 'box', id: 'glass', color: '#7fd4ff', center: [0, 0.5, 0.25], size: [0.75, 0.75, 0.02], opacity: 0.5 },
      { kind: 'character', id: 'npc-front', appearance: 'companion', x: FRONT_X, z: 0.5 },
    ],
  },
};

export function isParityVariant(v: string | null): v is ParityVariantId {
  return v !== null && Object.hasOwn(PARITY_VARIANTS, v);
}

/** Depth of a (possibly moving) character at time t: pure function, used by app and tests alike. */
export function parityCharacterZ(c: ParityCharacter, timeMs: number): number {
  if (c.zEnd === undefined || !c.moveMs) return c.z;
  const k = Math.min(1, Math.max(0, timeMs / c.moveMs));
  return c.z + (c.zEnd - c.z) * k;
}

/** Painter depth used for sorting: the element's z (larger z = nearer the camera at +Z). */
export function parityElementZ(e: ParityElement, timeMs: number): number {
  return e.kind === 'box' ? e.center[2] : parityCharacterZ(e, timeMs);
}
