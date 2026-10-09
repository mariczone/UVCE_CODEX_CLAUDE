/**
 *   node tools/uvce/build-assets.ts [--src assets/source/uvce-synthetic] [--out public/uvce-compiled]
 */
import { BuildError, DEFAULT_COMPILED_DIR, buildAssets } from './compiler.ts';
import { DEFAULT_SOURCE_DIR } from './generate-fixtures.ts';

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const args = process.argv.slice(2);
const sourceDir = argValue(args, '--src') ?? DEFAULT_SOURCE_DIR;
const outDir = argValue(args, '--out') ?? DEFAULT_COMPILED_DIR;
const t0 = performance.now();
try {
  const { manifest, report } = await buildAssets({ sourceDir, outDir });
  const s = manifest.stats;
  console.log(
    `[assets:build] ${manifest.manifestVersion}: ${manifest.items.length} items, ${s.sourceFrames} source frames -> ${s.uniqueImages} unique images ` +
      `(${s.dedupedFrames} deduped), ${s.pageCount} pages, ${(s.pageBytesRGBA8 / 1048576).toFixed(2)} MiB RGBA8 ` +
      `(${(s.pageFileBytes / 1024).toFixed(1)} KiB PNG), ${report.warnings.length} warnings in ${(performance.now() - t0).toFixed(0)} ms -> ${outDir}`,
  );
  for (const w of report.warnings.slice(0, 10)) console.warn(`  [warning] ${w.code} ${w.path}: ${w.message}`);
} catch (e) {
  if (e instanceof BuildError) {
    console.error(`[assets:build] FAILED: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
