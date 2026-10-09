# M2 benchmark rerun and attribution — 2026-10-09

Same protocol as the [baseline](../../baseline/README.md) (production build, 1920x1080, MSAA, seed 20261009,
1/20/100/300 characters, 2 s warmup + 15 s window, 3 fresh contexts per count, medians of per-run percentiles) on
the same kind of container: headless **Chromium 141 + SwiftShader** (software GL), 4-core Xeon. **Nothing here is a
GPU measurement.** rAF intervals, timer queries and "raster" times measure CPU software rasterisation and appear
only to explain the CPU numbers.

| Folder / file | Build | What |
|---|---|---|
| [`../2026-10-09-pre-optimization/`](../2026-10-09-pre-optimization/) | `71d731a` (M2 as first committed) | first M2 run, the one that looked slower |
| `summary.json`, `summary.csv`, `scene-*.png` (this folder) | `2836d80` (M2 final) | bench:baseline protocol |
| [`../2026-10-09-nomips/`](../2026-10-09-nomips/) | `2836d80`, URL `mips=0` | same, mip chains off |
| [`../2026-10-09-m0-control/`](../2026-10-09-m0-control/) | `3db7a20` (the M0 baseline build) | M0 re-measured in the same session |
| `interleaved-raf-ab.json` | M0, M2, M2 `mips=0` | full rAF loop, variants alternated run by run |
| `stages.json`, `stages-mips0.json` | M0 vs M2 (vs M2 `mips=0`) | `pnpm bench:stages`: each stage of a frame timed in isolation |
| `stage-ab-before-fix.txt`, `submit-profile.txt` | — | raw logs of the two scratch experiments quoted below |

## Result

After commit `2836d80`, **Milestone 2 costs the same CPU time per frame as Milestone 0 within this machine's noise**:
the full frame loop, run interleaved, takes 4.05 ms (M0) vs 4.17 ms (M2) at 100 characters and 13.87 vs 13.68 ms at
300 (median of 3 runs; the run ranges overlap). Measured in isolation, M2's `prepareFrame` is 3–11 % cheaper than
M0's at 20–300 characters (0.01–0.02 ms dearer at 1 character); its `three.render()` call took 6–24 % longer at
100–300 characters in all three isolated comparisons of the final build — an open item (§4).

The first M2 run looked 27–63 % slower than the M0 baseline. Two causes, separated by the experiments below:

1. **Machine drift.** The unchanged M0 build measured 18–33 % slower in this session than in its own baseline run a
   few hours earlier, and kept drifting during the session. Only same-session comparisons are valid.
2. **Real per-frame bookkeeping in M2** (`prepareFrame` +64 % at 300 characters, isolated). It came from residency
   work done every frame for every character and layer, and was removed in `2836d80`:
   - pin diffs with `includes` replaced by identity checks on one frozen item array per appearance;
   - a `Map` lookup + LRU `touch()` per drawn layer replaced by an LRU stamp when a page loses its last pin;
   - `resolve()` reads the slot directly; handles are cached objects;
   - pending/failed counts cached per pose key instead of a page-state lookup per layer;
   - one prefetch per culling instead of one per culled character per frame;
   - painter sort without per-frame closures;
   - the per-layer generation audit runs only after a slot was freed (`handleEpoch`).

## 1. bench:baseline protocol, sequential runs

CPU total per frame, p50 (ms). The first and third columns were measured in earlier sessions.

| Characters | M0 baseline (05:15 UTC) | M0 control (07:09) | M2 pre-fix (06:23) | M2 final (07:13) | M2 final, `mips=0` (07:18) |
|---:|---:|---:|---:|---:|---:|
| 1 | 0.52 | 0.64 | 0.66 | 0.56 | 0.57 |
| 20 | 1.08 | 1.27 | 1.41 | 1.25 | 1.25 |
| 100 | 2.95 | 3.92 | 4.50 | 4.16 | 4.67 |
| 300 | 9.02 | 11.11 | 14.66 | 12.79 | 13.69 |

| p50 (ms) | M0 control update / submit | M2 final update / submit | M2 `mips=0` update / submit |
|---|---:|---:|---:|
| 1 | 0.18 / 0.45 | 0.20 / 0.37 | 0.18 / 0.35 |
| 20 | 0.35 / 0.92 | 0.37 / 0.86 | 0.39 / 0.85 |
| 100 | 1.03 / 2.88 | 1.00 / 3.08 | 1.09 / 3.41 |
| 300 | 2.20 / 8.49 | 2.69 / 10.01 | 2.82 / 10.76 |

Sequential runs only four minutes apart still drift (the M0 control's 300-character total was 11.1 ms at 07:09
and 12.5–14.4 ms at 07:33), so the 300-character gap in this table is not conclusive on its own. Hence §2.

## 2. Full frame loop, interleaved (`interleaved-raf-ab.json`)

Same protocol, but the three variants alternate run by run in rotated order (07:33–07:41 UTC).

| Characters | Variant | CPU total p50: median (runs) | update p50 | submit p50 | rAF p50 | SwiftShader timer p50 |
|---:|---|---|---:|---:|---:|---:|
| 100 | M0 `3db7a20` | **4.05** (3.69 / 4.19 / 4.05) | 1.00 | 2.83 | 150 | 126 |
| 100 | M2 final | **4.17** (4.17 / 4.49 / 3.83) | 1.04 | 3.06 | 167 | 129 |
| 100 | M2 final, `mips=0` | **4.50** (4.50 / 4.77 / 4.16) | 1.03 | 3.42 | 150 | 128 |
| 300 | M0 `3db7a20` | **13.87** (12.54 / 13.87 / 14.38) | 2.54 | 10.96 | 183 | 156 |
| 300 | M2 final | **13.68** (13.56 / 13.68 / 14.36) | 2.73 | 10.89 | 200 | 157 |
| 300 | M2 final, `mips=0` | **13.47** (13.47 / 13.83 / 12.92) | 2.71 | 10.19 | 183 | 150 |

No variant is distinguishable from another in the full loop: spreads within a variant (up to 1.8 ms at 300) exceed
the differences between medians.

## 3. Stage attribution (`pnpm bench:stages`, `stages.json`)

The rAF loop is stopped and frames are stepped by hand; a 1-px `readPixels` before and after each frame keeps
software rasterisation from running on the other cores while the CPU stages are timed. `scissor1px` clips
rendering to one pixel: same JavaScript and draw calls, almost no fill. Median of 2 interleaved runs per cell.

| Characters | Mode | prepare M0 → M2 | submit M0 → M2 | raster wait M0 → M2 |
|---:|---|---|---|---|
| 1 | full | 0.071 → 0.083 (+17 %) | 0.383 → 0.357 (−7 %) | 118.1 → 112.0 (−5 %) |
| 1 | scissor1px | 0.050 → 0.065 (+30 %) | 0.287 → 0.317 (+10 %) | 34.8 → 36.7 (+5 %) |
| 20 | full | 0.178 → 0.168 (−6 %) | 0.890 → 0.870 (−2 %) | 130.7 → 130.7 (0 %) |
| 20 | scissor1px | 0.148 → 0.144 (−3 %) | 0.688 → 0.760 (+10 %) | 39.6 → 39.6 (0 %) |
| 100 | full | 0.549 → 0.509 (−7 %) | 2.904 → 3.220 (+11 %) | 151.2 → 160.8 (+6 %) |
| 100 | scissor1px | 0.469 → 0.419 (−11 %) | 2.462 → 2.746 (+12 %) | 47.4 → 47.5 (0 %) |
| 300 | full | 1.214 → 1.154 (−5 %) | 9.798 → 11.920 (+22 %) | 169.6 → 185.1 (+9 %) |
| 300 | scissor1px | 1.095 → 1.041 (−5 %) | 7.895 → 9.807 (+24 %) | 61.3 → 62.8 (+2 %) |

The registry pump (`beginFrame`, M2 only) costs 0.015–0.025 ms per frame. Before the fix, the same split
(`stage-ab-before-fix.txt`, `71d731a` vs `3db7a20`) gave `prepareFrame` 0.90 → 1.47 ms at 300 characters (+64 %),
0.36 → 0.55 ms at 100 (+55 %) and 0.093 → 0.140 ms at 20 (+51 %).

## 4. Open item: `three.render()` in isolation

`submit` is 6–24 % higher for M2 at 100–300 characters in both isolated runs (with mips) and in a third run with
`mips=0` (`stages-mips0.json`, 3 runs: +7 / +11 % at 100, +6 / +15 % at 300, full / scissor) — so it is **not**
caused by mipmapping. A CPU profile of the stepped loop (`submit-profile.txt`, 300 characters, 1-px scissor,
2 × 80 frames per build) puts the extra time in **JavaScript** (693 / 636 ms → 769 / 907 ms of JS self time), not in
WebGL calls (≈ 58–78 ms for both builds) or command-buffer waits. The minified build hides which function; the
render path itself (`sprite-material.ts`, the stage, draw-call count 2,110) is unchanged since M0, and the textures
now come from `ImageBitmap`s instead of `<img>` elements. Next step if it persists on a GPU: profile unminified
builds of both versions. It is not visible in the full loop (§2).

## 5. Mipmaps

- **Raster:** trilinear sampling costs SwiftShader 6–9 % more raster time at 100–300 characters (§3); with
  `mips=0` the difference disappears (0 % at 100, −5 % at 300 in `stages-mips0.json`).
- **CPU:** no measurable effect on update or submit (§2, §4).
- **Memory:** 6.06 MiB of level-0 pages become an estimated 8.08 MiB on the GPU with chains (`mips=0`: 6.06 MiB).
- **On a GPU:** unknown until measured — `LOCAL_TEST_CHECKLIST.md` §2 runs both variants.

## 6. Loading and memory

| | M0 control | M2 final | M2 final, `mips=0` |
|---|---:|---:|---:|
| Page requests (1 character / all items) | 6 / 13 | 5 / 12 | 5 / 12 |
| Downloaded, all pages (Resource Timing) | 354.5 KiB | 356.4 KiB | 356.4 KiB |
| Resident level-0 RGBA8, all pages | 4.58 MiB | 6.06 MiB | 6.06 MiB |
| Resident GPU estimate incl. mip chains | 4.58 MiB (no mips) | 8.08 MiB | 6.06 MiB |
| Time to ready, 1 / 300 characters | 329 / 478 ms | 322 / 693 ms | 334 / 700 ms |

Level-0 bytes grew 32 % because of the 2^L alignment and gutters (ADR-06). Time to ready at 300 characters is
45 % longer: uploads are deliberately limited to 2 pages per frame (no hitch when equipment changes), and on
SwiftShader a 300-character frame is slow, so the 12 initial uploads take several slow frames; it is the same with
`mips=0`, so mip generation is not the cause. A per-frame time budget for uploads would adapt to the frame rate.

## Reproduce

```bash
pnpm build
pnpm bench:baseline -- --out <dir>                       # M2 final
pnpm bench:baseline -- --query "&mips=0" --out <dir>     # mips off
git worktree add ../uvce-m0 3db7a20 && (cd ../uvce-m0 && pnpm install --frozen-lockfile && pnpm build)
(cd ../uvce-m0 && node tools/uvce/run-baseline-benchmark.ts --out <dir>)   # M0 control, same session
pnpm bench:stages -- --compare ../uvce-m0/dist --out stages.json
pnpm bench:stages -- --compare ../uvce-m0/dist --query "&mips=0" --counts 100,300 --runs 3 --out stages-mips0.json
```

The interleaved rAF A/B and the CPU profile were scratch scripts driving the same test API (`__UVCE__.snapshot()`
under the bench:baseline protocol; Chrome DevTools Protocol `Profiler` for the profile); their raw outputs are in
this folder. The compared build's label in `stages*.json` was edited from a local worktree path to
`3db7a20 (M0 build in a git worktree)`.
