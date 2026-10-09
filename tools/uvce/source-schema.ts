/**
 * Source manifest = compiler INPUT: what a generator, Blender export or artist hand-off provides
 * (PNG paths + anchors + per-frame sockets). Independent of how the art was produced.
 */
import { z } from 'zod';
import { DIRECTIONS } from '../../src/uvce/core/directions.ts';
import { type Issue, hasErrors } from '../../src/uvce/core/issues.ts';
import {
  ROOT_SOCKET,
  clipSchema,
  directionSchema,
  idSchema,
  representationSchema,
  rigProfileSchema,
  validateClip,
  validateRigProfile,
  vec2Schema,
  versionSchema,
  zodIssues,
} from '../../src/uvce/schema/common.ts';
import type { ParseResult } from '../../src/uvce/schema/compiled-manifest.ts';

export const SOURCE_MANIFEST_SCHEMA = 'uvce-source-manifest-v1';
/** Linear (HD cutout) pages stay bleed-free down to mip level 3 (1/8 size) unless an item overrides it. */
export const DEFAULT_LINEAR_MIP_LEVELS = 3;

export const sourceFrameSchema = z.strictObject({
  /** Path relative to the manifest directory. */
  file: z.string().regex(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.png$/, 'relative .png path ([A-Za-z0-9_-] segments, no "..")'),
  /** Canonical-canvas point placed on the parent socket. Implicit (= foot pivot) for root-attached parts. */
  anchor: vec2Schema.optional(),
  sockets: z.record(idSchema, vec2Schema).optional(),
});
export type SourceFrame = z.infer<typeof sourceFrameSchema>;

export const sourcePartSchema = z.strictObject({
  layer: idSchema,
  attach: idSchema,
  representation: representationSchema,
  allowMirror: z.boolean(),
  clips: z.record(idSchema, z.partialRecord(directionSchema, z.array(sourceFrameSchema).min(1))).optional(),
  static: z.partialRecord(directionSchema, sourceFrameSchema).optional(),
});
export type SourcePart = z.infer<typeof sourcePartSchema>;

export const sourceItemSchema = z.strictObject({
  id: idSchema,
  version: versionSchema,
  slot: idSchema,
  rigProfileId: idSchema,
  displayName: z.string().min(1),
  /** Texture filtering class: HD cutout art = linear, true pixel art = nearest. */
  filter: z.enum(['linear', 'nearest']),
  /** Packing bundle: items always used together share pages (default: the item alone). */
  atlasGroup: idSchema.optional(),
  /** Mip levels the layout must keep bleed-free (default: 3 for linear, 0 for nearest). */
  mipLevels: z.number().int().min(0).max(5).optional(),
  parts: z.array(sourcePartSchema).min(1),
});
export type SourceItem = z.infer<typeof sourceItemSchema>;

export const sourceManifestSchema = z.strictObject({
  schemaVersion: z.literal(SOURCE_MANIFEST_SCHEMA),
  generator: z.strictObject({ name: z.string(), version: z.string(), seed: z.number().int(), artStatus: z.string() }).optional(),
  rigs: z.array(rigProfileSchema).min(1),
  clips: z.array(clipSchema).min(1),
  items: z.array(sourceItemSchema),
  aliases: z.record(idSchema, idSchema),
});
export type SourceManifest = z.infer<typeof sourceManifestSchema>;

export function* sourcePartFrames(part: SourcePart): Generator<{ frame: SourceFrame; clipId: string | null; direction: (typeof DIRECTIONS)[number]; index: number }> {
  for (const [clipId, byDir] of Object.entries(part.clips ?? {})) {
    for (const dir of DIRECTIONS) {
      const frames = byDir[dir];
      if (frames) for (let i = 0; i < frames.length; i++) yield { frame: frames[i] as SourceFrame, clipId, direction: dir, index: i };
    }
  }
  for (const dir of DIRECTIONS) {
    const frame = part.static?.[dir];
    if (frame) yield { frame, clipId: null, direction: dir, index: 0 };
  }
}

export function parseSourceManifest(json: unknown): ParseResult<SourceManifest> {
  const parsed = sourceManifestSchema.safeParse(json);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const m = parsed.data;
  const issues: Issue[] = [];
  const err = (code: string, path: string, message: string): void => {
    issues.push({ severity: 'error', code, path, message });
  };
  m.rigs.forEach((rig, i) => issues.push(...validateRigProfile(rig, `/rigs/${i}`)));
  m.clips.forEach((clip, i) => issues.push(...validateClip(clip, `/clips/${i}`)));
  const clips = new Map(m.clips.map((c) => [c.id, c]));
  const ids = new Set<string>();
  m.items.forEach((item, ii) => {
    const ip = `/items/${ii}`;
    if (ids.has(item.id)) err('item.duplicate', ip, `duplicate item "${item.id}"`);
    ids.add(item.id);
    const rig = m.rigs.find((r) => r.id === item.rigProfileId);
    if (!rig) return err('item.rig', `${ip}/rigProfileId`, `unknown rig "${item.rigProfileId}"`);
    const slot = rig.slots.find((s) => s.name === item.slot);
    if (!slot) err('item.slot', `${ip}/slot`, `unknown slot "${item.slot}"`);
    item.parts.forEach((part, pi) => {
      const pp = `${ip}/parts/${pi}`;
      if (part.representation !== 'FRAME') err('part.representation', pp, `${part.representation} not supported by compiler v1`);
      if (slot && !slot.layers.includes(part.layer)) err('part.layer', pp, `layer "${part.layer}" not allowed in slot "${slot.name}"`);
      const isRoot = part.attach === ROOT_SOCKET;
      if (!isRoot && !rig.sockets.includes(part.attach)) err('part.attach', pp, `unknown socket "${part.attach}"`);
      if (!part.clips && !part.static) err('part.frames', pp, 'no frames');
      for (const [clipId, byDir] of Object.entries(part.clips ?? {})) {
        const clip = clips.get(clipId);
        if (!clip) {
          err('part.clip', `${pp}/clips/${clipId}`, `unknown clip "${clipId}"`);
          continue;
        }
        for (const dir of DIRECTIONS) {
          const n = byDir[dir]?.length;
          if (n !== undefined && n !== clip.frameDurationsMs.length) {
            err('part.frame-count', `${pp}/clips/${clipId}/${dir}`, `${n} frames, clip has ${clip.frameDurationsMs.length}`);
          }
        }
      }
      const isDriver = part.layer === rig.socketDriverLayer;
      for (const { frame, clipId, direction, index } of sourcePartFrames(part)) {
        const fp = `${pp}/${clipId ? `clips/${clipId}/${direction}/${index}` : `static/${direction}`}`;
        if (!isRoot && !frame.anchor) err('frame.anchor', fp, 'socket-attached frames need an explicit anchor');
        if (isDriver) {
          for (const s of rig.sockets) if (!frame.sockets?.[s]) err('frame.sockets', fp, `driver frame lacks socket "${s}"`);
        } else if (frame.sockets) err('frame.sockets', fp, 'only socket-driver frames may define sockets');
      }
    });
  });
  const groups = new Map<string, { filter: string; mipLevels: number; item: string }>();
  m.items.forEach((item, ii) => {
    const group = item.atlasGroup ?? item.id;
    const mip = item.mipLevels ?? (item.filter === 'linear' ? DEFAULT_LINEAR_MIP_LEVELS : 0);
    const prev = groups.get(group);
    if (!prev) groups.set(group, { filter: item.filter, mipLevels: mip, item: item.id });
    else if (prev.filter !== item.filter || prev.mipLevels !== mip) {
      err('item.atlas-group', `/items/${ii}/atlasGroup`, `group "${group}" mixes filter/mip settings with item "${prev.item}"`);
    }
  });
  for (const [alias, target] of Object.entries(m.aliases)) {
    if (ids.has(alias)) err('alias.shadow', `/aliases/${alias}`, 'alias shadows an item id');
    if (!ids.has(target)) err('alias.target', `/aliases/${alias}`, `unknown target "${target}"`);
  }
  return hasErrors(issues) ? { ok: false, issues } : { ok: true, value: m, issues };
}
