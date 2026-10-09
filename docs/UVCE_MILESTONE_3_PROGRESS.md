# UVCE Milestone 3 — progress report (in progress)

Date: 2026-10-09 · Branch: `claude/nifty-thompson-7t015u` · Code commit `abd4261` · Machine: RTX 3070 / Ryzen 5 5600,
Windows 11.

## Blueprint tasks → status

| # | Task (blueprint §Milestone 3) | Status |
|---|---|---|
| 3 | `SHADER` composition behind capability flags with safe fallback | **Done**: `mode=SHADER`, per-character LAYERED fallback, texture-unit check ([ADR-13](UVCE_ARCHITECTURE_DECISIONS.md)) |
| 4 | Toggle modes, benchmark the same stress matrix, compare cost and fidelity | **Done for LAYERED vs SHADER** on one GPU ([results](benchmark-results/gpu/2026-10-09-rtx3070-m3/README.md)); the UI toggle is the URL parameter |
| 1 | `PARTIAL_CACHE` for safe non-interleaving groups | Not started |
| 2 | `FULL_CACHE` with composite page allocator, refcount and budget | Not started |
| 5 | Adaptive render planner with hysteresis | Not started (the renderer can already choose per character) |

The blueprint's M3 exit condition is that at least two modes work on the same inputs with screenshot parity and a
benchmark. LAYERED and SHADER now meet it. The planner is still missing, so M3 is not finished.

## Verified on this machine (clean regenerated assets)

```text
pnpm typecheck                 exit 0
pnpm test                      Test Files 10 passed, Tests 97 passed (3 new SHADER renderer tests)
pnpm test:e2e                  34 passed (10 SHADER parity cases, SHADER negative control + draw-call check,
                               SHADER swap storm: composited 100/100, 0 binding violations)
legacy Python validator        PASS
```

SHADER parity: 0 pixels beyond ±3/255 in every case, max channel delta 1 (LAYERED: 2).

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

## Next

1. Run `mode=SHADER` on a second, weaker GPU with the same commands (`LOCAL_TEST_CHECKLIST.md` §2 plus
   `--query "&mode=SHADER"`) and decide the default.
2. `FULL_CACHE`: composite atlas pages with refcount, budget and eviction, reusing the residency registry.
3. `PARTIAL_CACHE` only for layer groups that never interleave across directions.
4. An adaptive planner (per character: projected size, swap rate, cache hit chance, measured cost; with hysteresis).
