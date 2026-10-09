# UVCE baseline benchmark — protocol

Measures the **LAYERED** reference renderer (Milestone 0/1 baseline). It is the yardstick for every later
optimisation (batching, shader composition, caches), not an optimisation result itself.

## How to run

```bash
pnpm install
pnpm build                      # generates fixtures, compiles assets, builds the app
pnpm bench:baseline             # SwiftShader (works without a GPU)
pnpm bench:baseline -- --gpu    # on a workstation: Chromium's real GPU path
# options: --counts 1,20,100,300 --runs 3 --warmup-ms 2000 --measure-ms 15000 --width 1920 --height 1080 --seed 20261009 --out <dir>
#          --query "&mips=0"   extra URL parameters for A/B runs (recorded in summary.json)
pnpm bench:stages [-- --gpu] [--compare <other build dir>]   # per-stage attribution, see tools/uvce/run-stage-timing.ts
```

Output: `docs/benchmark-results/baseline/<YYYY-MM-DD>/summary.json`, `summary.csv`, `scene-<count>.png`.
`summary.json` records commit, clean/dirty tree, browser, GL renderer string, OS, CPU, Node and the protocol.

## Protocol (fixed for comparability)

| Item | Value |
|---|---|
| Build | production (`vite build`, served by `vite preview`, COOP/COEP → `crossOriginIsolated`, ~5 µs timers) |
| Viewport | 1920x1080 canvas, devicePixelRatio 1, MSAA on |
| Scene | `stage` (ground, wall, pillars, arch), perspective camera framed per crowd size, shadows on |
| Crowd | `generateCrowd(seed=20261009)`: hero + deterministic NPCs, ~35% walking, phase offsets, random equipment |
| Counts | 1, 20, 100, 300 visible characters |
| Timing | 2 s warmup, then a 15 s window; 3 fresh browser contexts (cold cache) per count |
| Aggregation | nearest-rank p50/p95/p99 per run over every frame of the window; median across the 3 runs |
| UI | `bench=1`: side panel hidden and not updated, debug overlay off |

## Metrics and what they mean

- **CPU update** — world update + `prepareFrame` (appearance/pose resolution on change, culling, painter sort).
- **CPU submit** — the `renderer.render()` call on the main thread (command encoding; can include command-buffer
  back-pressure if the GPU process falls behind).
- **CPU total** — update + submit per frame (main-thread cost of a frame excluding browser compositing).
- **Draw calls / triangles** — `renderer.info.render` for the whole frame (characters + shadows + world).
- **rAF interval / GPU timer query** — only meaningful on real GPUs. Under SwiftShader they measure CPU software
  rasterisation and are reported in a separate, explicitly labelled section.
- **Asset transfer** — browser Resource Timing (`encodedBodySize`) for `/uvce-compiled/*`.
- **Resident source bytes** — owner-calculated estimates, not measured VRAM: `sourceRGBA8MiB` = level 0 of the
  resident pages (comparable with M0), `residentGpuEstimateMiB` = including mip chains (M2).

## Rules

- No FPS or GPU-performance claim from a software rasterizer.
- Compare variants only on the same machine, browser, viewport, seed and protocol, and keep screenshots.
- On shared or cloud machines, compare only within one session, ideally interleaved run by run: the same M0 build
  measured 18–33 % slower a few hours after this baseline (see [`../m2/2026-10-09/`](../m2/2026-10-09/README.md)).
- A future render mode must first match LAYERED in the parity tests (`tests/e2e/parity.spec.ts`).

## Runs

- [`2026-10-09/`](2026-10-09/README.md) — first baseline (headless Chromium 141 + SwiftShader, 4-core Xeon container).
- [`../m2/2026-10-09/`](../m2/2026-10-09/README.md) — Milestone 2 rerun on the same setup: comparison with a same-session
  M0 control, `mips=0` A/B and per-stage attribution (`bench:stages`).
- GPU runs: still to be produced on a machine with a GPU — see [`docs/LOCAL_TEST_CHECKLIST.md`](../../LOCAL_TEST_CHECKLIST.md).
