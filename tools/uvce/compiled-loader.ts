/** Node-side loader for a compiled asset directory (used by tests and tooling). */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RgbaImage } from '../../src/uvce/compositor/rgba.ts';
import { formatIssues } from '../../src/uvce/core/issues.ts';
import { type ManifestIndex, indexManifest, parseCompiledManifest } from '../../src/uvce/schema/compiled-manifest.ts';
import { decodePng } from './png.ts';

export interface LoadedCompiledAssets {
  index: ManifestIndex;
  pages: Map<string, RgbaImage>;
  page(id: string): RgbaImage | undefined;
}

export async function loadCompiledAssets(dir: string): Promise<LoadedCompiledAssets> {
  const json = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as unknown;
  const parsed = parseCompiledManifest(json);
  if (!parsed.ok) throw new Error(`invalid compiled manifest in ${dir}:\n${formatIssues(parsed.issues)}`);
  const index = indexManifest(parsed.value);
  const pages = new Map<string, RgbaImage>();
  for (const p of parsed.value.pages) pages.set(p.id, decodePng(await readFile(join(dir, p.file))).image);
  return { index, pages, page: (id) => pages.get(id) };
}
