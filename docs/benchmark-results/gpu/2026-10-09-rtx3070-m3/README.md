# LAYERED vs SHADER on the RTX 3070 — 2026-10-09

- **Code:** commit `abd4261` (M3 SHADER mode), the same build for both modes. `layered/summary.json` records a clean
  tree. `shader/summary.json` says `dirty` only because the LAYERED results written just before it were untracked
  files; no source file differed.
- **Setup:** Windows 11, AMD Ryzen 5 5600, Chromium 141 headed, `ANGLE (NVIDIA GeForce RTX 3070 Direct3D11)`, baseline
  protocol (1920x1080, MSAA, seed 20261009, 3 runs × 15 s per count). The runs were back to back, LAYERED first; the
  stage timings were run right after.
- **Files:** `layered/`, `shader/` (`summary.json`, `summary.csv`, `scene-*.png`), `stages-layered.json`,
  `stages-shader.json`.

## Frame loop (median of 3 runs)

| Characters | Draw calls LAYERED → SHADER | CPU total p50 | CPU total p95 | CPU submit p50 | rAF p50 |
|---:|---|---|---|---|---|
| 1 | 16 → 9 | 0.43 → 0.39 ms | 0.60 → 0.58 ms | 0.32 → 0.30 ms | 16.7 / 16.7 |
| 20 | 149 → 47 | 1.20 → 0.71 ms | 1.99 → 1.00 ms | 0.97 → 0.50 ms | 16.7 / 16.7 |
| 100 | 712 → 207 | 4.14 → 1.86 ms | 5.80 → 2.27 ms | 3.61 → 1.41 ms | 16.7 / 16.7 |
| 300 | 2,108 → 606 | 10.48 → 4.31 ms | 14.30 → 5.16 ms | 9.34 → 3.40 ms | 16.7 / 16.7 |

The per-run values at 300 characters do not overlap: LAYERED 9.87 / 10.47 / 11.44 ms, SHADER 4.31 / 4.17 / 4.44 ms.
Draw calls are 2 per character (composite + shadow) plus the world. Both modes hold 60 Hz at every count, so the gain
is CPU headroom, not a visible frame-rate change on this machine.

## Stage timing (`bench:stages`, stepped frames, p50 ms, median of 3 runs, full viewport)

| Characters | prepare L → S | submit L → S | raster wait L → S |
|---:|---|---|---|
| 1 | 0.035 → 0.060 | 0.145 → 0.230 | 0.61 → 0.83 |
| 20 | 0.100 → 0.100 | 0.525 → 0.313 | 0.78 → 0.79 |
| 100 | 0.320 → 0.340 | 2.070 → 1.228 | 0.86 → 1.23 |
| 300 | 0.762 → 0.710 | 6.185 → 2.637 | 0.75 → 1.43 |

- **Submit** drops 41–57 % from 20 characters up. That is the measured bottleneck from the first GPU run.
- **The GPU pays for it:** the raster wait grows by about 0.4–0.7 ms at 100–300 characters, because every composite
  pixel samples up to 8 textures. That is far below the CPU saved (3.5 ms at 300 characters), but on a weak iGPU
  this trade-off can reverse. It has to be measured there before SHADER becomes the default.
- At 1 character SHADER is not faster in isolation (fixed per-draw overhead dominates); in the frame loop the two are
  within noise.
- GPU timer-query values (in `summary.json`) are noisy across scenes, as in the first run, and are not used here.

## Visual equivalence

- **Pixel-exact parity scenes:** all 10 SHADER cases have 0 pixels beyond ±3/255 against the CPU reference (max delta
  1). The CI suite now runs them (`tests/e2e/parity.spec.ts`, "SHADER mode parity").
- **Stage scene** (linear filtering + mipmaps, perspective camera), compared directly with LAYERED (headless
  SwiftShader, `test=1`): 1 character max delta 6 (95 px beyond ±3 of 676,800); 20: max 9; 300: 3,137 px beyond ±3
  (0.46 %), 306 beyond ±10, max 41. The differences come from three sources: (1) LAYERED rounds to 8 bits after
  every layer, SHADER once; (2) the rasterizer snaps quad edges to 1/256 px while the shader masks in float, which
  shows at layer edges when coarse mip levels have blurred content into the gutter; (3) ties at exact texel
  boundaries with nearest filtering. Neither mode is more correct. Side-by-side crops are indistinguishable.

## Verdict

SHADER wins on this GPU for every crowd size from 20 characters up, with no correctness regression. Following the
blueprint ("modes that lose stay disabled by default"), it ships behind `mode=SHADER`. The recommendation is to make
it the default after one more device (e.g. a laptop iGPU) confirms that the extra fragment cost does not reverse the
result.
