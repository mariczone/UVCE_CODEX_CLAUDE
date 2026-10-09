# Baseline run 2026-10-09 (LAYERED renderer)

- **Commit:** `3db7a20` (clean working tree) · assets `m-54f938e6dbf5917a` · seed 20261009
- **Browser:** headless Chromium 141.0.7390.37 (Playwright 1.56.1), `crossOriginIsolated = true`
- **GL:** `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)` — **software rasterizer**
- **Host:** Linux container, Intel Xeon @ 2.10 GHz × 4 cores, 15.7 GiB RAM, no GPU · Node 22.22.0
- **Protocol:** see [`../README.md`](../README.md) (1920x1080, DPR 1, 2 s warmup, 15 s window, 3 runs, medians)
- Raw data: [`summary.json`](summary.json), [`summary.csv`](summary.csv); screenshots `scene-<count>.png`.
- **Later note:** this exact build re-measured 18–33 % slower in a later session on the same container type (machine
  drift). Use these numbers only for comparisons made in this run; the M2 comparison uses a same-session M0
  control instead: [`../../m2/2026-10-09/`](../../m2/2026-10-09/README.md).

## Main-thread CPU cost per frame (milliseconds, median of 3 runs)

| Visible chars | Layers drawn | Draw calls | Update p50 / p95 | Submit p50 / p95 | **Total p50 / p95 / p99** | Frames per run |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 8 | 16 | 0.145 / 0.255 | 0.365 / 1.245 | **0.515 / 1.700 / 5.865** | 142–145 |
| 20 | 123 | 150 | 0.300 / 0.410 | 0.750 / 1.600 | **1.080 / 1.985 / 3.895** | 129–135 |
| 100 | 611 | 718 | 0.820 / 1.210 | 2.115 / 6.880 | **2.950 / 7.890 / 9.095** | 110–115 |
| 300 | 1,804 | 2,110 | 1.950 / 3.705 | 6.835 / 13.775 | **9.015 / 15.910 / 18.505** | 91–95 |

Draw calls = one per drawn layer + one ground-shadow decal per character + the visible world meshes.

## Assets (cold cache, localhost)

| Visible chars | Requests (manifest + pages) | Transferred | Resident source pages (RGBA8 estimate) | Time to ready |
|---:|---:|---:|---:|---:|
| 1 | 1 + 6 | 271.9 KiB | 6 pages, 3.46 MiB | 268 ms |
| 20 | 1 + 13 | 354.5 KiB | 13 pages, 4.58 MiB | 316 ms |
| 100 | 1 + 13 | 354.5 KiB | 13 pages, 4.58 MiB | 335 ms |
| 300 | 1 + 13 | 354.5 KiB | 13 pages, 4.58 MiB | 443 ms |

Each page was requested exactly once, whatever the crowd size: 300 characters with 149 distinct looks share the
same 13 per-item pages.

## Software-rasterizer timings — NOT GPU performance

Recorded for completeness only. They measure SwiftShader rasterising a 1920x1080 MSAA frame on the CPU and say
nothing about how a real GPU would perform.

| Visible chars | rAF interval p50 / p95 (ms) | Timer-query p50 / p95 (ms, SwiftShader) |
|---:|---:|---:|
| 1 | 100.0 / 183.3 | 75.6 / 88.6 |
| 20 | 116.7 / 200.0 | 84.2 / 104.8 |
| 100 | 133.3 / 233.3 | 104.2 / 129.1 |
| 300 | 150.0 / 300.0 | 130.6 / 158.4 |

## Observations (hypotheses for later milestones, not claims)

- Main-thread cost grows roughly linearly with drawn layers (≈ 0.03 ms per character at p50 between 1 and 300),
  and render submission dominates it (6.8 of the 9.0 ms median at 300 characters), which points at draw-call batching inside
  painter-safe runs (blueprint §4.4) as the first thing to try in Milestone 3 — to be proven with the same
  protocol and the parity tests.
- The 300-character p95/p99 spikes need a hardware-GPU run to separate main-thread work from command-buffer
  back-pressure caused by the software rasterizer.
- Hardware numbers must come from `pnpm bench:baseline -- --gpu` on a documented workstation.
