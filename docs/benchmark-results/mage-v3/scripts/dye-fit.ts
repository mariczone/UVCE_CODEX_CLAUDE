/**
 * Can a variant (body_navy, hair_long_auburn) be produced from a base image by a shader dye instead of its own pixels?
 * For every frame pair (same path in base and variant item):
 *   - changed = pixels whose RGB differs by > 2 (alpha must be equal for a dye to work at all)
 *   - model A "LUT": global RGB -> RGB map learned from all pairs (palette swap); error = pixels the map gets wrong
 *   - model B "mask x luminance x tint": changed pixels get variant = tint(L) where L = base luminance, tint = a
 *     per-channel piecewise-linear ramp (16 bins) fitted on all pairs; error = abs channel error on changed pixels
 * Reports per variant: changed share, alpha mismatches, LUT conflicts, ramp error mean / p95 / max.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng } from 'file:///C:/Project/UVCE_CODEX_CLAUDE/tools/uvce/png.ts';

const SRC = 'C:/Project/UVCE_CODEX_CLAUDE/bench-data/mage-v3/source';

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile() && e.name.endsWith('.png')) out.push(join(e.parentPath, e.name).slice(dir.length + 1).replaceAll('\\', '/'));
  return out.sort();
}

/** Hue group of a source colour (12 x 30 degrees; greys = 12): stands in for a dye mask with several channels. */
function hueGroup(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < 24) return 12;
  let h = mx === r ? (g - b) / (mx - mn) : mx === g ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn);
  h = (h * 60 + 360) % 360;
  return Math.floor(h / 30);
}

function fit(samples: { L: number; v: [number, number, number]; g: number }[], BINS: number, grouped: boolean, name: string, px: number, changed: number): void {
  const key = (s: { L: number; g: number }): number => (grouped ? s.g * BINS : 0) + Math.min(BINS - 1, Math.floor((s.L / 256) * BINS));
  const acc = new Map<number, number[]>();
  for (const s of samples) { const t = acc.get(key(s)) ?? [0, 0, 0, 0]; t[0] += s.v[0]; t[1] += s.v[1]; t[2] += s.v[2]; t[3] += 1; acc.set(key(s), t); }
  const errs = samples.map((s) => { const t = acc.get(key(s)) as number[]; return Math.max(Math.abs(t[0] / t[3] - s.v[0]), Math.abs(t[1] / t[3] - s.v[1]), Math.abs(t[2] / t[3] - s.v[2])); }).sort((a, b) => a - b);
  const q = (x: number): number => errs[Math.min(errs.length - 1, Math.floor(x * errs.length))] ?? 0;
  console.log(`  ${name}: ramp ${BINS} bins${grouped ? ' x hue groups (multi-channel mask)' : ''}: error on changed px mean ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(1)}, p95 ${q(0.95).toFixed(0)}, p99 ${q(0.99).toFixed(0)}, max ${q(1).toFixed(0)}; groups used ${new Set(samples.map((s) => s.g)).size}`);
}

async function compare(base: string, variant: string, layers: string[]): Promise<void> {
  const rel = (await files(join(SRC, variant))).filter((f) => layers.some((l) => f.startsWith(`${l}/`)));
  let px = 0;
  let changed = 0;
  let alphaMismatch = 0;
  const lut = new Map<number, Map<number, number>>();
  const samples: { L: number; v: [number, number, number]; g: number }[] = [];
  for (const f of rel) {
    const a = decodePng(await readFile(join(SRC, base, f))).image;
    const b = decodePng(await readFile(join(SRC, variant, f))).image;
    for (let i = 0; i < a.data.length; i += 4) {
      const aa = a.data[i + 3] as number;
      const ba = b.data[i + 3] as number;
      if (aa === 0 && ba === 0) continue;
      px++;
      if (Math.abs(aa - ba) > 2) {
        alphaMismatch++;
        continue;
      }
      const ar = a.data[i] as number, ag = a.data[i + 1] as number, ab = a.data[i + 2] as number;
      const br = b.data[i] as number, bg = b.data[i + 1] as number, bb = b.data[i + 2] as number;
      const keyA = (ar << 16) | (ag << 8) | ab;
      const keyB = (br << 16) | (bg << 8) | bb;
      const m = lut.get(keyA) ?? new Map<number, number>();
      m.set(keyB, (m.get(keyB) ?? 0) + 1);
      lut.set(keyA, m);
      if (Math.max(Math.abs(ar - br), Math.abs(ag - bg), Math.abs(ab - bb)) > 2) {
        changed++;
        samples.push({ L: 0.2126 * ar + 0.7152 * ag + 0.0722 * ab, v: [br, bg, bb], g: hueGroup(ar, ag, ab) });
      }
    }
  }
  // LUT: pixels not explained by the most frequent target of their source colour.
  let lutWrong = 0;
  for (const m of lut.values()) {
    const counts = [...m.values()];
    lutWrong += counts.reduce((s, c) => s + c, 0) - Math.max(...counts);
  }
  // Ramp: 16 luminance bins, per-channel mean target per bin, linear between bin centres.
  for (const [BINS, grouped] of [[16, false], [64, false], [64, true]] as const) fit(samples, BINS, grouped, ``, px, changed);
  return;
  const BINS = 16;
  const sum = Array.from({ length: BINS }, () => [0, 0, 0, 0]);
  for (const s of samples) {
    const k = Math.min(BINS - 1, Math.floor((s.L / 256) * BINS));
    const t = sum[k] as number[];
    t[0] = (t[0] as number) + s.v[0];
    t[1] = (t[1] as number) + s.v[1];
    t[2] = (t[2] as number) + s.v[2];
    t[3] = (t[3] as number) + 1;
  }
  const ramp = sum.map((t) => ((t[3] as number) > 0 ? [(t[0] as number) / (t[3] as number), (t[1] as number) / (t[3] as number), (t[2] as number) / (t[3] as number)] : null));
  const errs: number[] = [];
  for (const s of samples) {
    const k = Math.min(BINS - 1, Math.floor((s.L / 256) * BINS));
    const r = ramp[k] as number[];
    errs.push(Math.max(Math.abs((r[0] as number) - s.v[0]), Math.abs((r[1] as number) - s.v[1]), Math.abs((r[2] as number) - s.v[2])));
  }
  errs.sort((x, y) => x - y);
  const pct = (q: number): number => errs[Math.min(errs.length - 1, Math.floor(q * errs.length))] ?? 0;
  console.log(
    `${variant} vs ${base} (${rel.length} frames): visible px ${px}, changed ${(100 * changed / px).toFixed(1)} %, alpha mismatch ${alphaMismatch}, ` +
      `LUT wrong ${(100 * lutWrong / px).toFixed(2)} % of px, ramp error on changed px: mean ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(1)}, p95 ${pct(0.95).toFixed(0)}, max ${pct(1).toFixed(0)} (8-bit)`,
  );
}

await compare('body_base', 'body_navy', ['body']);
await compare('hair_long_brown', 'hair_long_auburn', ['hair_back', 'hair_front']);
await compare('hair_long_brown', 'hair_01', ['hair_back', 'hair_front']).catch((e: unknown) => console.log(`hair_01: ${(e as Error).message}`));
