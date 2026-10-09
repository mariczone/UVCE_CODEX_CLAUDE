/** Generates and compiles the synthetic fixtures ONCE per test run into a temp dir shared by all test files. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { buildAssets } from '../../tools/uvce/compiler.ts';
import { DEFAULT_SEED } from '../../tools/uvce/fixture-spec.ts';
import { generateFixtures } from '../../tools/uvce/generate-fixtures.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    uvceFixtures: { root: string; sourceDir: string; compiledDir: string; seed: number };
  }
}

let root = '';

export async function setup(project: TestProject): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'uvce-test-'));
  const sourceDir = join(root, 'source');
  const compiledDir = join(root, 'compiled');
  await generateFixtures({ outDir: sourceDir, seed: DEFAULT_SEED });
  await buildAssets({ sourceDir, outDir: compiledDir });
  project.provide('uvceFixtures', { root, sourceDir, compiledDir, seed: DEFAULT_SEED });
}

export async function teardown(): Promise<void> {
  if (root) await rm(root, { recursive: true, force: true });
}
