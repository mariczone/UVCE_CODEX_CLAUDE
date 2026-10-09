import { describe, expect, it } from 'vitest';
import {
  DIRECTIONS,
  DIRECTION_MAPPING_VERSION,
  compassYawFromXZ,
  directionCenterYaw,
  directionFromRelativeYaw,
  facingYawForDirection,
  forwardFromCompassYaw,
  normalizeAngle,
  spriteDirection,
  viewYawForCharacter,
} from '../../src/uvce/core/directions.ts';

const deg = (d: number): number => (d * Math.PI) / 180;

describe('8-direction mapping', () => {
  it('has a fixed, versioned order', () => {
    expect(DIRECTIONS).toEqual(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
    expect(DIRECTION_MAPPING_VERSION).toBe('dir8-compass-cw-v1');
  });

  it('maps each sector centre to its direction and round-trips', () => {
    for (const d of DIRECTIONS) expect(directionFromRelativeYaw(directionCenterYaw(d))).toBe(d);
  });

  it('assigns exact sector boundaries to the clockwise-next direction', () => {
    expect(directionFromRelativeYaw(deg(22.5))).toBe('NE');
    expect(directionFromRelativeYaw(deg(22.5) - 1e-9)).toBe('N');
    expect(directionFromRelativeYaw(deg(-22.5))).toBe('N');
    expect(directionFromRelativeYaw(deg(-22.5) - 1e-9)).toBe('NW');
    expect(directionFromRelativeYaw(deg(337.5))).toBe('N');
  });

  it('normalizes angles outside [0, 2π) including negatives and multiples', () => {
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(normalizeAngle(4 * Math.PI)).toBe(0);
    expect(Object.is(normalizeAngle(-0), 0)).toBe(true);
    expect(directionFromRelativeYaw(deg(90) + 6 * Math.PI)).toBe('E');
    expect(() => normalizeAngle(Number.NaN)).toThrow(RangeError);
  });

  it('uses compass yaw: north=-Z, east=+X, clockwise from above', () => {
    expect(compassYawFromXZ(0, -1)).toBe(0);
    expect(compassYawFromXZ(1, 0)).toBeCloseTo(Math.PI / 2, 12);
    expect(compassYawFromXZ(0, 1)).toBeCloseTo(Math.PI, 12);
    expect(compassYawFromXZ(-1, 0)).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(compassYawFromXZ(0, 0)).toBe(0);
    const f = forwardFromCompassYaw(Math.PI / 2);
    expect(f.x).toBeCloseTo(1, 12);
    expect(f.z).toBeCloseTo(0, 12);
  });

  it('selects the sprite from facing RELATIVE to the view, not world yaw alone', () => {
    // Camera looks north: a north-facing character shows its back (N), a south-facing one its front (S).
    expect(spriteDirection(0, 0)).toBe('N');
    expect(spriteDirection(Math.PI, 0)).toBe('S');
    expect(spriteDirection(Math.PI / 2, 0)).toBe('E');
    // Camera orbited to look west: an east-facing character now faces the camera.
    expect(spriteDirection(Math.PI / 2, (3 * Math.PI) / 2)).toBe('S');
    // Same world facing, opposite camera => opposite sprite.
    expect(spriteDirection(deg(135), 0)).toBe('SE');
    expect(spriteDirection(deg(135), Math.PI)).toBe('NW');
  });

  it('derives the view yaw per character for perspective cameras, camera forward for orthographic', () => {
    const viewer = { position: { x: 0, y: 5, z: 10 }, forward: { x: 0, y: -0.5, z: -0.866 }, orthographic: false };
    expect(viewYawForCharacter(viewer, { x: 0, z: 0 })).toBe(0);
    // A character far to the right is seen along a ray pointing north-east.
    expect(viewYawForCharacter(viewer, { x: 10, z: 0 })).toBeCloseTo(deg(45), 12);
    expect(spriteDirection(0, viewYawForCharacter(viewer, { x: 10, z: 0 }))).toBe('NW');
    // Orthographic: identical for every position.
    const ortho = { ...viewer, orthographic: true };
    expect(viewYawForCharacter(ortho, { x: 10, z: 0 })).toBe(0);
    // Camera directly above the character falls back to the camera forward.
    expect(viewYawForCharacter(viewer, { x: 0, z: 10 })).toBe(0);
  });

  it('facingYawForDirection inverts spriteDirection for any view yaw', () => {
    for (const view of [0, deg(30), deg(200), deg(359)]) {
      for (const d of DIRECTIONS) expect(spriteDirection(facingYawForDirection(d, view), view)).toBe(d);
    }
  });
});
