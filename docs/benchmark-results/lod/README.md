# Projected-size LOD (Milestone 4) — headless A/B

Date: 2026-10-10 · Commit `56f9385` (LOD) · Machine: Ryzen 5 5600 / RTX 3070, Windows 11 · **Headless Chromium with
SwiftShader** (software GL; the GPU is not used). Order ABBA (A = default SHADER, B = `&lod=1`), 2 runs per session,
2 s warm-up, 15 s window. `workingTree: dirty` in the summaries only because of an untracked folder of the owner's
(`art-concepts/`), not code.

What this can and cannot show: pose updates per frame (CPU work the LOD exists to cut) and LOD level counts are
valid; frame timing is SwiftShader rasterisation (rAF ≈ 66.7 ms, i.e. ~15 fps) and is **not** a GPU result.

| Viewport, 300 characters | Session | LOD levels H/M/L/T | Pose updates / frame (mean, p95) |
|---|---|---|---|
| 1920×1080 | A1 | off | 211.8, 241 |
| | B1 | 0/300/0/0 | 226.6, 241.5 |
| | B2 | 0/300/0/0 | 214.3, 241.5 |
| | A2 | off | 212.6, 241.5 |
| 1280×720 | A1 | off | 151.1, 230 |
| | B1 | 0/0/300/0 | 148.1, 213 |
| | B2 | 0/0/300/0 | 148.6, 206.5 |
| | A2 | off | 150.0, 226.5 |

## Result: no measurable benefit in this scene, for two reasons

1. **At 1080p the 300 crowd is MEDIUM** (the 256 px canvas projects to ~100 px), and MEDIUM keeps full-rate
   animation by policy, so nothing changes.
2. **At 720p it is LOW (12 Hz), but the clips are slower than that.** The synthetic walk is 10 fps (100 ms frames),
   idle 5.5–8 fps. A 12 Hz or 8 Hz visual clock rarely skips a frame of a ≤10 fps clip. Mean pose updates moved by
   ~1–2 %, within run-to-run noise. (The p95 drop 230/226 → 213/206 may hint at smoother spikes from the stagger, but
   two runs per session cannot separate it from noise.)

Decision: LOD stays **opt-in** (`lod=1`). It is correct (unit + e2e tests, no stale bindings, parity frames identical)
and costs one projection per visible character, but its value depends on the art's frame rate. **Re-test with the
owner's real sprite set:** if its clips run faster than 12 fps (e.g. 12–24 fps), throttling small characters will cut
pose updates proportionally. The `animBudget` cap is independent of frame rates and bounds per-frame spikes; it needs
a GPU run at 60 Hz to judge.

Reproduce (after `pnpm build`):

```powershell
pnpm bench:baseline -- --counts '300' --runs 2 --width 1280 --height 720 --query '&lod=1' --out docs/benchmark-results/lod/<date>-headless-720p/b1
```
