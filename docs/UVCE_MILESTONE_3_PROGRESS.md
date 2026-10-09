# UVCE Milestone 3 — progress report (in progress)

Date: 2026-10-09 · Branch: `claude/nifty-thompson-7t015u` · SHADER: commit `abd4261`; FULL_CACHE: the commit after it ·
Machine: RTX 3070 / Ryzen 5 5600, Windows 11.

## Blueprint tasks → status

| # | Task (blueprint §Milestone 3) | Status |
|---|---|---|
| 3 | `SHADER` composition behind capability flags with safe fallback | **Done**: `mode=SHADER`, per-character LAYERED fallback, texture-unit check ([ADR-13](UVCE_ARCHITECTURE_DECISIONS.md)) |
| 4 | Toggle modes, benchmark the same stress matrix, compare cost and fidelity | **Done for all three modes** on one GPU ([matrix](benchmark-results/gpu/2026-10-09-rtx3070-pending-runs/README.md)); first SHADER run ([results](benchmark-results/gpu/2026-10-09-rtx3070-m3/README.md)); the UI toggle is the URL parameter |
| 1 | `PARTIAL_CACHE` for safe non-interleaving groups | Not started |
| 2 | `FULL_CACHE` with composite page allocator, refcount and budget | **Done**: `mode=FULL_CACHE`, render-target cell cache, generations, LRU, admission control, thrash breaker ([ADR-14](UVCE_ARCHITECTURE_DECISIONS.md)); GPU matrix done |
| 5 | Adaptive render planner with hysteresis | **Done, opt-in**: `mode=AUTO` ([ADR-15](UVCE_ARCHITECTURE_DECISIONS.md)), with a GPU-pressure gate. Without the gate it was 4–15 % slower than SHADER; with it, AUTO matches SHADER within noise and caches nothing on this CPU-bound GPU ([gated results](benchmark-results/gpu/2026-10-09-rtx3070-auto-gated/README.md), [first version](benchmark-results/gpu/2026-10-09-rtx3070-auto/README.md)) |

The blueprint's M3 exit condition is that at least two modes work on the same inputs with screenshot parity and a
benchmark. LAYERED and SHADER meet it; FULL_CACHE passes the same parity suite, and its benchmark is pending. The
planner and PARTIAL_CACHE are still missing, so M3 is not finished.

## Verified on this machine (clean regenerated assets)

```text
pnpm typecheck                 exit 0
pnpm test                      Test Files 11 passed, Tests 106 passed (3 SHADER renderer tests, 9 frame-cache tests)
pnpm test:e2e                  47 passed (10 parity cases each for SHADER and FULL_CACHE with a check that every
                               character really used the mode, negative controls, swap storm in all three modes,
                               context loss in LAYERED and FULL_CACHE)
legacy Python validator        PASS
```

Parity, 0 pixels beyond ±3/255 in every case: SHADER max channel delta 1, FULL_CACHE max 2 (LAYERED: 2).
Swap storm (100 characters, 2,400 changes, 1 MiB source budget): 0 binding violations in every mode; FULL_CACHE served
up to 86 characters from the cache, then its thrash breaker paused baking (as designed for that churn).

## Result

| 300 characters, RTX 3070 | LAYERED | SHADER |
|---|---:|---:|
| Draw calls | 2,108 | 606 |
| CPU per frame, p50 / p95 | 10.48 / 14.30 ms | 4.31 / 5.16 ms |
| CPU submit (stage timing) | 6.19 ms | 2.64 ms |
| GPU raster wait (stage timing) | 0.75 ms | 1.43 ms |

SHADER is faster from 20 characters up. It costs some GPU fill (up to 8 texture samples per pixel) to save much more
CPU. It stays off by default until a weaker GPU confirms the trade-off.

## Known limitations

- Measured on one discrete GPU only. A laptop iGPU may weigh the extra fragment cost differently.
- In the lit stage scene, SHADER and LAYERED differ by up to 41/255 on 0.05 % of pixels at 300 characters: rounding
  order, fixed-point vs float quad edges at coarse mip levels, and texel ties. Both modes are equally valid
  approximations, and the pixel-exact parity suite matches the CPU reference in both.
- A FAILED page makes that character fall back to LAYERED (the placeholder is drawn there). Characters with more than 8
  visible layers would also fall back; the current rig has exactly 8.
- No planner yet, so the mode is global per page load.
- FULL_CACHE under minification (lit stage scene, mipmaps) differs from LAYERED by up to 64/255 on 8.7 % of pixels at
  300 characters: it downsamples the finished composite on the canvas grid, while LAYERED downsamples each layer on
  its own atlas grid. With `mips=0` or nearest filtering it matches SHADER's level. Crops look the same.
- FULL_CACHE only pays off when frames repeat (shared looks, synchronised animation, idle NPCs). In the default random
  crowd at 300 characters the breaker pauses it and it behaves like SHADER plus the bake cost of each window.

## Pending runs (to do when the RTX 3070 machine is idle)

Recorded 2026-10-09 at the owner's request: postponed, not dropped. Each run needs the machine untouched for about
10–15 minutes (headed Chromium windows pop up). Run on a clean commit and commit the results.

- [x] **Done 2026-10-09** ([results](benchmark-results/gpu/2026-10-09-rtx3070-pending-runs/README.md)): SHADER keeps its 2.5× CPU win at 4K and both modes hold 60 Hz. **4K fill-rate stress, LAYERED vs SHADER.** This is a proxy for a weaker GPU: 4× the pixels means 4× the
      per-pixel work, while the CPU work stays the same.
      ```powershell
      pnpm build
      pnpm bench:baseline -- --gpu --headed --width 3840 --height 2160 --out docs/benchmark-results/gpu/<date>-rtx3070-4k/layered
      pnpm bench:baseline -- --gpu --headed --width 3840 --height 2160 --query '&mode=SHADER' --out docs/benchmark-results/gpu/<date>-rtx3070-4k/shader
      ```
      Use `(Get-Date).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)` for `<date>`, and check
      that `environment.glRenderer` names the RTX 3070. Decision input: if SHADER still wins at 4K, or its raster time
      stays well under the 16.7 ms frame, that supports making it the default.
- [x] **Done 2026-10-09** ([results](benchmark-results/gpu/2026-10-09-rtx3070-pending-runs/README.md)): FULL_CACHE wins only the formation crowd (hit ratio 0.98, −6 % vs SHADER); elsewhere it is 3–11 % slower than SHADER; both are 1.9–2.3× faster than LAYERED. **FULL_CACHE GPU matrix** (needs the idle machine, about 30 min): for each of `count` 100 and 300 and each
      workload `''`, `&looks=8`, `&looks=8&sync=1`, run `mode=LAYERED` / `SHADER` / `FULL_CACHE`:
      ```powershell
      pnpm bench:baseline -- --gpu --headed --counts '100,300' --query '&mode=FULL_CACHE&looks=8&sync=1' --out docs/benchmark-results/gpu/<date>-rtx3070-cache/full-looks8-sync
      ```
      Add `bench:stages` for the winner. Report hit ratio, bakes per frame and breaker pauses from the panel or
      `snapshot().character`. Decide which workloads FULL_CACHE wins (blueprint exit: say which mode wins per workload).
- [ ] **A real iGPU laptop**, whenever one is available: the same two commands at 1920x1080.
- [ ] **RunPod: not planned.** Its weakest offering is still a discrete server GPU, so it cannot answer the iGPU
      question. Reconsider only for unattended GPU CI, after the owner logs in and approves a live price.

## Next

1. Run `mode=SHADER` on a second, weaker GPU with the same commands (`LOCAL_TEST_CHECKLIST.md` §2 plus
   `--query "&mode=SHADER"`) and decide the default.
2. Done: SHADER is the default (owner decision, commit `b59eaee`).
3. Done: adaptive planner (`mode=AUTO`), opt-in, with a GPU-pressure gate (frame timing) and O(1) steady-state
   bookkeeping. Open: measure it on a fill-limited GPU (iGPU) to decide whether it becomes the default.
4. `PARTIAL_CACHE` only for layer groups that never interleave across directions (lowest priority: FULL_CACHE and
   SHADER already cover the cases a partial cache would).
