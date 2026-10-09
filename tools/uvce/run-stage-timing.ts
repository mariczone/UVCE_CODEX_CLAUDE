/**
 * Stage-isolated frame timing: attributes per-frame cost to pipeline stages (complements bench:baseline).
 *   pnpm build && pnpm bench:stages [--counts 1,20,100,300] [--runs 2] [--gpu] [--query '&mips=0']
 *                                   [--compare <other build dir, e.g. ../uvce-m0/dist>] [--out <file.json>]
 * The rAF loop is stopped and frames are stepped by hand. A 1-px readPixels before and after each frame makes the
 * GPU (or SwiftShader) idle while the CPU stages run, so they are not inflated by rasterisation running in
 * parallel on the same cores:
 *   pump    registry.beginFrame (fetch start, uploads, budget)       world   controls + crowd update
 *   prepare characters.prepareFrame (resolve, cull, pin, sort)      submit  three.render() (JS + command encoding)
 *   raster  the readPixels wait after submit: rasterisation + MSAA resolve + readback. Under SwiftShader this is
 *           CPU work, NOT a GPU number; on a GPU it is completion latency, not pure GPU time.
 * Modes: `full` viewport, and `scissor1px` (rendering clipped to one pixel: same JS and draw calls, ~no fill).
 * Relies on UvceApp internals (stop, updateWorld, frameNo, characters, registry, three), so it also runs against
 * older builds (from commit 3db7a20 on) for A/B comparisons.
 */
import { writeFile } from 'node:fs/promises';
import { SWIFTSHADER_ARGS, launchChromium, startPreviewServer } from './browser.ts';

const args = process.argv.slice(2);
const opt = (name: string, d: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const counts = opt('--counts', '1,20,100,300').split(',').map(Number);
const runs = Number(opt('--runs', '2'));
const query = opt('--query', '');
const compare = opt('--compare', '');
const out = opt('--out', '');
const swiftshader = !args.includes('--gpu');
const seed = 20261009;

const STAGES = ['pump', 'world', 'prepare', 'submit', 'raster'] as const;
type Stage = (typeof STAGES)[number];
type Samples = Record<Stage, number[]> & { drawCalls: number; visibleLayers: number };

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The UvceApp internals this tool drives (private in TypeScript, reachable at runtime). */
interface AppInternals {
  stop(): void;
  frameNo: number;
  simTimeMs: number;
  instances: unknown;
  scene: unknown;
  camera: unknown;
  controls: { update(): void } | null;
  updateWorld(): void;
  registry: { beginFrame?: (frame: number) => unknown };
  characters: { prepareFrame(characters: unknown, nowMs: number): void; getMetrics(): { visibleLayers: number } };
  three: {
    getContext(): WebGL2RenderingContext;
    setScissorTest(on: boolean): void;
    setScissor(x: number, y: number, w: number, h: number): void;
    render(scene: unknown, camera: unknown): void;
    info: { render: { calls: number } };
  };
}

/** Runs in the page. Accesses UvceApp internals on purpose (see header). */
async function stepFrames(opts: { frames: number; warmup: number; scissor: boolean }): Promise<Samples> {
  const app = (window as unknown as { __UVCE__: { app: AppInternals } }).__UVCE__.app;
  app.stop();
  const gl = app.three.getContext();
  if (opts.scissor) {
    app.three.setScissorTest(true);
    app.three.setScissor(0, 0, 1, 1);
  }
  // gl.finish() is only a flush in Chromium; a 1-px readPixels waits until the frame is really rasterised.
  const px = new Uint8Array(4);
  const sync = (): void => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const s: Samples = { pump: [], world: [], prepare: [], submit: [], raster: [], drawCalls: 0, visibleLayers: 0 };
  for (let f = 0; f < opts.warmup + opts.frames; f++) {
    app.simTimeMs += 1000 / 60;
    sync();
    await new Promise((r) => setTimeout(r, 0));
    const t0 = performance.now();
    if (app.registry.beginFrame) app.registry.beginFrame(++app.frameNo);
    const t1 = performance.now();
    app.controls?.update();
    app.updateWorld();
    const t2 = performance.now();
    app.characters.prepareFrame(app.instances, app.simTimeMs);
    const t3 = performance.now();
    app.three.render(app.scene, app.camera);
    const t4 = performance.now();
    sync();
    const t5 = performance.now();
    if (f < opts.warmup) continue;
    s.pump.push(t1 - t0);
    s.world.push(t2 - t1);
    s.prepare.push(t3 - t2);
    s.submit.push(t4 - t3);
    s.raster.push(t5 - t4);
    s.drawCalls = app.three.info.render.calls;
    s.visibleLayers = app.characters.getMetrics().visibleLayers;
  }
  return s;
}

const builds = [{ name: 'current', dist: 'dist' }, ...(compare ? [{ name: compare, dist: compare }] : [])];
const servers = await Promise.all(builds.map((b, i) => startPreviewServer(4180 + i, b.dist)));
const browser = await launchChromium({ swiftshader, headed: args.includes('--headed') });
const rows: Record<string, unknown>[] = [];
let glRenderer = 'unknown';
try {
  for (const count of counts) {
    const frames = count >= 300 ? 120 : count >= 100 ? 200 : 300;
    const perKey = new Map<string, Samples[]>();
    // Interleave builds and modes inside every run so slow drift affects all of them alike.
    for (let run = 0; run < runs; run++) {
      for (const [bi, build] of builds.entries()) {
        for (const scissor of [false, true]) {
          const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
          const page = await context.newPage();
          await page.goto(`${(servers[bi] as { url: string }).url}/?bench=1&count=${count}&seed=${seed}${query}`);
          await page.waitForFunction(() => (window as unknown as { __UVCE__?: { ready?: boolean } }).__UVCE__?.ready === true, null, { timeout: 120_000 });
          glRenderer = await page.evaluate(() => (window as unknown as { __UVCE__: { environment(): { glRenderer: string } } }).__UVCE__.environment().glRenderer);
          const samples = await page.evaluate(stepFrames, { frames, warmup: 20, scissor });
          await context.close();
          const key = `${build.name}|${scissor ? 'scissor1px' : 'full'}`;
          perKey.set(key, [...(perKey.get(key) ?? []), samples]);
        }
      }
    }
    for (const [key, list] of perKey) {
      const [build, mode] = key.split('|') as [string, string];
      const row: Record<string, unknown> = { build, count, mode, drawCalls: list[0]?.drawCalls, visibleLayers: list[0]?.visibleLayers };
      // Per run: median over frames; reported: median across runs.
      for (const stage of STAGES) row[`${stage}P50Ms`] = r3(median(list.map((s) => median(s[stage]))));
      rows.push(row);
    }
  }
} finally {
  await browser.close();
  for (const s of servers) s.stop();
}

console.log(`[bench:stages] GL renderer: ${glRenderer}${glRenderer.includes('SwiftShader') ? ' (software: raster = CPU work, not GPU)' : ''}`);
console.log('build | count | mode | pump | world | prepare | submit | raster (ms, p50) | draw calls | layers');
for (const r of rows) {
  console.log([r.build, r.count, r.mode, ...STAGES.map((s) => (r[`${s}P50Ms`] as number).toFixed(3)), r.drawCalls, r.visibleLayers].join(' | '));
}
if (out) {
  await writeFile(out, `${JSON.stringify({ kind: 'uvce-stage-timing', date: new Date().toISOString(), glRenderer, chromiumArgs: swiftshader ? SWIFTSHADER_ARGS : [], query, compare, counts, runs, rows }, null, 2)}\n`);
  console.log(`[bench:stages] wrote ${out}`);
}
