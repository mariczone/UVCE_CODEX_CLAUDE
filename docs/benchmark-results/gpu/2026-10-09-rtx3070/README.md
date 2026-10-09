# First hardware-GPU run — 2026-10-09, NVIDIA GeForce RTX 3070

- **Code:** commit `20d819a`. The tree was dirty only because of an uncommitted one-line fix in
  `tools/uvce/generate-fixtures.ts`: the main-module check never matched on Windows, so fixtures were not generated.
  That file is a build tool and does not affect runtime code. Manifest `m-a0bb3a7620c3dba0`, identical to the cloud runs.
- **GL:** `ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)`, real GPU.
- **Host:** Windows 11 (10.0.26200), AMD Ryzen 5 5600 (6 cores / 12 threads), Chromium 141.0.7390.37, Node 24.18.0.
  `crossOriginIsolated` was true and timer queries were available.
- **Protocol:** [baseline protocol](../../baseline/README.md), run with `--gpu --headed`. Headless Chromium fell back to
  SwiftShader on this machine even with `--gpu`, so that first headless run was discarded and not kept.
- **Files:** [`summary.json`](summary.json), [`summary.csv`](summary.csv), `scene-*.png`, [`stages.json`](stages.json).
  The `mips=0` run is in [`../2026-10-09-rtx3070-nomips/`](../2026-10-09-rtx3070-nomips/).

## Frame loop (medians of 3 runs, ms)

| Characters | Draw calls | CPU total p50 / p95 | CPU total p50 / p95 with `mips=0` | rAF interval p50 / p95 | GPU timer p50 (mips / `mips=0`) |
|---:|---:|---|---|---|---|
| 1 | 16 | 0.47 / 0.66 | 0.37 / 0.51 | 16.68 / 16.70 | 0.10 / 0.69 |
| 20 | 149 | 1.01 / 1.30 | 1.01 / 1.32 | 16.68 / 16.72 | 1.69 / 1.91 |
| 100 | 712–714 | 3.71 / 4.38 | 3.03 / 4.24 | 16.68 / 16.73 | 13.73 / 3.43 |
| 300 | 2,106–2,108 | 8.56 / 11.21 | 7.71 / 12.47 | 16.68 / 16.72 | 12.56 / 12.86 |

- **The display rate held at all counts.** The rAF interval stays at 16.7 ms (60 Hz vsync) up to 300 characters, so no
  frame budget was missed in this scene. This says nothing about headroom above 60 Hz.
- **Main-thread CPU per frame** is 0.5 ms at 1 character and 8.6 ms at 300. About 90 % of it is `three.render()`
  submission: at 300 characters, update takes 0.87 ms and submit 7.72 ms. That is roughly 7 draw calls per
  character, which makes batching (Milestone 3) the obvious next lever.
- **Mipmaps:** with `mips=0` the CPU total is 0.1–0.9 ms lower at 1, 100 and 300 characters and equal at 20. The
  per-run spread is about 1.5 ms at 300 characters (the per-run values are in the terminal log, not in
  `summary.json`), so at 1–300 characters the difference is within noise. Memory estimate: 8.08 MiB with mip chains,
  6.06 MiB without.
- **GPU timer values** are the disjoint timer query around `render()`. They are noisy across scenes: the
  100-character run with mips reads higher than the 300-character run, and the 100-character runs give 13.7 ms with
  mips vs 3.4 ms without. Do not treat a single cell as a measurement of mip cost. The raster times below are
  consistently below 1 ms.

## Stage timing (`bench:stages`, stepped frames, p50 ms, median of 2 runs)

| Characters | Mode | pump | world | prepare | submit | raster wait |
|---:|---|---:|---:|---:|---:|---:|
| 1 | full | 0.005 | 0.018 | 0.032 | 0.125 | 0.543 |
| 20 | full | 0.007 | 0.022 | 0.068 | 0.415 | 0.675 |
| 100 | full | 0.009 | 0.035 | 0.257 | 1.829 | 0.838 |
| 300 | full | 0.010 | 0.055 | 0.614 | 5.189 | 0.827 |
| 300 | scissor1px | 0.010 | 0.052 | 0.631 | 5.240 | 0.739 |

- The raster wait (rasterisation + readback latency) stays below 1 ms even at 300 characters, and full-size vs 1-px
  scissor differs by only about 0.1 ms. On this GPU the scene is bound by **CPU submission**, not by fill rate.
- Compared with the SwiftShader runs, `prepare` is about 2× faster and submit about 2× faster. Raster drops from
  112–185 ms to under 1 ms, which confirms that the cloud raster and timer numbers were pure software rasterisation.
- No M0 A/B was run on this GPU (optional step in the checklist).

## Manual browser pass (checklist §3)

Same machine, `pnpm dev` in Chrome/Edge: the owner went through all 14 items and reported no problems (directions
and orbit, swaps, layer toggles, overlay, crowds, GPU detection, context-loss button, `budgetMiB=1` evictions,
crossing / arch / glass scenes, `mips=0` comparison, no console errors).
