/**
 * Packing variants of the Mage v3 set, compiled with the real compiler into temp dirs and measured with atlasReport.
 * No pixel changes: only atlasGroup (which items share pages) and mipLevels.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atlasReport } from 'file:///C:/Project/UVCE_CODEX_CLAUDE/tools/uvce/atlas-report.ts';
import { buildAssets } from 'file:///C:/Project/UVCE_CODEX_CLAUDE/tools/uvce/compiler.ts';
import type { SourceManifest } from 'file:///C:/Project/UVCE_CODEX_CLAUDE/tools/uvce/source-schema.ts';

const SRC = 'C:/Project/UVCE_CODEX_CLAUDE/bench-data/mage-v3/source';
const OUT = process.argv[2] ?? 'C:/Project/UVCE_CODEX_CLAUDE/bench-data/mage-v3/pack-variants.json';
const base = JSON.parse(await readFile(join(SRC, 'source-manifest.json'), 'utf8')) as SourceManifest;

type Variant = { name: string; edit: (m: SourceManifest) => void; shared?: boolean };
const group = (m: SourceManifest, f: (id: string, slot: string) => string | undefined): void => {
  for (const it of m.items) {
    const g = f(it.id, it.slot);
    if (g === undefined) delete it.atlasGroup;
    else it.atlasGroup = g;
  }
};
const variants: Variant[] = [
  { name: 'V0 as delivered (body_base + body_navy share core)', edit: () => {} },
  { name: 'V1 body_navy on its own pages', edit: (m) => group(m, (id) => (id === 'body_base' ? 'core' : undefined)) },
  { name: 'V2 V1 + one page group per accessory slot', edit: (m) => group(m, (id, slot) => (id === 'body_base' ? 'core' : id === 'body_navy' ? undefined : `acc_${slot}`)) },
  { name: 'V3 V1 + every accessory in one group', edit: (m) => group(m, (id) => (id === 'body_base' ? 'core' : id === 'body_navy' ? undefined : 'accessories')) },
  { name: 'V4 V1 + hair dyed (hair_long_* and hair_01 share one image set)', edit: (m) => {
    group(m, (id) => (id === 'body_base' ? 'core' : undefined));
    m.items = m.items.filter((it) => it.id !== 'hair_long_auburn' && it.id !== 'hair_01'); // the dye would reuse hair_long_brown's pages
  } },
  { name: 'V5 V1 with mipLevels 0 (no mip chains)', edit: (m) => {
    group(m, (id) => (id === 'body_base' ? 'core' : undefined));
    for (const it of m.items) it.mipLevels = 0;
  } },
];

for (const lv of [1, 2]) variants.push({ name: `V6.${lv} V1 with mipLevels ${lv}`, edit: (m) => { group(m, (id) => (id === 'body_base' ? 'core' : undefined)); for (const it of m.items) it.mipLevels = lv; } });
const withShared = variants.slice(1).map((v) => ({ ...v, name: `${v.name.split(' ')[0]}s ${v.name.slice(v.name.indexOf(' ') + 1)} + shared-image pages`, shared: true }));
variants.push(...withShared);
const results: unknown[] = [];
for (const v of variants) {
  const dir = await mkdtemp(join(tmpdir(), 'uvce-pack-'));
  await cp(SRC, join(dir, 'src'), { recursive: true });
  const m = structuredClone(base);
  v.edit(m);
  await writeFile(join(dir, 'src', 'source-manifest.json'), JSON.stringify(m));
  const { manifest } = await buildAssets({ sourceDir: join(dir, 'src'), outDir: join(dir, 'out'), sharedImages: v.shared ? 'shared-group' : 'first-group' });
  const r = atlasReport(manifest);
  const mib = (b: number): string => (b / 1048576).toFixed(2);
  console.log(`${v.name}: ${r.totals.pages} pages, fill ${(r.totals.fill * 100).toFixed(1)} %, GPU ${mib(r.totals.gpuBytes)} MiB, PNG ${(r.totals.fileBytes / 1024).toFixed(0)} KiB, look mean ${mib(r.looks.meanGpuBytes)} MiB, crowd300 ${mib(r.crowds[3]?.gpuBytes ?? 0)} MiB / ${r.crowds[3]?.residentPages} pages`);
  results.push({ variant: v.name, totals: r.totals, looks: r.looks, crowds: r.crowds, pages: r.pages.map((p) => ({ id: p.id, size: `${p.width}x${p.height}`, fill: p.fill, gpuBytes: p.gpuBytes })) });
  await rm(dir, { recursive: true, force: true });
}
await writeFile(OUT, `${JSON.stringify(results, null, 2)}\n`);
