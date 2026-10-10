/** Aggregates the 2026-10-10 GPU matrix: per dataset, mode, count -> median over the ABBA sessions of each mode. */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'C:/Project/UVCE_CODEX_CLAUDE/docs/benchmark-results/gpu/2026-10-10-mage-v3';
type Sc = Record<string, unknown> & { count: number };
const med = (v: number[]): number => {
  const s = [...v].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const g = (o: unknown, path: string): number => {
  let v: unknown = o;
  for (const k of path.split('.')) v = v === null || v === undefined ? undefined : (v as Record<string, unknown>)[k];
  return typeof v === 'number' ? v : Number.NaN;
};
const rows: Record<string, unknown>[] = [];
let env: unknown = null;
for (const ds of await readdir(BASE)) {
  const sessions = (await readdir(join(BASE, ds))).sort();
  const byMode = new Map<string, { sessions: string[]; scenarios: Sc[][] }>();
  for (const s of sessions) {
    const j = JSON.parse(await readFile(join(BASE, ds, s, 'summary.json'), 'utf8')) as { scenarios: Sc[]; environment: unknown; commit: string; workingTree: string };
    env ??= { ...(j.environment as object), commit: j.commit, workingTree: j.workingTree };
    const mode = s.replace(/^\d+-/, '');
    const e = byMode.get(mode) ?? { sessions: [], scenarios: [] };
    e.sessions.push(s);
    e.scenarios.push(j.scenarios);
    byMode.set(mode, e);
  }
  for (const [mode, e] of byMode) {
    for (const count of [1, 20, 100, 300]) {
      const scs = e.scenarios.map((list) => list.find((x) => x.count === count)).filter((x): x is Sc => x !== undefined);
      const m = (p: string): number => med(scs.map((x) => g(x, p)));
      const per = (p: string): number[] => scs.map((x) => g(x, p));
      rows.push({
        dataset: ds, mode, count, sessions: e.sessions,
        cpuTotalP50: m('cpuTotalMs.p50'), cpuTotalP95: m('cpuTotalMs.p95'), cpuTotalP50PerSession: per('cpuTotalMs.p50'),
        cpuUpdateP50: m('cpuUpdateMs.p50'), cpuSubmitP50: m('cpuRenderSubmitMs.p50'),
        rafP50: m('rafIntervalMs.p50'), rafP95: m('rafIntervalMs.p95'), gpuTimerP50: m('gpuTimerQueryMs.p50'),
        drawCalls: m('drawCalls'), residentPages: m('residentPages'), residentGpuMiB: m('residentGpuEstimateMiB'), frameCacheMiB: m('frameCacheMiB'),
        downloadedKiB: m('downloadedAssetKiB'), cacheHitRatio: m('cacheHitRatio'), cachedCharacters: m('cachedCharacters'), compositedCharacters: m('compositedCharacters'),
      });
    }
  }
}
await writeFile(join(BASE, 'aggregate.json'), `${JSON.stringify({ environment: env, method: 'median over the sessions of each mode (ABBA order: 2 sessions per mode; each session = median of 2 runs, 10 s windows)', rows }, null, 2)}\n`);
const f = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '–');
console.log('dataset | mode | n | CPU p50 | CPU p95 | update | submit | rAF p50 | rAF p95 | GPU timer | draws | pages | resident MiB | frame cache MiB');
for (const r of rows) console.log(`${r.dataset} | ${r.mode} | ${r.count} | ${f(r.cpuTotalP50)} | ${f(r.cpuTotalP95)} | ${f(r.cpuUpdateP50)} | ${f(r.cpuSubmitP50)} | ${f(r.rafP50)} | ${f(r.rafP95)} | ${f(r.gpuTimerP50)} | ${f(r.drawCalls, 0)} | ${f(r.residentPages, 0)} | ${f(r.residentGpuMiB)} | ${f(r.frameCacheMiB)}`);
