# UVCE Milestone 4 — progress report (in progress)

Started 2026-10-10 · Branch `claude/nifty-thompson-7t015u` · Machine: Ryzen 5 5600 / RTX 3070, Windows 11.
The owner is producing a new real sprite set; every result below was measured on the synthetic placeholder art and
**must be re-run with the real set** (see "Re-test with the real sprites").

## Blueprint tasks → status

| # | Task (blueprint §Milestone 4) | Status |
|---|---|---|
| 3 | Projected-size LOD and adaptive visual animation budget; no simulation changes | **Done, opt-in** (`lod=1`, `animBudget=N`, [ADR-17](UVCE_ARCHITECTURE_DECISIONS.md)). No measurable gain on the synthetic clips ([results](benchmark-results/lod/README.md)) |
| 4 | Synthetic nearby-player appearance broadcast, dependency prefetch, queued GPU uploads | **Done** (`net=1`, [ADR-18](UVCE_ARCHITECTURE_DECISIONS.md)): revisioned protocol with resync, synthetic lossy network, interest prefetch (0 pop-ins with a 1.5 s lead), upload byte cap |
| 1 | Shared socket rig with Idle/Walk and optional hair/cape secondary motion | Next: secondary motion through the RIG representation |
| 2 | FRAME + RIG support; HYBRID behind an experimental flag | Next |
| 5 | Full 3D occlusion/bridge/crossing tests with realistic sprite artwork | **Waiting for the real sprite set** (the M1 crossing/arch/glass scenes exist with synthetic art) |

Blueprint Definition of Done for M4: real art import (2 directions first), shared rig/direction/attachment, LOD and
prefetch, crowd scenes 100/300 with a report. LOD and prefetch are in; real art is the owner's next delivery.

## Verified on this machine

```text
pnpm typecheck     exit 0
pnpm test          Test Files 15 passed, Tests 142 passed
pnpm test:e2e      55 passed (incl. lod.spec.ts and net.spec.ts)
```

## Re-test with the real sprites (owner's new set)

1. `pnpm assets:build` on the new source folder (`art-spec/` format, 5 drawn directions + mirror), then the full test
   set above. The parity, mirror and residency tests run on whatever art is compiled.
2. LOD: rerun `docs/benchmark-results/lod/README.md` (headless) and a headed GPU run with `&lod=1&animBudget=40` vs
   default. If the real clips run faster than 12 fps, LOW/TINY throttling should cut pose updates; decide the default.
3. Streaming: `?count=300&net=1&netLeadMs=0` vs `netLeadMs=1500`, read pop-ins from the panel. Real pages are larger,
   so pop-ins without a lead will be higher; try `uploadBytesPerFrame` if uploads hitch.
