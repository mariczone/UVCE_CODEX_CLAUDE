# Pending runs: 4K stress and the FULL_CACHE matrix — RTX 3070, 2026-10-09

- **Code:** commit `b095d36` for every run, each run recording a clean tree (outputs were written outside the repo and
  copied in afterwards).
- **Setup:** Windows 11, Ryzen 5 5600, Chromium 141 headed, `ANGLE (NVIDIA GeForce RTX 3070 Direct3D11)`, baseline
  protocol (3 runs × 15 s per count, medians). The 11 runs ran back to back from 19:31 to 19:55 local time, unattended.
- **Files:** one folder per run with `summary.json` and `summary.csv`. To save space, screenshots were kept only for
  the 4K runs and the FULL_CACHE runs (`scene-300.png`).

## 1. 4K (3840×2160): LAYERED vs SHADER

Four times the pixels of the 1080p runs, as a proxy for a GPU with less fill rate.

| Characters | Draw calls L → S | CPU total p50 L → S | CPU total p95 L → S | rAF p50 L → S | rAF p95 L → S |
|---:|---|---|---|---|---|
| 1 | 16 → 9 | 0.54 → 0.37 ms | 0.77 → 0.53 | 16.7 → 16.7 | 16.8 → 16.7 |
| 20 | 149 → 47 | 1.45 → 0.75 ms | 1.95 → 0.99 | 16.7 → 16.7 | 16.7 → 16.7 |
| 100 | 714 → 207 | 4.21 → 1.96 ms | 5.68 → 2.54 | 16.7 → 16.7 | 16.7 → 16.7 |
| 300 | 2,110 → 606 | 11.77 → 4.71 ms | 16.23 → 5.59 | 16.7 → 16.7 | 16.8 → 16.7 |

- SHADER keeps its CPU advantage at 4K (about 2.5× at 300 characters).
- At 4× the pixels, the extra per-pixel work of SHADER did not cost a single frame: the rAF interval stays at
  16.7 ms (60 Hz) for both modes at every count. LAYERED's p95 at 300 characters (16.23 ms CPU) is already close to
  the frame budget, while SHADER's is 5.59 ms.
- **Limit of this proxy:** it shows the RTX 3070 has plenty of fill headroom. It does not show that an iGPU has.
  Measuring a real iGPU is still open.

## 2. FULL_CACHE matrix (1920×1080)

| Workload | Characters | Mode | Draw calls | CPU total p50 / p95 (ms) | submit p50 | cached / composited | hit ratio | breaker pauses |
|---|---:|---|---:|---|---:|---|---:|---:|
| random | 100 | LAYERED | 712 | 3.75 / 4.58 | 3.29 | | | |
| random | 100 | SHADER | 207 | **1.75** / 2.13 | 1.36 | 0 / 100 | | |
| random | 100 | FULL_CACHE | 207 | 1.95 / 2.36 | 1.13 | 92 / 8 | 0.73 | 1 |
| random | 300 | LAYERED | 2,108 | 9.53 / 11.38 | 8.50 | | | |
| random | 300 | SHADER | 606 | **4.46** / 5.28 | 3.58 | 0 / 300 | | |
| random | 300 | FULL_CACHE | 606 | 4.87 / 6.12 | 3.58 | 49 / 251 | 0.16 | 4 |
| looks=8 | 100 | LAYERED | 697 | 3.73 / 4.97 | 3.28 | | | |
| looks=8 | 100 | SHADER | 207 | **1.95** / 2.65 | 1.48 | 0 / 100 | | |
| looks=8 | 100 | FULL_CACHE | 207 | 2.00 / 2.52 | 1.17 | 91 / 9 | 0.79 | 0 |
| looks=8 | 300 | LAYERED | 2,091 | 10.44 / 12.97 | 9.36 | | | |
| looks=8 | 300 | SHADER | 606 | **4.72** / 5.97 | 3.75 | 0 / 300 | | |
| looks=8 | 300 | FULL_CACHE | 606 | 4.90 / 5.84 | 3.65 | 67 / 233 | 0.22 | 4 |
| looks=8, sync | 100 | LAYERED | 697 | 3.79 / 5.26 | 3.37 | | | |
| looks=8, sync | 100 | SHADER | 207 | 2.00 / 2.87 | 1.57 | 0 / 100 | | |
| looks=8, sync | 100 | FULL_CACHE | 207 | **1.91** / 2.96 | 1.23 | 85 / 15 | 0.68 | 0 |
| looks=8, sync | 300 | LAYERED | 2,091 | 9.76 / 12.32 | 8.90 | | | |
| looks=8, sync | 300 | SHADER | 606 | 4.58 / 6.55 | 3.77 | 0 / 300 | | |
| looks=8, sync | 300 | FULL_CACHE | 606 | **4.30** / 6.25 | 3.04 | 300 / 0 | 0.98 | 0 |

Cached / composited, hit ratio and pauses are taken from the last frame of each window (median of 3 runs). The rAF
interval was 16.7 ms everywhere. The FULL_CACHE cache stayed at its 64 MiB budget (3 pages).

### Reading

- **Both SHADER and FULL_CACHE beat LAYERED by 1.9–2.3× (CPU p50) in every workload.** The win comes from 606 instead of about
  2,100 draw calls; both draw one quad per character.
- **FULL_CACHE vs SHADER is close on this GPU:**
  - It wins only where frames repeat. In the formation crowd (8 looks, synchronized) at 300 characters the cache hit
    ratio is 0.98, all 300 characters draw from the cache, and CPU p50 is 4.30 vs 4.58 ms (−6 %), with submit
    3.04 vs 3.77 ms.
  - Everywhere else it is 3–11 % slower than SHADER (random: +11 % at 100, +9 % at 300; looks=8: +3 % at 100,
    +4 % at 300). At 300 characters the working set does not fit (hit ratio 0.16–0.22), so the thrash breaker paused
    baking 4 times per run, as designed. What remains is the bake cost in the windows between pauses. At 100
    characters the hit ratio is 0.73–0.79, but baking the misses still costs more than it saves.
  - The run-to-run spread is about ±5–10 %, so the smaller differences are at the edge of the noise. The direction
    matches the hit ratios.
- **Why FULL_CACHE doesn't win more here:** its advantage is GPU-side (1 texture sample per pixel instead of up to
  8), and this GPU isn't the bottleneck. On the CPU side both modes issue the same draw count. FULL_CACHE's possible
  gain is therefore on GPUs with little fill rate, which this machine cannot show.

## 3. Decisions

1. **SHADER is the best general mode on this machine:** fastest or tied in every workload, at 1080p and at 4K, with
   no cache memory. Recommendation: make SHADER the default, keeping LAYERED as the automatic fallback. Not applied
   yet: it is the owner's call, and it should ideally be confirmed on an iGPU first.
2. **FULL_CACHE stays opt-in.** It is worth choosing only for crowds where frames repeat (shared looks and synchronized
   animation, idle crowds), or on fill-limited GPUs. That makes it a planner decision per group of characters, not a
   global default.
3. **The adaptive planner** should start with SHADER, switch a group to FULL_CACHE when its measured hit ratio stays
   high (≥ 0.9 here), and fall back on the breaker. These runs provide the thresholds.
