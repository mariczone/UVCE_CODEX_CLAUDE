import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inject } from 'vitest';
import { type LoadedCompiledAssets, loadCompiledAssets } from '../../tools/uvce/compiled-loader.ts';
import type { CompiledManifest } from '../../src/uvce/schema/compiled-manifest.ts';

let cached: Promise<LoadedCompiledAssets> | null = null;

export function fixtures(): { root: string; sourceDir: string; compiledDir: string; seed: number } {
  return inject('uvceFixtures');
}

export function compiledAssets(): Promise<LoadedCompiledAssets> {
  cached ??= loadCompiledAssets(fixtures().compiledDir);
  return cached;
}

/** A fresh, mutable deep copy of the compiled manifest JSON for corruption tests. */
export async function manifestJson(): Promise<CompiledManifest> {
  return JSON.parse(await readFile(join(fixtures().compiledDir, 'manifest.json'), 'utf8')) as CompiledManifest;
}
