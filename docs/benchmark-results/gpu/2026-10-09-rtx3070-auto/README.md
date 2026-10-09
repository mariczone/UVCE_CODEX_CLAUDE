# AUTO (adaptive planner) vs SHADER — RTX 3070, 2026-10-09

- **Code:** commit `66ea210` (planner with peak-concurrency capacity). Each run recorded a clean tree.
  `first-planner/` holds the summaries of the first planner version (commit `0137ffd`, window-total capacity); 4 of
  those 6 runs recorded `dirty` because `docs/UVCE_ARCHITECTURE_DECISIONS.md` was edited while they ran (only a doc;
  the app had been built from `0137ffd` before the first run).
- **Setup:** Windows 11, Ryzen 5 5600, Chromium 141 headed, ANGLE D3D11 on the RTX 3070, 1920×1080, baseline protocol;
  SHADER and AUTO were run back to back for each workload.
- **Files:** `auto-<workload>-<mode>/summary.json|csv`, plus `scene-300.png` for the AUTO runs.

## Result (CPU per frame, median of 3 runs)

| Workload | Characters | SHADER p50 / p95 | AUTO p50 / p95 | AUTO vs SHADER | AUTO cached / composited | AUTO hit ratio |
|---|---:|---|---|---:|---|---:|
| random | 100 | 1.76 / 2.23 | 1.97 / 2.46 | +12 % | 8 / 92 | 1.00 |
| random | 300 | 4.45 / 5.42 | 5.11 / 5.91 | +15 % | 52 / 248 | 0.86 |
| looks=8 | 100 | 1.63 / 2.06 | 1.69 / 2.10 | +4 % | 99 / 1 | 0.91 |
| looks=8 | 300 | 4.27 / 4.96 | 4.78 / 5.86 | +12 % | 114 / 186 | 0.92 |
| looks=8, sync | 100 | 1.66 / 2.32 | 1.81 / 2.78 | +9 % | 99 / 1 | 0.79 |
| looks=8, sync | 300 | 4.17 / 5.34 | **4.00** / 6.13 | **−4 %** | 279 / 21 | 0.85 |

Per-run CPU p50 at 300 characters: random SHADER 4.44 / 4.44 / 4.60 vs AUTO 5.11 / 5.05 / 5.12; looks=8 SHADER
4.27 / 4.26 / 4.28 vs AUTO 4.78 / 4.91 / 4.54; formation SHADER 4.36 / 4.17 / 4.08 vs AUTO 4.30 / 3.94 / 4.00. The
random and looks=8 gaps are outside the run-to-run spread; the formation win is at its edge.

The first planner version cached only 38 of 300 characters in the formation crowd (4.49 vs 3.78 ms, +19 %). Its
capacity estimate counted every frame of the window, which is about 7× the frames needed at once. That was fixed in
`66ea210`, and the fix raised it to 279 cached.

## Why AUTO does not pay off on this machine

- This RTX 3070 setup is **CPU-submission bound**: the GPU finishes a 300-character frame in ~1.4 ms. FULL_CACHE draws
  exactly as many quads as SHADER (one per character), so its gain is GPU-side (1 texture sample per pixel instead of
  up to 8), and that is not the bottleneck here.
- AUTO's own cost is on the CPU: a frame-key string and planner bookkeeping for every character every frame, plus
  bakes whenever a cached group reaches new animation frames. Where the submit time drops (e.g. formation 3.46 →
  2.81 ms), the saving exists, but only the formation crowd has enough reuse to outweigh the overhead.
- Deciding by hit ratio alone is therefore not enough. The planner also needs to know whether the GPU is the
  bottleneck. This machine's GPU timer queries are too noisy to give that signal reliably (see the first GPU run).

## Decision

- **SHADER stays the default; AUTO stays opt-in** (`mode=AUTO`). Per the blueprint, a mode that loses stays off by
  default.
- The planner remains in place and fully tested (hysteresis, capacity, demotion, context loss). Next step for it: a
  GPU-bound signal (e.g. frame interval over budget while CPU time is under it), so it only reaches for the cache
  where fill rate is the limit. Then measure on a fill-limited GPU (iGPU) with this exact matrix.
