/**
 * UVCE asset compiler v1 (Milestone 0 scope): validate -> trim -> content-hash -> dedupe -> per-item shelf
 * pack -> compiled manifest. Deterministic: same source pixels/metadata => identical manifest and pages.
 * Not yet (Milestone 2): cross-item shared atlases, mip-safe extrusion, KTX2, bundles, streaming.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
import { type SourceFrame, type SourceManifest, parseSourceManifest } from './source-schema.ts';

export const COMPILER_VERSION = 'uvce-compiler/0.1.0';
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

/** Deterministic shelf packer: sort by height, width, key; fill rows; open a new page when full. */
export function packShelves(
  images: readonly { key: string; w: number; h: number }[],
  maxSize: number,
  padding: number,
): { placements: Placement[]; pages: { width: number; height: number }[] } {
  const sorted = [...images].sort((a, b) => b.h - a.h || b.w - a.w || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const area = sorted.reduce((sum, i) => sum + (i.w + padding) * (i.h + padding), 0);
  const widest = sorted.reduce((m, i) => Math.max(m, i.w + 2 * padding), 0);
  if (widest > maxSize || sorted.some((i) => i.h + 2 * padding > maxSize)) throw new RangeError(`image larger than max page size ${maxSize}`);
  let width = 64;
  while (width < Math.min(maxSize, Math.max(widest, Math.ceil(Math.sqrt(area * 1.15))))) width *= 2;
  width = Math.min(width, maxSize); // non-power-of-two limits must not be overshot
  const placements: Placement[] = [];
  const pages: { width: number; height: number }[] = [];
  let page = 0;
  let x = padding;
  let y = padding;
  let shelf = 0;
  let used = 0;
  const closePage = (): void => {
    pages.push({ width, height: Math.min(maxSize, Math.ceil((used + padding) / 4) * 4) });
  };
  for (const img of sorted) {
    if (x + img.w + padding > width) {
      x = padding;
      y += shelf + padding;
      shelf = 0;
    }
    if (y + img.h + padding > maxSize) {
      closePage();
      page++;
      x = padding;
      y = padding;
      shelf = 0;
      used = 0;
    }
    placements.push({ key: img.key, page, x, y });
    x += img.w + padding;
    shelf = Math.max(shelf, img.h);
    used = Math.max(used, y + img.h);
  }
  if (sorted.length > 0) closePage();
  return { placements, pages };
}

export interface BuildReport {
  compilerVersion: string;
  manifestVersion: string;
  items: { id: string; frames: number; uniqueImages: number; pages: number; pageBytesRGBA8: number; pageFileBytes: number }[];
  /** Same pixels used by different items (candidates for Milestone 2 cross-item shared atlases). */
  crossItemDuplicates: { key: string; items: string[] }[];
  warnings: Issue[];
  stats: CompiledManifest['stats'];
}

export interface BuildOptions {
  sourceDir: string;
  outDir: string;
  maxPageSize?: number;
  padding?: number;
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
  await mkdir(join(outDir, 'pages'), { recursive: true });

  const pages: CompiledPage[] = [];
  const images: Record<string, ImageRegion> = {};
  const items: CompiledItem[] = [];
  const reportItems: BuildReport['items'] = [];
  const keyOwners = new Map<string, Set<string>>();
  let sourceFrames = 0;
  let uniqueImages = 0;

  for (const item of source.items) {
    const rig = rigs.get(item.rigProfileId) as RigProfile;
    const unique = new Map<string, ValidatedImage>();
    let itemFrames = 0;
    const compileFrame = async (frame: SourceFrame, attach: string, path: string): Promise<CompiledFrame | null> => {
      sourceFrames++;
      itemFrames++;
      const v = validateSourcePng(await readFile(join(sourceDir, frame.file)), rig, `${path} (${frame.file})`, issues);
      if (!v) return null;
      const prev = unique.get(v.key);
      if (prev && Buffer.compare(Buffer.from(prev.image.data), Buffer.from(v.image.data)) !== 0) {
        throw new Error(`content key collision for ${v.key}`); // 96-bit prefix: practically impossible
      }
      if (!prev) unique.set(v.key, v);
      const owners = keyOwners.get(v.key) ?? new Set<string>();
      owners.add(item.id);
      keyOwners.set(v.key, owners);
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
          const outDir: Partial<Record<Direction8, CompiledFrame[]>> = {};
          for (const [dir, frames] of Object.entries(byDir) as [Direction8, SourceFrame[]][]) {
            const list: CompiledFrame[] = [];
            for (const [fi, f] of frames.entries()) {
              const c = await compileFrame(f, part.attach, `${base}/clips/${clipId}/${dir}/${fi}`);
              if (c) list.push(c);
            }
            outDir[dir] = list;
          }
          clips[clipId] = outDir;
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
    if (hasErrors(issues)) continue; // keep validating other items; abort before writing a manifest

    const packed = packShelves([...unique.values()].map((v) => ({ key: v.key, w: v.trim.w, h: v.trim.h })), maxPageSize, padding);
    const pageImages = packed.pages.map((p) => createImage(p.width, p.height));
    for (const pl of packed.placements) {
      const v = unique.get(pl.key) as ValidatedImage;
      const page = pageImages[pl.page] as RgbaImage;
      for (let row = 0; row < v.image.height; row++) {
        page.data.set(v.image.data.subarray(row * v.image.width * 4, (row + 1) * v.image.width * 4), ((pl.y + row) * page.width + pl.x) * 4);
      }
    }
    const pageIds: string[] = [];
    let pageBytesRGBA8 = 0;
    let pageFileBytes = 0;
    for (const [index, pageImage] of pageImages.entries()) {
      const contentHash = imageContentHash(pageImage);
      const id = `page-${item.id}-${index}`;
      const file = `pages/${item.id}-${index}-${contentHash.slice(0, 12)}.png`;
      const png = encodePng(pageImage);
      await writeFile(join(outDir, file), png);
      pages.push({ id, file, width: pageImage.width, height: pageImage.height, filter: item.filter, alpha: 'straight', colorSpace: 'srgb', contentHash, fileBytes: png.byteLength, owner: item.id });
      pageIds.push(id);
      pageBytesRGBA8 += pageImage.width * pageImage.height * 4;
      pageFileBytes += png.byteLength;
    }
    for (const pl of packed.placements) {
      const v = unique.get(pl.key) as ValidatedImage;
      images[pl.key] = { page: pageIds[pl.page] as string, x: pl.x, y: pl.y, w: v.trim.w, h: v.trim.h };
    }
    uniqueImages += unique.size;
    // Content hash covers logical content only (pixels via image keys + metadata), never atlas placement.
    const contentHash = sha256Hex(canonicalJson({ id: item.id, version: item.version, slot: item.slot, rigProfileId: item.rigProfileId, filter: item.filter, parts }));
    items.push({ id: item.id, version: item.version, contentHash, slot: item.slot, rigProfileId: item.rigProfileId, displayName: item.displayName, pages: pageIds, parts });
    reportItems.push({ id: item.id, frames: itemFrames, uniqueImages: unique.size, pages: pageIds.length, pageBytesRGBA8, pageFileBytes });
  }
  if (hasErrors(issues)) {
    await rm(outDir, { recursive: true, force: true });
    throw new BuildError('asset validation failed', issues.filter((i) => i.severity === 'error'));
  }

  const stats: CompiledManifest['stats'] = {
    sourceFrames,
    uniqueImages,
    dedupedFrames: sourceFrames - uniqueImages,
    pageCount: pages.length,
    pageBytesRGBA8: pages.reduce((s, p) => s + p.width * p.height * 4, 0),
    pageFileBytes: pages.reduce((s, p) => s + p.fileBytes, 0),
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

  const crossItemDuplicates = [...keyOwners.entries()].filter(([, o]) => o.size > 1).map(([key, o]) => ({ key, items: [...o].sort() }));
  const report: BuildReport = {
    compilerVersion: COMPILER_VERSION,
    manifestVersion: manifest.manifestVersion,
    items: reportItems,
    crossItemDuplicates,
    warnings: issues.filter((i) => i.severity === 'warning'),
    stats,
  };
  await mkdir(dirname(join(outDir, 'manifest.json')), { recursive: true });
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outDir, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return { manifest, report };
}
