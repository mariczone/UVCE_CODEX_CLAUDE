/**
 * Specification of the synthetic UVCE fixture set (rig, clips, items). Pure data; the art is in fixture-art.ts.
 * Everything here is SYNTHETIC TEST CONTENT for renderer correctness, not production art.
 */
import { DIRECTIONS, DIRECTION_MAPPING_VERSION, type Direction8, byDirection } from '../../src/uvce/core/directions.ts';
import type { Vec2 } from '../../src/uvce/core/geometry.ts';
import type { ClipDefinition, RigProfile, SecondaryMotion } from '../../src/uvce/schema/common.ts';

export const GENERATOR_NAME = 'tools/uvce/generate-fixtures.ts';
export const GENERATOR_VERSION = '1.1.0';
export const DEFAULT_SEED = 1337;
export const ART_STATUS = 'synthetic-placeholder-not-for-production';

export const CANVAS = 256;
export const FOOT_PIVOT: Vec2 = { x: 128, y: 228 };
/** 128 source px = 1 world unit (metre); the ~200 px tall fixture character is ~1.56 m. */
export const PIXELS_PER_WORLD_UNIT = 128;

export const SOCKETS = ['head_top', 'neck', 'chest', 'right_hand', 'left_hand', 'back'] as const;
export type FixtureSocket = (typeof SOCKETS)[number];

export const LAYERS = ['hair_back', 'body', 'arm_front', 'armor', 'head', 'hair_front', 'hat', 'weapon'] as const;
export type FixtureLayer = (typeof LAYERS)[number];

export const SLOTS: RigProfile['slots'] = [
  { name: 'body', required: true, layers: ['body', 'arm_front'] },
  { name: 'head', required: true, layers: ['head'] },
  { name: 'hair', required: false, layers: ['hair_back', 'hair_front'] },
  { name: 'armor', required: false, layers: ['armor'] },
  { name: 'hat', required: false, layers: ['hat'] },
  { name: 'weapon', required: false, layers: ['weapon'] },
];

/**
 * Painter order per direction (back -> front). Derived from which hand faces the camera:
 * the weapon is held in the RIGHT hand, which is on the near side for S/SE/E/NE and the far side for
 * SW/W/NW (and at the side for N, drawn behind). In back views the hair mass covers the head, so
 * hair_back comes after head; the fringe (hair_front) is not drawn there.
 */
const FRONT_WEAPON_NEAR: FixtureLayer[] = ['hair_back', 'body', 'armor', 'arm_front', 'head', 'hair_front', 'hat', 'weapon'];
const FRONT_WEAPON_FAR: FixtureLayer[] = ['hair_back', 'weapon', 'body', 'armor', 'arm_front', 'head', 'hair_front', 'hat'];
export const LAYER_ORDER: Record<Direction8, FixtureLayer[]> = {
  S: FRONT_WEAPON_NEAR,
  SE: FRONT_WEAPON_NEAR,
  E: FRONT_WEAPON_NEAR,
  NE: ['hair_front', 'body', 'armor', 'head', 'hair_back', 'hat', 'arm_front', 'weapon'],
  N: ['hair_front', 'weapon', 'body', 'armor', 'arm_front', 'head', 'hair_back', 'hat'],
  NW: ['hair_front', 'weapon', 'body', 'armor', 'arm_front', 'head', 'hair_back', 'hat'],
  W: FRONT_WEAPON_FAR,
  SW: FRONT_WEAPON_FAR,
};

export const CLIPS: ClipDefinition[] = [
  // Breathing idle; uneven durations exercise non-uniform timing.
  { id: 'idle', version: '1', loop: true, frameDurationsMs: [180, 120, 120, 180, 180, 120, 120, 180] },
  {
    id: 'walk',
    version: '1',
    loop: true,
    frameDurationsMs: [100, 100, 100, 100, 100, 100, 100, 100],
    events: [
      { name: 'footstep', timeMs: 0 },
      { name: 'footstep', timeMs: 400 },
    ],
  },
];

/** Secondary motion of the RIG fixture part: trails the neck by one frame, up to 3 px and 8 degrees. */
export const HAIR_SWAY: SecondaryMotion = { lagFrames: 1, gain: 1, maxOffsetPx: 3, degPerPx: 4, maxDeg: 8 };

/** Secondary motion of the staff: trails the hand by one frame, up to 2 px and 8 degrees of tilt. */
export const STAFF_SWING: SecondaryMotion = { lagFrames: 1, gain: 0.5, maxOffsetPx: 2, degPerPx: 2, maxDeg: 8 };

export interface ItemSpec {
  id: string;
  slot: string;
  displayName: string;
  /** Items that are always co-used share atlas pages. */
  atlasGroup?: string;
  /** Which layers it provides and to which socket each attaches. */
  parts: { layer: FixtureLayer; attach: FixtureSocket | 'root'; animated: boolean; motion?: SecondaryMotion }[];
  /** Drawn in 5 directions only (N NE E SE S); the compiler mirrors W/SW/NW from E/SE/NE (allowMirror). */
  mirror?: boolean;
}

export const ITEMS: ItemSpec[] = [
  {
    id: 'body_base',
    slot: 'body',
    displayName: 'Base body',
    atlasGroup: 'core',
    parts: [
      { layer: 'body', attach: 'root', animated: true },
      { layer: 'arm_front', attach: 'root', animated: true },
    ],
  },
  { id: 'head_base', slot: 'head', displayName: 'Base head', atlasGroup: 'core', parts: [{ layer: 'head', attach: 'neck', animated: false }] },
  ...(['01', '02'] as const).map((n) => ({
    id: `hair_${n}`,
    slot: 'hair',
    displayName: n === '01' ? 'Hair 1 (bob)' : 'Hair 2 (long)',
    mirror: n === '02',
    parts: [
      // hair_02's back hair is a RIG part (Milestone 4): it trails the neck with secondary motion.
      { layer: 'hair_back' as const, attach: 'neck' as const, animated: false, ...(n === '02' ? { motion: HAIR_SWAY } : {}) },
      { layer: 'hair_front' as const, attach: 'neck' as const, animated: false },
    ],
  })),
  ...(['01', '02', '03'] as const).map((n, i) => ({
    id: `hat_${n}`,
    mirror: n === '03',
    slot: 'hat',
    displayName: ['Hat 1 (straw)', 'Hat 2 (wizard)', 'Hat 3 (cap + translucent visor)'][i] as string,
    parts: [{ layer: 'hat' as const, attach: 'head_top' as const, animated: false }],
  })),
  ...(['01', '02', '03'] as const).map((n, i) => ({
    id: `armor_${n}`,
    mirror: n === '03',
    slot: 'armor',
    displayName: ['Armor 1 (tabard)', 'Armor 2 (leather)', 'Armor 3 (robe + translucent sash)'][i] as string,
    parts: [{ layer: 'armor' as const, attach: 'chest' as const, animated: false }],
  })),
  ...(['01', '02', '03'] as const).map((n, i) => ({
    id: `weapon_${n}`,
    mirror: n === '02',
    slot: 'weapon',
    displayName: ['Weapon 1 (sword)', 'Weapon 2 (staff)', 'Weapon 3 (axe)'][i] as string,
    // weapon_02 (staff) is a RIG part: it lags and tilts behind the hand swing of the walk cycle.
    parts: [{ layer: 'weapon' as const, attach: 'right_hand' as const, animated: false, ...(n === '02' ? { motion: STAFF_SWING } : {}) }],
  })),
];

/** Explicit aliases for ids used by the starter-pack example appearance. */
export const ALIASES: Record<string, string> = {
  body_novice: 'body_base',
  head_novice: 'head_base',
  sword_01: 'weapon_01',
};

export function buildRig(restSockets: Record<Direction8, Record<FixtureSocket, Vec2>>): RigProfile {
  return {
    id: 'humanoid_2d_v1',
    version: '1',
    canonicalCanvas: { width: CANVAS, height: CANVAS },
    footPivot: FOOT_PIVOT,
    pixelsPerWorldUnit: PIXELS_PER_WORLD_UNIT,
    directionMapping: DIRECTION_MAPPING_VERSION,
    directions: [...DIRECTIONS],
    sockets: [...SOCKETS],
    layers: [...LAYERS],
    slots: SLOTS,
    socketDriverLayer: 'body',
    restSockets: byDirection((d) => ({ ...restSockets[d] })),
    layerOrder: byDirection((d) => [...LAYER_ORDER[d]]),
  };
}
