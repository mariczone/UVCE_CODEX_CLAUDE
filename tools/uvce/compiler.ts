/**
 * UVCE asset compiler v2 (Milestone 2): validate -> trim -> content-hash -> global dedupe -> shelf pack per atlas
 * group (co-use bundle) with a mip-safe aligned layout -> compiled manifest v2. Deterministic: same source
 * pixels/metadata => identical manifest and pages. Not yet: KTX2, usage-statistics-driven grouping.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type RgbaImage, createImage, cropImage, opaqueBounds } from '../../src/uvce/compositor/rgba.ts';
import type { Direction8 } from '../../src/uvce/core/directions.ts';
import type { Rect } from '../../src/uvce/core/geometry.ts';
import { canonicalJson } from '../../src/uvce/core/hash.ts';
import { type Issue, formatIssues, hasErrors } from '../../src/uvce/core/issues.ts';
import { ROOT_SOCKET, type RigProfile } from '../../src/uvce/schema/common.ts';
import {
  COMPILED_MANIFEST_SCHEMA,
  type CompiledFrame,
  type CompiledItem,
  type CompiledManifest,
  type CompiledPage,
  type CompiledPart,
  type ImageRegion,
  parseCompiledManifest,
} from '../../src/uvce/schema/compiled-manifest.ts';
import { decodePng, encodePng } from './png.ts';
import { DEFAULT_LINEAR_MIP_LEVELS, type SourceFrame, type SourceItem, type SourceManifest, parseSourceManifest } from './source-schema.ts';

export const COMPILER_VERSION = 'uvce-compiler/0.2.0';
export const DEFAULT_COMPILED_DIR = 'public/uvce-compiled';
/** Transparent gutter between packed images and at page borders (>= 1 needed for bilinear edges). */
export const PAGE_PADDING = 2;
export const MAX_PAGE_SIZE = 2048;

export class BuildError extends Error {
  readonly issues: Issue[];
  constructor(message: string, issues: Issue[]) {
    super(`${message}\n${formatIssues(issues)}`);
    this.issues = issues;
  }
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Pixel-content hash: independent of PNG encoder/compression, sensitive to every RGBA byte. */
export function imageContentHash(image: RgbaImage): string {
  const h = createHash('sha256');
  h.update(`uvce-rgba8-straight:${image.width}x${image.height}:`);
  h.update(image.data);
  return h.digest('hex');
}

export interface ValidatedImage {
  key: string;
  hash: string;
  trim: Rect;
  image: RgbaImage; // trimmed
}

/** Validates one source PNG against the rig canvas and returns its trimmed, hashed content. */
export function validateSourcePng(buffer: Buffer, rig: RigProfile, path: string, issues: Issue[]): ValidatedImage | null {
  const err = (code: string, message: string): null => {
    issues.push({ severity: 'error', code, path, message });
    return null;
  };
  let decoded;
  try {
    decoded = decodePng(buffer);
  } catch (e) {
    return err('png.decode', `not a decodable PNG: ${(e as Error).message}`);
  }
  if (decoded.depth !== 8) return err('png.depth', `bit depth ${decoded.depth} unsupported (v1 expects 8-bit RGBA)`);
  if (!decoded.hasAlpha) return err('png.no-alpha', 'image has no alpha channel; layers must be true RGBA (no matte)');
  const { width, height } = rig.canonicalCanvas;
  const img = decoded.image;
  if (img.width !== width || img.height !== height) return err('png.size', `size ${img.width}x${img.height}, rig canvas is ${width}x${height}`);
  const trim = opaqueBounds(img);
  if (!trim) return err('png.blank', 'fully transparent layer (omit the frame instead of shipping a blank one)');
  let borderPixels = 0;
  let borderOpaque = 0;
  for (let x = 0; x < width; x++) {
    for (const y of [0, height - 1]) {
      borderPixels++;
      if ((img.data[(y * width + x) * 4 + 3] as number) > 0) borderOpaque++;
    }
  }
  for (let y = 1; y < height - 1; y++) {
    for (const x of [0, width - 1]) {
      borderPixels++;
      if ((img.data[(y * width + x) * 4 + 3] as number) > 0) borderOpaque++;
    }
  }
  if (borderOpaque > borderPixels / 2) return err('png.matte', `${borderOpaque}/${borderPixels} border pixels are non-transparent: baked background/matte?`);
  if (borderOpaque > 0) {
    issues.push({ severity: 'warning', code: 'png.touches-border', path, message: `${borderOpaque} non-transparent border pixels: art may be cropped by the canvas` });
  }
  const image = cropImage(img, trim);
  const hash = imageContentHash(image);
  return { key: `img-${hash.slice(0, 24)}`, hash, trim, image };
}

interface Placement {
  key: string;
  page: number;
  x: number;
  y: number;
}

const alignUp = (v: number, a: number): number => Math.ceil(v / a) * a;

/**
 * Deterministic shelf packer: sort by height, width, key; fill rows; open a new page when full.
 * `align` = 2^mipLevels: every image starts on an `align` boundary and is separated from its neighbours (and the
 * page border) by at least one fully transparent `align`-sized block, so mip levels <= mipLevels never mix images
 * and bilinear taps at those levels only reach transparent texels. With align = 1 the gap is `padding` pixels.
 */
export function packShelves(
  images: readonly { key: string; w: number; h: number }[],
  maxSize: number,
  padding: number,
  align = 1,
): { placements: Placement[]; pages: { width: number; height: number }[] } {
  const gap = Math.max(padding, align);
  const sorted = [...images].sort((a, b) => b.h - a.h || b.w - a.w || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const area = sorted.reduce((sum, i) => sum + alignUp(i.w + gap, align) * alignUp(i.h + gap, align), 0);
  const widest = sorted.reduce((m, i) => Math.max(m, alignUp(gap, align) + i.w + gap), 0);
  if (widest > maxSize || sorted.some((i) => alignUp(gap, align) + i.h + gap > maxSize)) throw new RangeError(`image larger than max page size ${maxSize}`);
  let width = 64;
  while (width < Math.min(maxSize, Math.max(widest, Math.ceil(Math.sqrt(area * 1.15))))) width *= 2;
  width = Math.min(width, maxSize); // non-power-of-two limits must not be overshot
  const start = alignUp(gap, align);
  const placements: Placement[] = [];
  const pages: { width: number; height: number }[] = [];
  let page = 0;
  let x = start;
  let y = start;
  let shelf = 0;
  let used = 0;
  const closePage = (): void => {
    pages.push({ width, height: Math.min(maxSize, alignUp(used + gap, Math.max(4, align))) });
  };
  for (const img of sorted) {
    if (x + img.w + gap > width) {
      x = start;
      y = alignUp(y + shelf + gap, align);
      shelf = 0;
    }
    if (y + img.h + gap > maxSize) {
      closePage();
      page++;
      x = start;
      y = start;
      shelf = 0;
      used = 0;
    }
    placements.push({ key: img.key, page, x, y });
    x = alignUp(x + img.w + gap, align);
    shelf = Math.max(shelf, img.h);
    used = Math.max(used, y + img.h);
  }
  if (sorted.length > 0) closePage();
  return { placements, pages };
}

/** Bytes of an RGBA8 texture with a full mip chain down to 1x1 (what texStorage2D allocates with mipmaps on). */
export function textureBytes(width: number, height: number, mipmapped: boolean): number {
  if (!mipmapped) return width * height * 4;
  let total = 0;
  for (let w = width, h = height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    total += w * h * 4;
    if (w === 1 && h === 1) break;
  }
  return total;
}

export interface BuildReport {
  compilerVersion: string;
  manifestVersion: string;
  groups: { group: string; items: string[]; pages: number; mipLevels: number; pageBytesRGBA8: number; pageBytesWithMips: number; pageFileBytes: number }[];
  items: { id: string; group: string; frames: number; uniqueImages: number; pages: string[] }[];
  /** Images used by items of more than one atlas group: stored once, in the first group's page. */
  crossGroupShared: { key: string; items: string[]; page: string }[];
  warnings: Issue[];
  stats: CompiledManifest['stats'];
}

export interface BuildOptions {
  sourceDir: string;
  outDir: string;
  maxPageSize?: number;
  padding?: number;
}

interface ItemBuild {
  item: SourceItem;
  parts: CompiledPart[];
  keys: string[];
  frames: number;
  group: string;
  mipLevels: number;
}

export async function buildAssets(options: BuildOptions): Promise<{ manifest: CompiledManifest; report: BuildReport }> {
  const { sourceDir, outDir } = options;
  const maxPageSize = options.maxPageSize ?? MAX_PAGE_SIZE;
  const padding = options.padding ?? PAGE_PADDING;
  const sourceText = await readFile(join(sourceDir, 'source-manifest.json'), 'utf8');
  const parsed = parseSourceManifest(JSON.parse(sourceText) as unknown);
  if (!parsed.ok) throw new BuildError('invalid source manifest', parsed.issues);
  const source: SourceManifest = parsed.value;
  const issues: Issue[] = [...parsed.issues];
  const rigs = new Map(source.rigs.map((r) => [r.id, r]));

  await rm(outDir, { recursive: true, force: true });

  // Phase 1: validate, trim and hash every frame of every item (global content dedupe by key).
  const allImages = new Map<string, ValidatedImage>();
  const keyItems = new Map<string, Set<string>>();
  const builds: ItemBuild[] = [];
  let sourceFrames = 0;
  for (const item of source.items) {
    const rig = rigs.get(item.rigProfileId) as RigProfile;
    const keys: string[] = [];
    let frames = 0;
    const compileFrame = async (frame: SourceFrame, attach: string, path: string): Promise<CompiledFrame | null> => {
      sourceFrames++;
      frames++;
      const v = validateSourcePng(await readFile(join(sourceDir, frame.file)), rig, `${path} (${frame.file})`, issues);
      if (!v) return null;
      const prev = allImages.get(v.key);
      if (prev && Buffer.compare(Buffer.from(prev.image.data), Buffer.from(v.image.data)) !== 0) {
        throw new Error(`content key collision for ${v.key}`); // 96-bit prefix: practically impossible
      }
      if (!prev) allImages.set(v.key, v);
      if (!keys.includes(v.key)) keys.push(v.key);
      const owners = keyItems.get(v.key) ?? new Set<string>();
      owners.add(item.id);
      keyItems.set(v.key, owners);
      const anchor = attach === ROOT_SOCKET ? rig.footPivot : frame.anchor;
      if (!anchor) return null; // already reported by source validation
      const out: CompiledFrame = { image: v.key, trim: v.trim, anchor: { ...anchor } };
      if (frame.sockets) out.sockets = Object.fromEntries(Object.entries(frame.sockets).sort(([a], [b]) => (a < b ? -1 : 1)));
      return out;
    };
    const parts: CompiledPart[] = [];
    for (const [pi, part] of item.parts.entries()) {
      const base = `/items/${item.id}/parts/${pi}`;
      const compiled: CompiledPart = { layer: part.layer, attach: part.attach, representation: part.representation, allowMirror: part.allowMirror };
      if (part.clips) {
        const clips: NonNullable<CompiledPart['clips']> = {};
        for (const [clipId, byDir] of Object.entries(part.clips)) {
          const outByDir: Partial<Record<Direction8, CompiledFrame[]>> = {};
          for (const [dir, frameList] of Object.entries(byDir) as [Direction8, SourceFrame[]][]) {
            const list: CompiledFrame[] = [];
            for (const [fi, f] of frameList.entries()) {
              const c = await compileFrame(f, part.attach, `${base}/clips/${clipId}/${dir}/${fi}`);
              if (c) list.push(c);
            }
            outByDir[dir] = list;
          }
          clips[clipId] = outByDir;
        }
        compiled.clips = clips;
      }
      if (part.static) {
        const stat: NonNullable<CompiledPart['static']> = {};
        for (const [dir, f] of Object.entries(part.static) as [Direction8, SourceFrame][]) {
          const c = await compileFrame(f, part.attach, `${base}/static/${dir}`);
          if (c) stat[dir] = c;
        }
        compiled.static = stat;
      }
      parts.push(compiled);
    }
    builds.push({ item, parts, keys, frames, group: item.atlasGroup ?? item.id, mipLevels: item.mipLevels ?? (item.filter === 'linear' ? DEFAULT_LINEAR_MIP_LEVELS : 0) });
  }
  if (hasErrors(issues)) throw new BuildError('asset validation failed', issues.filter((i) => i.severity === 'error'));

  // Phase 2: pack per atlas group (sorted for determinism). An image already placed by an earlier group is
  // referenced, not duplicated.
  await mkdir(join(outDir, 'pages'), { recursive: true });
  const groups = new Map<string, ItemBuild[]>();
  for (const b of builds) groups.set(b.group, [...(groups.get(b.group) ?? []), b]);
  const pages: CompiledPage[] = [];
  const images: Record<string, ImageRegion> = {};
  const placedIn = new Map<string, string>(); // image key -> page id
  const reportGroups: BuildReport['groups'] = [];
  for (const [group, members] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const first = members[0] as ItemBuild;
    const keys = [...new Set(members.flatMap((m) => m.keys))].filter((k) => !placedIn.has(k));
    if (keys.length === 0) continue;
    const align = 2 ** first.mipLevels;
    const packed = packShelves(keys.map((k) => ({ key: k, w: (allImages.get(k) as ValidatedImage).trim.w, h: (allImages.get(k) as ValidatedImage).trim.h })), maxPageSize, padding, align);
    const pageImages = packed.pages.map((pg) => createImage(pg.width, pg.height));
    for (const pl of packed.placements) {
      const v = allImages.get(pl.key) as ValidatedImage;
      const page = pageImages[pl.page] as RgbaImage;
      for (let row = 0; row < v.image.height; row++) {
        page.data.set(v.image.data.subarray(row * v.image.width * 4, (row + 1) * v.image.width * 4), ((pl.y + row) * page.width + pl.x) * 4);
      }
    }
    const pageIds: string[] = [];
    for (const [index, pageImage] of pageImages.entries()) {
      const contentHash = imageContentHash(pageImage);
      const id = `page-${group}-${index}`;
      const file = `pages/${group}-${index}-${contentHash.slice(0, 12)}.png`;
      const png = encodePng(pageImage);
      await writeFile(join(outDir, file), png);
      pages.push({ id, file, width: pageImage.width, height: pageImage.height, filter: first.item.filter, alpha: 'straight', colorSpace: 'srgb', contentHash, fileBytes: png.byteLength, group, items: [], mipLevels: first.mipLevels });
      pageIds.push(id);
    }
    for (const pl of packed.placements) {
      const v = allImages.get(pl.key) as ValidatedImage;
      const pageId = pageIds[pl.page] as string;
      images[pl.key] = { page: pageId, x: pl.x, y: pl.y, w: v.trim.w, h: v.trim.h };
      placedIn.set(pl.key, pageId);
    }
    const groupPages = pages.filter((pg) => pg.group === group);
    reportGroups.push({
      group,
      items: members.map((m) => m.item.id),
      pages: groupPages.length,
      mipLevels: first.mipLevels,
      pageBytesRGBA8: groupPages.reduce((acc, pg) => acc + textureBytes(pg.width, pg.height, false), 0),
      pageBytesWithMips: groupPages.reduce((acc, pg) => acc + textureBytes(pg.width, pg.height, pg.mipLevels > 0), 0),
      pageFileBytes: groupPages.reduce((acc, pg) => acc + pg.fileBytes, 0),
    });
  }

  // Phase 3: items reference every page holding one of their images.
  const items: CompiledItem[] = [];
  const reportItems: BuildReport['items'] = [];
  const pageById = new Map(pages.map((pg) => [pg.id, pg]));
  for (const b of builds) {
    const itemPages = [...new Set(b.keys.map((k) => placedIn.get(k) as string))].sort();
    for (const pid of itemPages) (pageById.get(pid) as CompiledPage).items.push(b.item.id);
    // Content hash covers logical content only (pixels via image keys + metadata), never atlas placement/grouping.
    const contentHash = sha256Hex(canonicalJson({ id: b.item.id, version: b.item.version, slot: b.item.slot, rigProfileId: b.item.rigProfileId, filter: b.item.filter, parts: b.parts }));
    items.push({ id: b.item.id, version: b.item.version, contentHash, slot: b.item.slot, rigProfileId: b.item.rigProfileId, displayName: b.item.displayName, atlasGroup: b.group, pages: itemPages, parts: b.parts });
    reportItems.push({ id: b.item.id, group: b.group, frames: b.frames, uniqueImages: b.keys.length, pages: itemPages });
  }
  for (const pg of pages) pg.items.sort();

  const crossGroupShared = [...keyItems.entries()]
    .filter(([, owners]) => new Set([...owners].map((o) => builds.find((b) => b.item.id === o)?.group)).size > 1)
    .map(([key, owners]) => ({ key, items: [...owners].sort(), page: placedIn.get(key) as string }));
  const stats: CompiledManifest['stats'] = {
    sourceFrames,
    uniqueImages: allImages.size,
    dedupedFrames: sourceFrames - allImages.size,
    pageCount: pages.length,
    pageBytesRGBA8: pages.reduce((acc, pg) => acc + textureBytes(pg.width, pg.height, false), 0),
    pageBytesWithMips: pages.reduce((acc, pg) => acc + textureBytes(pg.width, pg.height, pg.mipLevels > 0), 0),
    pageFileBytes: pages.reduce((acc, pg) => acc + pg.fileBytes, 0),
    crossGroupSharedImages: crossGroupShared.length,
  };
  const sortedImages = Object.fromEntries(Object.entries(images).sort(([a], [b]) => (a < b ? -1 : 1)));
  const body: Omit<CompiledManifest, 'manifestVersion'> = {
    schemaVersion: COMPILED_MANIFEST_SCHEMA,
    compilerVersion: COMPILER_VERSION,
    source: { schemaVersion: source.schemaVersion, contentHash: sha256Hex(sourceText), ...(source.generator ? { generator: source.generator } : {}) },
    rigs: source.rigs,
    clips: source.clips,
    pages,
    images: sortedImages,
    items,
    aliases: source.aliases,
    stats,
  };
  const manifest: CompiledManifest = { ...body, manifestVersion: `m-${sha256Hex(canonicalJson(body)).slice(0, 16)}` };
  const check = parseCompiledManifest(manifest);
  if (!check.ok) throw new BuildError('compiler produced an invalid manifest (bug)', check.issues);
  const report: BuildReport = {
    compilerVersion: COMPILER_VERSION,
    manifestVersion: manifest.manifestVersion,
    groups: reportGroups,
    items: reportItems,
    crossGroupShared,
    warnings: issues.filter((i) => i.severity === 'warning'),
    stats,
  };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outDir, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return { manifest, report };
}
