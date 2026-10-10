/** Builds the Mage v3 "V1s" variant (body_navy on its own pages + shared-image pages) into bench-data/mage-v3/v1s. */
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAssets } from 'file:///C:/Project/UVCE_CODEX_CLAUDE/tools/uvce/compiler.ts';
import type { SourceManifest } from 'file:///C:/Project/UVCE_CODEX_CLAUDE/tools/uvce/source-schema.ts';

const ROOT = 'C:/Project/UVCE_CODEX_CLAUDE/bench-data/mage-v3';
await rm(join(ROOT, 'v1s'), { recursive: true, force: true });
await cp(join(ROOT, 'source'), join(ROOT, 'v1s', 'source'), { recursive: true });
const m = JSON.parse(await readFile(join(ROOT, 'source', 'source-manifest.json'), 'utf8')) as SourceManifest;
for (const it of m.items) {
  if (it.id === 'body_base') it.atlasGroup = 'core';
  else delete it.atlasGroup;
}
await writeFile(join(ROOT, 'v1s', 'source', 'source-manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
const { manifest } = await buildAssets({ sourceDir: join(ROOT, 'v1s', 'source'), outDir: join(ROOT, 'v1s', 'public', 'uvce-compiled'), sharedImages: 'shared-group' });
console.log(`v1s ${manifest.manifestVersion}: ${manifest.stats.pageCount} pages`);
