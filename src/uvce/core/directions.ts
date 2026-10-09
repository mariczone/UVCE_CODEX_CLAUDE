/**
 * Canonical 8-direction sprite mapping (versioned).
 *
 * World convention (Three.js): Y up, ground = XZ plane, "north" = -Z, "east" = +X.
 * Compass yaw ψ (radians) grows clockwise seen from above: N=0, E=π/2, S=π, W=3π/2.
 * forward(ψ) = (sin ψ, 0, -cos ψ).
 *
 * The sprite direction is chosen from the facing yaw RELATIVE to the viewing ray, not from world yaw:
 * relative 0 => we see the character's back ("N"), relative π => it faces the camera ("S"),
 * relative π/2 => it faces screen-right ("E"). Each direction owns a ±22.5° sector; an exact boundary
 * belongs to the clockwise-next sector (22.5° => NE).
 */
export const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type Direction8 = (typeof DIRECTIONS)[number];
export const DIRECTION_MAPPING_VERSION = 'dir8-compass-cw-v1';

const TAU = Math.PI * 2;
const SECTOR = Math.PI / 4;

export function isDirection8(value: string): value is Direction8 {
  return (DIRECTIONS as readonly string[]).includes(value);
}

/** Normalizes any angle to [0, 2π). */
export function normalizeAngle(rad: number): number {
  if (!Number.isFinite(rad)) throw new RangeError(`angle must be finite, got ${rad}`);
  let a = rad % TAU;
  if (a < 0) a += TAU;
  if (a >= TAU) a -= TAU;
  return a === 0 ? 0 : a; // drop -0
}

export function directionIndex(direction: Direction8): number {
  return DIRECTIONS.indexOf(direction);
}

/** Relative yaw at the centre of a direction's sector. */
export function directionCenterYaw(direction: Direction8): number {
  return directionIndex(direction) * SECTOR;
}

export function directionFromRelativeYaw(relativeYaw: number): Direction8 {
  const index = Math.floor(normalizeAngle(relativeYaw + SECTOR / 2) / SECTOR) % DIRECTIONS.length;
  return DIRECTIONS[index] as Direction8;
}

/** Compass yaw of a horizontal vector (x, z); a zero vector maps to 0 (north). */
export function compassYawFromXZ(x: number, z: number): number {
  if (x === 0 && z === 0) return 0;
  return normalizeAngle(Math.atan2(x, -z));
}

export function forwardFromCompassYaw(yaw: number): { x: number; z: number } {
  return { x: Math.sin(yaw), z: -Math.cos(yaw) };
}

export interface ViewerPose {
  position: { x: number; y: number; z: number };
  /** Normalised camera forward vector in world space. */
  forward: { x: number; y: number; z: number };
  orthographic: boolean;
}

/**
 * Yaw of the viewing ray that reaches a character. Perspective cameras use the ray from the camera to the
 * character's feet (characters at the screen edge are seen from a different angle); orthographic cameras
 * use the camera forward. Falls back to the camera forward when the ray is (nearly) vertical.
 */
export function viewYawForCharacter(viewer: ViewerPose, feet: { x: number; z: number }): number {
  if (!viewer.orthographic) {
    const dx = feet.x - viewer.position.x;
    const dz = feet.z - viewer.position.z;
    if (dx * dx + dz * dz > 1e-8) return compassYawFromXZ(dx, dz);
  }
  return compassYawFromXZ(viewer.forward.x, viewer.forward.z);
}

/** The sprite direction to display for a character facing `facingYaw` seen along `viewYaw`. */
export function spriteDirection(facingYaw: number, viewYaw: number): Direction8 {
  return directionFromRelativeYaw(facingYaw - viewYaw);
}

/** Facing yaw that makes a character display `direction` for a given view yaw (sector centre). */
export function facingYawForDirection(direction: Direction8, viewYaw: number): number {
  return normalizeAngle(viewYaw + directionCenterYaw(direction));
}

/** Builds a complete per-direction record (typed, in mapping order). */
export function byDirection<T>(fn: (direction: Direction8) => T): Record<Direction8, T> {
  const out = {} as Record<Direction8, T>;
  for (const d of DIRECTIONS) out[d] = fn(d);
  return out;
}
