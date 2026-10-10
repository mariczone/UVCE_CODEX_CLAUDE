import { z } from 'zod';
import { DIRECTIONS, type Direction8 } from '../core/directions.ts';
import { type Issue, hasErrors } from '../core/issues.ts';
import {
  ROOT_SOCKET,
  clipSchema,
  directionSchema,
  idSchema,
  rectSchema,
  representationSchema,
  rigProfileSchema,
  secondaryMotionSchema,
  sha256Schema,
  validateClip,
  validateRigProfile,
  vec2Schema,
  versionSchema,
  zodIssues,
  type ClipDefinition,
  type RigProfile,
} from './common.ts';

export const COMPILED_MANIFEST_SCHEMA = 'uvce-compiled-manifest-v2';

/** Content key of a trimmed RGBA image: "img-" + first 24 hex chars of its SHA-256 pixel hash. */
export const imageKeySchema = z.string().regex(/^img-[0-9a-f]{24}$/);
export const pageIdSchema = z.string().regex(/^page-[a-z0-9_-]+$/);

export const compiledFrameSchema = z.strictObject({
  image: imageKeySchema,
  /** Where the trimmed image sits on the canonical canvas when its anchor is at its rest position. */
  trim: rectSchema,
  /** Canonical-canvas point placed onto the parent socket at runtime. */
  anchor: vec2Schema,
  /** Per-frame socket positions; only on frames of the rig's socket-driver layer. */
  sockets: z.record(idSchema, vec2Schema).optional(),
  /**
   * Draw the image horizontally flipped (a direction derived from its mirror source, see core/mirror.ts). trim, anchor
   * and sockets are already mirrored; only the texture lookup flips.
   */
  mirror: z.literal(true).optional(),
});
export type CompiledFrame = z.infer<typeof compiledFrameSchema>;

export const compiledPartSchema = z.strictObject({
  layer: idSchema,
  /** Parent socket; "root" = foot pivot. */
  attach: idSchema,
  representation: representationSchema,
  /** Animated frames: clip -> direction -> one frame per clip frame. */
  clips: z.record(idSchema, z.partialRecord(directionSchema, z.array(compiledFrameSchema).min(1))).optional(),
  /** One frame per direction, reused for every clip/frame and moved by its socket. */
  static: z.partialRecord(directionSchema, compiledFrameSchema).optional(),
  allowMirror: z.boolean(),
  /**
   * RIG parts: static images moved and rotated per frame by secondary motion. HYBRID parts were compiled from sparse
   * keyframes into full frame lists (held frames reuse the keyframe image) and render like FRAME.
   */
  motion: secondaryMotionSchema.optional(),
});
export type CompiledPart = z.infer<typeof compiledPartSchema>;

export const compiledItemSchema = z.strictObject({
  id: idSchema,
  version: versionSchema,
  /** SHA-256 over the canonical item metadata incl. every referenced image hash. */
  contentHash: sha256Schema,
  slot: idSchema,
  rigProfileId: idSchema,
  displayName: z.string().min(1),
  /** Packing bundle the item's images were placed in (a packing decision, not part of contentHash). */
  atlasGroup: idSchema,
  /** Pages that must be resident to draw any frame of this item. */
  pages: z.array(pageIdSchema),
  parts: z.array(compiledPartSchema).min(1),
});
export type CompiledItem = z.infer<typeof compiledItemSchema>;

export const pageSchema = z.strictObject({
  id: pageIdSchema,
  file: z.string().regex(/^pages\/[a-z0-9_.-]+\.png$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  filter: z.enum(['linear', 'nearest']),
  /** Stored straight (un-premultiplied) sRGB; the runtime premultiplies on upload. */
  alpha: z.literal('straight'),
  colorSpace: z.literal('srgb'),
  /** SHA-256 of the page RGBA pixels (not of the PNG bytes). */
  contentHash: sha256Schema,
  fileBytes: z.number().int().positive(),
  /** Atlas group (co-use bundle) this page belongs to. */
  group: idSchema,
  /** Items with at least one image on this page. */
  items: z.array(idSchema).min(1),
  /**
   * Images are aligned to 2^mipLevels with a fully transparent 2^mipLevels block between them, so mip levels
   * 0..mipLevels never mix two images. The runtime must not sample deeper levels (TEXTURE_MAX_LEVEL).
   */
  mipLevels: z.number().int().min(0).max(5),
});
export type CompiledPage = z.infer<typeof pageSchema>;

export const regionSchema = z.strictObject({
  page: pageIdSchema,
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
export type ImageRegion = z.infer<typeof regionSchema>;

export const compiledManifestSchema = z.strictObject({
  schemaVersion: z.literal(COMPILED_MANIFEST_SCHEMA),
  /** Content-derived manifest version (no timestamps: identical inputs => identical manifest). */
  manifestVersion: z.string().regex(/^m-[0-9a-f]{16}$/),
  compilerVersion: z.string().min(1),
  source: z.strictObject({
    schemaVersion: z.string(),
    contentHash: sha256Schema,
    generator: z
      .strictObject({ name: z.string(), version: z.string(), seed: z.number().int(), artStatus: z.string() })
      .optional(),
  }),
  rigs: z.array(rigProfileSchema).min(1),
  clips: z.array(clipSchema).min(1),
  pages: z.array(pageSchema),
  images: z.record(imageKeySchema, regionSchema),
  items: z.array(compiledItemSchema),
  /** Explicit logical aliases (old id -> current id). */
  aliases: z.record(idSchema, idSchema),
  stats: z.strictObject({
    sourceFrames: z.number().int().min(0),
    uniqueImages: z.number().int().min(0),
    dedupedFrames: z.number().int().min(0),
    pageCount: z.number().int().min(0),
    pageBytesRGBA8: z.number().int().min(0),
    /** RGBA8 estimate including mip chains (what a fully resident set costs on the GPU). */
    pageBytesWithMips: z.number().int().min(0),
    pageFileBytes: z.number().int().min(0),
    /** Images shared between items of different atlas groups (stored once). */
    crossGroupSharedImages: z.number().int().min(0),
  }),
});
export type CompiledManifest = z.infer<typeof compiledManifestSchema>;

/** Iterate over every frame of a part with its location. */
export function* partFrames(part: CompiledPart): Generator<{ frame: CompiledFrame; clipId: string | null; direction: Direction8; index: number }> {
  for (const [clipId, byDir] of Object.entries(part.clips ?? {})) {
    for (const dir of DIRECTIONS) {
      const frames = byDir[dir];
      if (frames) for (let i = 0; i < frames.length; i++) yield { frame: frames[i] as CompiledFrame, clipId, direction: dir, index: i };
    }
  }
  for (const dir of DIRECTIONS) {
    const frame = part.static?.[dir];
    if (frame) yield { frame, clipId: null, direction: dir, index: 0 };
  }
}

/** Cross-reference checks that a structural schema cannot express. */
export function validateCompiledManifestSemantics(m: CompiledManifest): Issue[] {
  const out: Issue[] = [];
  const err = (code: string, path: string, message: string): void => {
    out.push({ severity: 'error', code, path, message });
  };
  const rigs = new Map<string, RigProfile>();
  m.rigs.forEach((rig, i) => {
    if (rigs.has(rig.id)) err('manifest.duplicate', `/rigs/${i}`, `duplicate rig "${rig.id}"`);
    rigs.set(rig.id, rig);
    out.push(...validateRigProfile(rig, `/rigs/${i}`));
  });
  const clips = new Map<string, ClipDefinition>();
  m.clips.forEach((clip, i) => {
    if (clips.has(clip.id)) err('manifest.duplicate', `/clips/${i}`, `duplicate clip "${clip.id}"`);
    clips.set(clip.id, clip);
    out.push(...validateClip(clip, `/clips/${i}`));
  });
  const pages = new Map(m.pages.map((p) => [p.id, p]));
  if (pages.size !== m.pages.length) err('manifest.duplicate', '/pages', 'duplicate page ids');
  for (const [key, region] of Object.entries(m.images)) {
    const page = pages.get(region.page);
    if (!page) {
      err('image.page', `/images/${key}`, `unknown page "${region.page}"`);
      continue;
    }
    if (region.x + region.w > page.width || region.y + region.h > page.height) {
      err('image.bounds', `/images/${key}`, `region exceeds page ${page.id} (${page.width}x${page.height})`);
    }
    const align = 2 ** page.mipLevels;
    if (region.x % align !== 0 || region.y % align !== 0) {
      err('image.mip-align', `/images/${key}`, `region not aligned to ${align} px required by mipLevels ${page.mipLevels}`);
    }
  }
  const itemIds = new Set<string>();
  m.items.forEach((item, ii) => {
    const ip = `/items/${ii}`;
    if (itemIds.has(item.id)) err('manifest.duplicate', ip, `duplicate item "${item.id}"`);
    itemIds.add(item.id);
    const rig = rigs.get(item.rigProfileId);
    if (!rig) {
      err('item.rig', `${ip}/rigProfileId`, `unknown rig "${item.rigProfileId}"`);
      return;
    }
    const slot = rig.slots.find((s) => s.name === item.slot);
    if (!slot) err('item.slot', `${ip}/slot`, `slot "${item.slot}" not declared by rig ${rig.id}`);
    for (const pageId of item.pages) {
      const page = pages.get(pageId);
      if (!page) err('item.page', `${ip}/pages`, `unknown page "${pageId}"`);
      else if (!page.items.includes(item.id)) err('item.page', `${ip}/pages`, `page "${pageId}" does not list item "${item.id}"`);
    }
    const layersSeen = new Set<string>();
    item.parts.forEach((part, pi) => {
      const pp = `${ip}/parts/${pi}`;
      if (part.representation === 'PROCEDURAL') {
        err('part.representation', `${pp}/representation`, 'PROCEDURAL is reserved; this runtime supports FRAME, RIG and HYBRID');
      }
      if (part.representation === 'RIG') {
        if (!part.static || part.clips) err('part.rig', pp, 'RIG parts provide static images only (motion comes from the rig)');
        if (!part.motion) err('part.rig', `${pp}/motion`, 'RIG parts need a motion spec');
        const follow = part.motion?.follow ?? part.attach;
        if (part.motion && !rig.sockets.includes(follow)) err('part.rig', `${pp}/motion/follow`, `follow socket "${follow}" is not a rig socket`);
      } else if (part.motion) {
        err('part.rig', `${pp}/motion`, `motion is only valid on RIG parts, not ${part.representation}`);
      }
      if (slot && !slot.layers.includes(part.layer)) {
        err('part.layer', `${pp}/layer`, `layer "${part.layer}" is not allowed in slot "${slot.name}"`);
      }
      if (layersSeen.has(part.layer)) err('part.layer', `${pp}/layer`, `item provides layer "${part.layer}" twice`);
      layersSeen.add(part.layer);
      if (part.attach !== ROOT_SOCKET && !rig.sockets.includes(part.attach)) {
        err('part.attach', `${pp}/attach`, `unknown socket "${part.attach}"`);
      }
      if (!part.clips && !part.static) err('part.frames', pp, 'part has neither clip frames nor static frames');
      for (const [clipId, byDir] of Object.entries(part.clips ?? {})) {
        const clip = clips.get(clipId);
        if (!clip) {
          err('part.clip', `${pp}/clips/${clipId}`, `unknown clip "${clipId}"`);
          continue;
        }
        for (const dir of DIRECTIONS) {
          const frames = byDir[dir];
          if (frames && frames.length !== clip.frameDurationsMs.length) {
            err('part.frame-count', `${pp}/clips/${clipId}/${dir}`, `${frames.length} frames but clip "${clipId}" has ${clip.frameDurationsMs.length}`);
          }
        }
      }
      const isDriver = part.layer === rig.socketDriverLayer;
      if (isDriver && !part.clips) err('part.driver', pp, 'socket-driver layer must provide clip frames');
      for (const { frame, clipId, direction, index } of partFrames(part)) {
        const fp = `${pp}/${clipId ? `clips/${clipId}` : 'static'}/${direction}${clipId ? `/${index}` : ''}`;
        const region = m.images[frame.image];
        if (!region) err('frame.image', fp, `unknown image ${frame.image}`);
        else {
          if (region.w !== frame.trim.w || region.h !== frame.trim.h) err('frame.trim', fp, 'trim size differs from image region size');
          if (!item.pages.includes(region.page)) err('frame.page', fp, `image page ${region.page} not listed in item pages`);
        }
        const { width, height } = rig.canonicalCanvas;
        const t = frame.trim;
        if (t.x < 0 || t.y < 0 || t.x + t.w > width || t.y + t.h > height) err('frame.trim', fp, 'trim rect outside canonical canvas');
        if (part.attach === ROOT_SOCKET && (frame.anchor.x !== rig.footPivot.x || frame.anchor.y !== rig.footPivot.y)) {
          err('frame.anchor', fp, 'root-attached frames must be anchored at the rig foot pivot');
        }
        if (frame.mirror && !part.allowMirror) err('frame.mirror', fp, 'mirrored frame in a part without allowMirror');
        if (isDriver) {
          for (const s of rig.sockets) if (!frame.sockets?.[s]) err('frame.sockets', fp, `driver frame lacks socket "${s}"`);
        } else if (frame.sockets) {
          err('frame.sockets', fp, 'only socket-driver frames may define sockets');
        }
      }
    });
  });
  for (const [alias, target] of Object.entries(m.aliases)) {
    if (itemIds.has(alias)) err('alias.shadow', `/aliases/${alias}`, 'alias shadows an existing item id');
    if (!itemIds.has(target)) err('alias.target', `/aliases/${alias}`, `alias target "${target}" does not exist`);
  }
  return out;
}

export type ParseResult<T> = { ok: true; value: T; issues: Issue[] } | { ok: false; issues: Issue[] };

export function parseCompiledManifest(json: unknown): ParseResult<CompiledManifest> {
  const parsed = compiledManifestSchema.safeParse(json);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const issues = validateCompiledManifestSemantics(parsed.data);
  if (hasErrors(issues)) return { ok: false, issues };
  return { ok: true, value: parsed.data, issues };
}

/** Pre-indexed, read-only view used by resolvers and renderers. */
export interface ManifestIndex {
  manifest: CompiledManifest;
  rigs: ReadonlyMap<string, RigProfile>;
  clips: ReadonlyMap<string, ClipDefinition>;
  items: ReadonlyMap<string, CompiledItem>;
  pages: ReadonlyMap<string, CompiledPage>;
  itemsBySlot: ReadonlyMap<string, readonly CompiledItem[]>;
}

export function indexManifest(manifest: CompiledManifest): ManifestIndex {
  const itemsBySlot = new Map<string, CompiledItem[]>();
  for (const item of manifest.items) {
    const list = itemsBySlot.get(item.slot) ?? [];
    list.push(item);
    itemsBySlot.set(item.slot, list);
  }
  return {
    manifest,
    rigs: new Map(manifest.rigs.map((r) => [r.id, r])),
    clips: new Map(manifest.clips.map((c) => [c.id, c])),
    items: new Map(manifest.items.map((i) => [i.id, i])),
    pages: new Map(manifest.pages.map((p) => [p.id, p])),
    itemsBySlot,
  };
}
