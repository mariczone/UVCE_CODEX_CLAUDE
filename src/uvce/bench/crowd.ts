/**
 * Deterministic crowd fixture: placement, facing, clip, phase and appearance are a pure function of
 * (manifest item ids, seed, index). Member i is identical for any crowd size > i, so 1/20/100/300 scenes
 * are nested and comparable.
 */
import { normalizeAngle } from '../core/directions.ts';
import { createPrng } from '../core/prng.ts';
import { APPEARANCE_SCHEMA_V2, type AppearanceDefinition } from '../schema/appearance.ts';
import type { ManifestIndex } from '../schema/compiled-manifest.ts';

export interface Patrol {
  yaw: number;
  length: number;
  speed: number;
  offsetS: number;
}

export interface CrowdMember {
  entityId: string;
  x: number;
  z: number;
  facingYaw: number;
  clipId: string;
  phaseOffsetMs: number;
  appearance: AppearanceDefinition;
  patrol: Patrol | null;
}

export interface CrowdOptions {
  count: number;
  seed: number;
  spacing?: number;
  walkerRatio?: number;
}

export const HERO_ID = 'hero';
export const HERO_FACING_YAW = (3 * Math.PI) / 4; // SE for the default camera (looking north)

export function heroAppearance(): AppearanceDefinition {
  return {
    schemaVersion: APPEARANCE_SCHEMA_V2,
    rigProfileId: 'humanoid_2d_v1',
    slots: {
      body: { itemId: 'body_base' },
      head: { itemId: 'head_base' },
      hair: { itemId: 'hair_01' },
      armor: { itemId: 'armor_01' },
      hat: { itemId: 'hat_01' },
      weapon: { itemId: 'weapon_01' },
    },
  };
}

/** Second fixed look used by overlap / parity scenes. */
export function companionAppearance(): AppearanceDefinition {
  const base = heroAppearance();
  return { ...base, slots: { ...base.slots, hair: { itemId: 'hair_02' }, hat: { itemId: 'hat_03' }, armor: { itemId: 'armor_03' }, weapon: { itemId: 'weapon_02' } } };
}

/** Grid cells around the origin ordered by distance, then angle-free deterministic tie-break (x, z). */
function gridCells(n: number): { gx: number; gz: number }[] {
  const out: { gx: number; gz: number }[] = [];
  for (let r = 1; out.length < n; r++) {
    const ring: { gx: number; gz: number; d: number }[] = [];
    for (let gx = -r; gx <= r; gx++) {
      for (let gz = -r; gz <= r; gz++) {
        if (Math.max(Math.abs(gx), Math.abs(gz)) !== r) continue;
        ring.push({ gx, gz, d: gx * gx + gz * gz });
      }
    }
    ring.sort((a, b) => a.d - b.d || a.gz - b.gz || a.gx - b.gx);
    for (const c of ring) out.push({ gx: c.gx, gz: c.gz });
  }
  return out.slice(0, n);
}

export function generateCrowd(index: ManifestIndex, options: CrowdOptions): CrowdMember[] {
  const count = Math.max(0, Math.floor(options.count));
  const spacing = options.spacing ?? 1.15;
  const walkerRatio = options.walkerRatio ?? 0.35;
  const ids = (slot: string): string[] => [...(index.itemsBySlot.get(slot) ?? [])].map((i) => i.id).sort();
  const pool = {
    hair: [null, ...ids('hair')],
    hat: [null, ...ids('hat')],
    armor: [null, ...ids('armor')],
    weapon: [null, ...ids('weapon')],
  };
  const body = ids('body')[0];
  const head = ids('head')[0];
  if (!body || !head) throw new Error('crowd needs at least one body and one head item');
  const members: CrowdMember[] = [];
  if (count === 0) return members;
  members.push({ entityId: HERO_ID, x: 0, z: 0, facingYaw: HERO_FACING_YAW, clipId: 'idle', phaseOffsetMs: 0, appearance: heroAppearance(), patrol: null });
  const cells = gridCells(count - 1);
  for (let i = 1; i < count; i++) {
    // Independent stream per member => member i does not depend on the crowd size.
    const rng = createPrng((options.seed * 0x9e3779b1 + i * 0x85ebca6b) >>> 0);
    const cell = cells[i - 1] as { gx: number; gz: number };
    const x = cell.gx * spacing + rng.range(-0.3, 0.3) * spacing;
    const z = cell.gz * spacing + rng.range(-0.3, 0.3) * spacing;
    const facingYaw = normalizeAngle(rng.range(0, Math.PI * 2));
    const walker = rng.next() < walkerRatio;
    const slots: AppearanceDefinition['slots'] = { body: { itemId: body }, head: { itemId: head } };
    for (const slot of ['hair', 'hat', 'armor', 'weapon'] as const) {
      const choice = rng.pick(pool[slot]);
      if (choice) slots[slot] = { itemId: choice };
    }
    members.push({
      entityId: `npc-${String(i).padStart(4, '0')}`,
      x,
      z,
      facingYaw,
      clipId: walker ? 'walk' : 'idle',
      phaseOffsetMs: rng.int(0, 1199),
      appearance: { schemaVersion: APPEARANCE_SCHEMA_V2, rigProfileId: 'humanoid_2d_v1', slots },
      patrol: walker ? { yaw: facingYaw, length: rng.range(0.8, 2.2), speed: 0.9, offsetS: rng.range(0, 5) } : null,
    });
  }
  return members;
}

/** Back-and-forth patrol as a pure function of time (deterministic replay; no accumulated state). */
export function patrolPose(member: CrowdMember, timeMs: number): { x: number; z: number; facingYaw: number } {
  const p = member.patrol;
  if (!p) return { x: member.x, z: member.z, facingYaw: member.facingYaw };
  const period = (2 * p.length) / p.speed;
  const t = (((timeMs / 1000 + p.offsetS) % period) + period) % period;
  const outbound = t < period / 2;
  const d = outbound ? t * p.speed : (period - t) * p.speed;
  return {
    x: member.x + Math.sin(p.yaw) * d,
    z: member.z - Math.cos(p.yaw) * d,
    facingYaw: outbound ? p.yaw : normalizeAngle(p.yaw + Math.PI),
  };
}
