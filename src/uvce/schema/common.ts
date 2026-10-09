import { z } from 'zod';
import { DIRECTIONS, DIRECTION_MAPPING_VERSION } from '../core/directions.ts';
import type { Issue } from '../core/issues.ts';

export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'ids are lowercase [a-z0-9_-]');
export const versionSchema = z.string().min(1).max(64);
const int = z.number().int();
/** v1 placement is integer-pixel exact: pivots, anchors, sockets and rects are whole canonical pixels. */
export const vec2Schema = z.strictObject({ x: int, y: int });
export const rectSchema = z.strictObject({ x: int, y: int, w: int.positive(), h: int.positive() });
export const sizeSchema = z.strictObject({ width: int.positive(), height: int.positive() });
export const directionSchema = z.enum(DIRECTIONS);
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #RRGGBB');
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex');
export const REPRESENTATIONS = ['FRAME', 'RIG', 'HYBRID', 'PROCEDURAL'] as const;
export const representationSchema = z.enum(REPRESENTATIONS);
/** Reserved socket name: the foot pivot / ground contact. Always present, never declared. */
export const ROOT_SOCKET = 'root';

export const rigSlotSchema = z.strictObject({
  name: idSchema,
  required: z.boolean(),
  /** Layers an item equipped in this slot may provide. A layer belongs to exactly one slot. */
  layers: z.array(idSchema).min(1),
});

export const rigProfileSchema = z.strictObject({
  id: idSchema,
  version: versionSchema,
  canonicalCanvas: sizeSchema,
  footPivot: vec2Schema,
  pixelsPerWorldUnit: z.number().positive(),
  directionMapping: z.literal(DIRECTION_MAPPING_VERSION),
  directions: z.array(directionSchema).min(1),
  sockets: z.array(idSchema).min(1),
  layers: z.array(idSchema).min(1),
  slots: z.array(rigSlotSchema).min(1),
  /** The layer whose frames carry per-frame socket positions (the animated body). */
  socketDriverLayer: idSchema,
  /** Rest-pose socket positions per direction (canonical canvas pixels). */
  restSockets: z.record(directionSchema, z.record(idSchema, vec2Schema)),
  /** Painter order per direction, back to front. Must be a permutation of `layers`. */
  layerOrder: z.record(directionSchema, z.array(idSchema)),
});
export type RigProfile = z.infer<typeof rigProfileSchema>;

export const clipSchema = z.strictObject({
  id: idSchema,
  version: versionSchema,
  loop: z.boolean(),
  frameDurationsMs: z.array(int.positive()).min(1),
  events: z.array(z.strictObject({ name: idSchema, timeMs: z.number().min(0) })).optional(),
});
export type ClipDefinition = z.infer<typeof clipSchema>;

export function zodIssues(error: z.ZodError, prefix = ''): Issue[] {
  return error.issues.map((i) => ({
    severity: 'error' as const,
    code: `schema.${i.code}`,
    path: `${prefix}/${i.path.map(String).join('/')}`,
    message: i.message,
  }));
}

/** Semantic checks shared by source and compiled manifests. */
export function validateRigProfile(rig: RigProfile, path: string): Issue[] {
  const out: Issue[] = [];
  const err = (code: string, p: string, message: string): void => {
    out.push({ severity: 'error', code, path: `${path}${p}`, message });
  };
  if (rig.directions.join(',') !== DIRECTIONS.join(',')) {
    err('rig.directions', '/directions', `v1 rigs must list all 8 directions in mapping order ${DIRECTIONS.join(',')}`);
  }
  const { width, height } = rig.canonicalCanvas;
  const inCanvas = (v: { x: number; y: number }): boolean => v.x >= 0 && v.y >= 0 && v.x < width && v.y < height;
  if (!inCanvas(rig.footPivot)) err('rig.pivot', '/footPivot', 'foot pivot must lie inside the canonical canvas');
  if (rig.sockets.includes(ROOT_SOCKET)) err('rig.sockets', '/sockets', `"${ROOT_SOCKET}" is reserved and implicit`);
  if (new Set(rig.sockets).size !== rig.sockets.length) err('rig.sockets', '/sockets', 'duplicate socket names');
  if (new Set(rig.layers).size !== rig.layers.length) err('rig.layers', '/layers', 'duplicate layer names');
  if (!rig.layers.includes(rig.socketDriverLayer)) err('rig.driver', '/socketDriverLayer', 'driver layer is not a rig layer');
  const owner = new Map<string, string>();
  rig.slots.forEach((slot, si) => {
    for (const layer of slot.layers) {
      if (!rig.layers.includes(layer)) err('rig.slot-layer', `/slots/${si}/layers`, `unknown layer "${layer}"`);
      const prev = owner.get(layer);
      if (prev) err('rig.slot-layer', `/slots/${si}/layers`, `layer "${layer}" already owned by slot "${prev}"`);
      owner.set(layer, slot.name);
    }
  });
  if (new Set(rig.slots.map((s) => s.name)).size !== rig.slots.length) err('rig.slots', '/slots', 'duplicate slot names');
  for (const layer of rig.layers) {
    if (!owner.has(layer)) err('rig.layer-owner', '/layers', `layer "${layer}" is not owned by any slot`);
  }
  for (const dir of DIRECTIONS) {
    const sockets = rig.restSockets[dir];
    for (const name of rig.sockets) {
      const pos = sockets[name];
      if (!pos) err('rig.rest-socket', `/restSockets/${dir}`, `missing socket "${name}"`);
      else if (!inCanvas(pos)) err('rig.rest-socket', `/restSockets/${dir}/${name}`, 'socket outside canvas');
    }
    for (const name of Object.keys(sockets)) {
      if (!rig.sockets.includes(name)) err('rig.rest-socket', `/restSockets/${dir}/${name}`, `undeclared socket "${name}"`);
    }
    const order = rig.layerOrder[dir];
    const seen = new Set<string>();
    for (const layer of order) {
      if (!rig.layers.includes(layer)) err('rig.order', `/layerOrder/${dir}`, `unknown layer "${layer}"`);
      if (seen.has(layer)) err('rig.order', `/layerOrder/${dir}`, `duplicate layer "${layer}"`);
      seen.add(layer);
    }
    for (const layer of rig.layers) {
      if (!seen.has(layer)) err('rig.order', `/layerOrder/${dir}`, `layer "${layer}" missing from draw order`);
    }
  }
  return out;
}

export function validateClip(clip: ClipDefinition, path: string): Issue[] {
  const out: Issue[] = [];
  const total = clip.frameDurationsMs.reduce((a, b) => a + b, 0);
  (clip.events ?? []).forEach((e, i) => {
    if (e.timeMs > total) {
      out.push({ severity: 'error', code: 'clip.event', path: `${path}/events/${i}`, message: `event at ${e.timeMs}ms beyond clip duration ${total}ms` });
    }
  });
  return out;
}
