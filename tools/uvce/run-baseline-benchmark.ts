/**
 * Baseline benchmark for the LAYERED renderer (Milestone 0/1 baseline, not an optimisation claim).
 *   pnpm build && pnpm bench:baseline [--counts 1,20,100,300] [--runs 3] [--gpu] [--headed] [--out dir] [--query '&mips=0']
 * Default launches Chromium with SwiftShader (software GL) so it runs in GPU-less containers; pass --gpu on a
 * workstation to use the real GPU. All numbers are device-specific; the environment is recorded with them.
 */
import { execSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import type { Page } from '@playwright/test';
import type { RegistryStats } from '../../src/uvce/assets/source-registry.ts';
import type { CharacterRenderMetrics } from '../../src/uvce/render/contracts.ts';
import { SWIFTSHADER_ARGS, launchChromium, startPreviewServer } from './browser.ts';

interface Summary {
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}
interface Snapshot {
  count: number;
  frameInterval: Summary;
  updateCpu: Summary;
  renderSubmitCpu: Summary;
  totalCpu: Summary;
  gpuTimer: Summary;
  drawCalls: number;
  triangles: number;
  textures: number;
  programs: number;
  character: CharacterRenderMetrics;
  registry: RegistryStats;
}

const args = process.argv.slice(2);
const opt = (name: string, d: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const counts = opt('--counts', '1,20,100,300').split(',').map(Number);
const runs = Number(opt('--runs', '3'));
const warmupMs = Number(opt('--warmup-ms', '2000'));
const measureMs = Number(opt('--measure-ms', '15000'));
const width = Number(opt('--width', '1920'));
const height = Number(opt('--height', '1080'));
const seed = Number(opt('--seed', '20261009'));
const swiftshader = !args.includes('--gpu');
const date = new Date().toISOString().slice(0, 10);
const outDir = opt('--out', `docs/benchmark-results/baseline/${date}`);
/** Extra URL parameters for A/B runs, e.g. '&mips=0' (recorded in the summary). */
const extraQuery = opt('--query', '');

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const r2 = (v: number): number | null => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

interface Transfer {
  requests: number;
  pageRequests: number;
  encodedBytes: number;
  decodedBytes: number;
}

async function runOnce(page: Page, base: string, count: number): Promise<{ snap: Snapshot; readyMs: number; transfer: Transfer; residentPageIds: string[] }> {
  const t0 = Date.now();
  await page.goto(`${base}/?bench=1&count=${count}&seed=${seed}${extraQuery}`);
  await page.waitForFunction(() => (window as unknown as { __UVCE__?: { ready?: boolean } }).__UVCE__?.ready === true, null, { timeout: 120_000 });
  const readyMs = Date.now() - t0;
  await page.waitForTimeout(warmupMs);
  await page.evaluate(() => (window as unknown as { __UVCE__: { resetStats(): void } }).__UVCE__.resetStats());
  await page.waitForTimeout(measureMs);
  const snap = await page.evaluate(() => (window as unknown as { __UVCE__: { snapshot(): unknown } }).__UVCE__.snapshot());
  const transfer = await page.evaluate(() => (window as unknown as { __UVCE__: { assetTransfer(): unknown } }).__UVCE__.assetTransfer());
  const residentPageIds = await page.evaluate(() =>
    (window as unknown as { __UVCE__: { pageStatuses(): { pageId: string; state: string }[] } }).__UVCE__
      .pageStatuses()
      .filter((s) => s.state === 'RESIDENT')
      .map((s) => s.pageId),
  );
  return { snap: snap as Snapshot, readyMs, transfer: transfer as Transfer, residentPageIds };
}

const git = (cmd: string): string => {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

// Record the code state BEFORE this run writes any output (outputs would mark the tree dirty).
const commit = git('git rev-parse HEAD');
const workingTree = git('git status --porcelain') === '' ? 'clean' : 'dirty';
const server = await startPreviewServer(4177);
const browser = await launchChromium({ swiftshader, headed: args.includes('--headed') });
try {
  await mkdir(outDir, { recursive: true });
  const manifest = JSON.parse(await readFile('public/uvce-compiled/manifest.json', 'utf8')) as {
    manifestVersion: string;
    stats: unknown;
    pages: { id: string; width: number; height: number }[];
  };
  const level0Bytes = new Map(manifest.pages.map((p) => [p.id, p.width * p.height * 4]));
  const scenarios: Record<string, unknown>[] = [];
  let env: Record<string, unknown> = {};
  for (const count of counts) {
    const perRun: Awaited<ReturnType<typeof runOnce>>[] = [];
    for (let run = 0; run < runs; run++) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      perRun.push(await runOnce(page, server.url, count));
      if (run === runs - 1) {
        env = await page.evaluate(() => (window as unknown as { __UVCE__: { environment(): Record<string, unknown> } }).__UVCE__.environment());
        await page.screenshot({ path: `${outDir}/scene-${count}.png` });
      }
      await context.close();
      console.log(`[bench] count=${count} run=${run + 1}/${runs}: CPU total p50 ${perRun.at(-1)?.snap.totalCpu.p50.toFixed(2)} ms, draw calls ${perRun.at(-1)?.snap.drawCalls}`);
    }
    const pick = (f: (r: (typeof perRun)[number]) => number): number | null => r2(median(perRun.map(f)));
    scenarios.push({
      count,
      runs,
      visibleCharacters: pick((r) => r.snap.character.visibleCharacters),
      visibleLayers: pick((r) => r.snap.character.visibleLayers),
      uniqueAppearances: pick((r) => r.snap.character.uniqueVisibleAppearances),
      drawCalls: pick((r) => r.snap.drawCalls),
      triangles: pick((r) => r.snap.triangles),
      samplesPerRun: perRun.map((r) => r.snap.totalCpu.samples),
      cpuUpdateMs: { p50: pick((r) => r.snap.updateCpu.p50), p95: pick((r) => r.snap.updateCpu.p95), p99: pick((r) => r.snap.updateCpu.p99) },
      cpuRenderSubmitMs: { p50: pick((r) => r.snap.renderSubmitCpu.p50), p95: pick((r) => r.snap.renderSubmitCpu.p95), p99: pick((r) => r.snap.renderSubmitCpu.p99) },
      cpuTotalMs: { p50: pick((r) => r.snap.totalCpu.p50), p95: pick((r) => r.snap.totalCpu.p95), p99: pick((r) => r.snap.totalCpu.p99) },
      rafIntervalMs: { p50: pick((r) => r.snap.frameInterval.p50), p95: pick((r) => r.snap.frameInterval.p95) },
      gpuTimerQueryMs: perRun.every((r) => r.snap.gpuTimer.samples > 0)
        ? { p50: pick((r) => r.snap.gpuTimer.p50), p95: pick((r) => r.snap.gpuTimer.p95), samplesPerRun: perRun.map((r) => r.snap.gpuTimer.samples) }
        : null,
      residentPages: pick((r) => r.snap.registry.byState.RESIDENT),
      pageLoads: pick((r) => r.snap.registry.fetches),
      sourceRGBA8MiB: pick((r) => r.residentPageIds.reduce((sum, id) => sum + (level0Bytes.get(id) ?? 0), 0) / 1048576),
      residentGpuEstimateMiB: pick((r) => r.snap.registry.residentBytes / 1048576),
      assetRequests: pick((r) => r.transfer.requests),
      pageRequests: pick((r) => r.transfer.pageRequests),
      downloadedAssetKiB: pick((r) => r.transfer.encodedBytes / 1024),
      timeToReadyMs: pick((r) => r.readyMs),
      // Render-mode state at the end of the window (last frame; FULL_CACHE fields are 0 / null in other modes).
      renderMode: perRun[0]?.snap.character.mode ?? null,
      compositedCharacters: pick((r) => r.snap.character.compositedCharacters),
      cachedCharacters: pick((r) => r.snap.character.cachedCharacters),
      cacheHitRatio: perRun.every((r) => r.snap.character.cacheHitRatio !== null) ? pick((r) => r.snap.character.cacheHitRatio as number) : null,
      frameCacheBakesLastFrame: pick((r) => r.snap.character.frameCacheBakes),
      frameCachePauses: pick((r) => r.snap.character.frameCachePauses),
      frameCacheMiB: pick((r) => r.snap.character.compositeEstimatedBytes / 1048576),
    });
  }
  const summary = {
    kind: 'uvce-baseline-benchmark',
    renderMode: 'LAYERED',
    date: new Date().toISOString(),
    commit,
    workingTree,
    protocol: {
      counts,
      runs,
      warmupMs,
      measureMs,
      viewport: { width, height, deviceScaleFactor: 1 },
      seed,
      extraQuery,
      chromiumArgs: swiftshader ? SWIFTSHADER_ARGS : [],
      scene: 'stage scene, perspective camera framed per count, animation playing, MSAA on, overlay and side panel off (bench=1, canvas = full viewport)',
      aggregation: 'per run: nearest-rank percentiles over all frames in the window; reported: median across runs',
    },
    environment: {
      browser: `Chromium ${browser.version()}`,
      ...env,
      os: `${platform()} ${release()}`,
      cpu: `${cpus()[0]?.model ?? 'unknown'} x${cpus().length}`,
      memoryGiB: Math.round((totalmem() / 1073741824) * 10) / 10,
      node: process.version,
    },
    assets: { manifestVersion: manifest.manifestVersion, stats: manifest.stats },
    scenarios,
    caveats: [
      swiftshader
        ? 'Rendered with ANGLE/SwiftShader (CPU software rasterizer) in a headless container: rAF interval and GPU-timer values measure software rasterisation, NOT a GPU. No FPS claim is made.'
        : 'Rendered on the local GPU; results are specific to the recorded browser/GPU/driver.',
      'CPU update = character prepare (resolve/cull/sort) + world update; CPU submit = three.js render() call on the main thread (command encoding, not GPU execution).',
      'CPU submit can include command-buffer back-pressure when the (software) GPU process falls behind.',
      'Draw calls include world props and one ground-shadow decal per visible character.',
      'Byte figures are owner-calculated estimates, not measured VRAM: sourceRGBA8MiB = level 0 of resident pages; residentGpuEstimateMiB includes mip chains.',
    ],
  };
  await writeFile(`${outDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  const header = 'count,visible_characters,visible_layers,draw_calls,cpu_update_p50_ms,cpu_update_p95_ms,cpu_submit_p50_ms,cpu_submit_p95_ms,cpu_total_p50_ms,cpu_total_p95_ms,cpu_total_p99_ms,raf_interval_p50_ms,raf_interval_p95_ms,gpu_timer_p50_ms,resident_pages,page_requests,source_rgba8_mib,downloaded_kib,time_to_ready_ms,resident_gpu_estimate_mib';
  const rows = scenarios.map((s) => {
    const g = s as Record<string, Record<string, number | null> | number | null>;
    const o = (k: string, f: string): string => String(((g[k] as Record<string, number | null> | null) ?? {})[f] ?? '');
    return [g.count, g.visibleCharacters, g.visibleLayers, g.drawCalls, o('cpuUpdateMs', 'p50'), o('cpuUpdateMs', 'p95'), o('cpuRenderSubmitMs', 'p50'), o('cpuRenderSubmitMs', 'p95'), o('cpuTotalMs', 'p50'), o('cpuTotalMs', 'p95'), o('cpuTotalMs', 'p99'), o('rafIntervalMs', 'p50'), o('rafIntervalMs', 'p95'), o('gpuTimerQueryMs', 'p50'), g.residentPages, g.pageRequests, g.sourceRGBA8MiB, g.downloadedAssetKiB, g.timeToReadyMs, g.residentGpuEstimateMiB].join(',');
  });
  await writeFile(`${outDir}/summary.csv`, `${header}\n${rows.join('\n')}\n`);
  console.log(`[bench] wrote ${outDir}/summary.json, summary.csv and ${counts.length} screenshots`);
} finally {
  await browser.close();
  server.stop();
}
