/**
 * Static memory/packing report of a compiled asset directory (no browser needed):
 *   node tools/uvce/atlas-report.ts --dir public/uvce-compiled [--json out.json] [--seed 20261009]
 *
 * - Pages: size, image pixels vs page pixels (fill), GPU bytes incl. the mip chain the runtime builds, PNG bytes.
 * - Items: pages they need, their own image pixels.
 * - Looks: GPU bytes that must be resident for one appearance (all pages of its items), averaged over the crowd's
 *   random looks; crowds of 1/20/100/300 (the app's generateCrowd with the same seed): union of resident pages.
 * GPU bytes are the runtime's estimate (pageGpuBytes: RGBA8, full mip chain up to mipLevels), not measured VRAM.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateCrowd, heroAppearance } from '../../src/uvce/bench/crowd.ts';
import { resolveAppearance } from '../../src/uvce/core/appearance-resolver.ts';
import type { AppearanceDefinition } from '../../src/uvce/schema/appearance.ts';
import { type CompiledManifest, type ManifestIndex, indexManifest, parseCompiledManifest } from '../../src/uvce/schema/compiled-manifest.ts';

/** Same formula as render/webgl/page-io.ts pageGpuBytes (kept local: that module imports three.js). */
export function pageGpuBytes(page: { width: number; height: number; mipLevels: number; filter: string }, mipmapped = true): number {
  let bytes = page.width * page.height * 4;
  if (!mipmapped || page.mipLevels === 0 || page.filter !== 'linear') return bytes;
  let w = page.width;
  let h = page.height;
  for (let l = 1; l <= page.mipLevels; l++) {
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    bytes += w * h * 4;
  }
  return bytes;
}

export interface AtlasReport {
  manifestVersion: string;
  pages: { id: string; width: number; height: number; mipLevels: number; items: string[]; imagePx: number; fill: number; gpuBytes: number; fileBytes: number }[];
  totals: { pages: number; pagePx: number; imagePx: number; fill: number; gpuBytes: number; fileBytes: number; uniqueImages: number };
  items: { id: string; slot: string; pages: string[]; images: number; imagePx: number; gpuBytesOfPages: number }[];
  looks: { meanGpuBytes: number; minGpuBytes: number; maxGpuBytes: number; heroGpuBytes: number | null };
  crowds: { count: number; distinctLooks: number; residentPages: number; gpuBytes: number }[];
}

function itemsOf(index: ManifestIndex, a: AppearanceDefinition): string[] {
  const r = resolveAppearance(index, a);
  return r.ok ? [...new Set([...r.value.layers.values()].map((l) => l.slot.item.id))] : [];
}

export function atlasReport(manifest: CompiledManifest, seed = 20261009): AtlasReport {
  const index = indexManifest(manifest);
  const imagePxByPage = new Map<string, number>();
  for (const region of Object.values(manifest.images)) imagePxByPage.set(region.page, (imagePxByPage.get(region.page) ?? 0) + region.w * region.h);
  const pages = manifest.pages.map((p) => {
    const imagePx = imagePxByPage.get(p.id) ?? 0;
    return { id: p.id, width: p.width, height: p.height, mipLevels: p.mipLevels, items: p.items, imagePx, fill: imagePx / (p.width * p.height), gpuBytes: pageGpuBytes(p), fileBytes: p.fileBytes };
  });
  const gpuOfPage = new Map(pages.map((p) => [p.id, p.gpuBytes]));
  const pagesOfItems = (ids: string[]): Set<string> => new Set(ids.flatMap((id) => index.items.get(id)?.pages ?? []));
  const bytesOf = (pageIds: Set<string>): number => [...pageIds].reduce((s, id) => s + (gpuOfPage.get(id) ?? 0), 0);
  const items = manifest.items.map((it) => {
    const keys = new Set<string>();
    for (const part of it.parts) {
      for (const byDir of Object.values(part.clips ?? {})) for (const frames of Object.values(byDir)) for (const f of frames ?? []) keys.add(f.image);
      for (const f of Object.values(part.static ?? {})) if (f) keys.add(f.image);
    }
    const imagePx = [...keys].reduce((s, k) => s + (manifest.images[k] ? (manifest.images[k]?.w ?? 0) * (manifest.images[k]?.h ?? 0) : 0), 0);
    return { id: it.id, slot: it.slot, pages: it.pages, images: keys.size, imagePx, gpuBytesOfPages: bytesOf(new Set(it.pages)) };
  });
  const crowd300 = generateCrowd(index, { count: 300, seed });
  const lookBytes = crowd300.slice(1).map((m) => bytesOf(pagesOfItems(itemsOf(index, m.appearance))));
  const heroItems = itemsOf(index, heroAppearance());
  const crowds = [1, 20, 100, 300].map((count) => {
    const members = generateCrowd(index, { count, seed });
    // Member 0 is the hero in the app (its look is heroAppearance()); the rest are random NPC outfits.
    const looks = [heroAppearance(), ...members.slice(1).map((m) => m.appearance)];
    const resident = pagesOfItems(looks.flatMap((a) => itemsOf(index, a)));
    const distinct = new Set(looks.map((a) => JSON.stringify(a.slots))).size;
    return { count, distinctLooks: distinct, residentPages: resident.size, gpuBytes: bytesOf(resident) };
  });
  const pagePx = pages.reduce((s, p) => s + p.width * p.height, 0);
  const imagePx = pages.reduce((s, p) => s + p.imagePx, 0);
  return {
    manifestVersion: manifest.manifestVersion,
    pages,
    totals: { pages: pages.length, pagePx, imagePx, fill: imagePx / pagePx, gpuBytes: pages.reduce((s, p) => s + p.gpuBytes, 0), fileBytes: pages.reduce((s, p) => s + p.fileBytes, 0), uniqueImages: Object.keys(manifest.images).length },
    items,
    looks: { meanGpuBytes: lookBytes.reduce((a, b) => a + b, 0) / lookBytes.length, minGpuBytes: Math.min(...lookBytes), maxGpuBytes: Math.max(...lookBytes), heroGpuBytes: heroItems.length ? bytesOf(pagesOfItems(heroItems)) : null },
    crowds,
  };
}

const mib = (b: number): string => (b / 1048576).toFixed(2);

if (process.argv[1]?.endsWith('atlas-report.ts')) {
  const args = process.argv.slice(2);
  const opt = (n: string): string | undefined => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
  const dir = opt('--dir') ?? 'public/uvce-compiled';
  const parsed = parseCompiledManifest(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));
  if (!parsed.ok) throw new Error(`invalid manifest in ${dir}`);
  const r = atlasReport(parsed.value, Number(opt('--seed') ?? 20261009));
  console.log(`${dir} (${r.manifestVersion}): ${r.totals.pages} pages, ${r.totals.uniqueImages} images, fill ${(r.totals.fill * 100).toFixed(1)} %, GPU ${mib(r.totals.gpuBytes)} MiB (mips), PNG ${(r.totals.fileBytes / 1024).toFixed(0)} KiB`);
  for (const p of r.pages) console.log(`  ${p.id.padEnd(28)} ${`${p.width}x${p.height}`.padEnd(10)} fill ${(p.fill * 100).toFixed(1).padStart(5)} %  GPU ${mib(p.gpuBytes).padStart(6)} MiB  ${p.items.join(',')}`);
  console.log(`  look: mean ${mib(r.looks.meanGpuBytes)} MiB (min ${mib(r.looks.minGpuBytes)}, max ${mib(r.looks.maxGpuBytes)}), hero ${r.looks.heroGpuBytes === null ? 'n/a' : mib(r.looks.heroGpuBytes)} MiB`);
  for (const c of r.crowds) console.log(`  crowd ${String(c.count).padStart(3)}: ${c.distinctLooks} looks, ${c.residentPages} pages, GPU ${mib(c.gpuBytes)} MiB`);
  const out = opt('--json');
  if (out) await writeFile(out, `${JSON.stringify(r, null, 2)}\n`);
}
