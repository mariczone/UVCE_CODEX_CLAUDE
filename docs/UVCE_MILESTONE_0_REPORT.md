# UVCE Milestone 0 — completion report

Date: 2026-10-09 · Branch: `claude/nifty-thompson-7t015u` · Art: synthetic placeholders only.

**Verdict.** Milestone 0 is complete against blueprint §14/§18 (one character switching 3 hats, 3 armors and
3 weapons live, 8 directions, idle/walk, correct alpha, validation and unit tests) and every item of the first-task
prompt is implemented. Milestone 1 is substantially covered (layered baseline renderer, 1/20/100/300 scenes,
reference compositor with automated parity screenshots, recorded baseline) **except a hardware-GPU baseline**,
which cannot be produced in this GPU-less container.

## 1. Requested items → status

| # | Request | Status | Where / evidence |
|---|---|---|---|
| 1 | Canonical sprite axes, 8-direction mapping, foot pivot, named sockets | Done | `src/uvce/core/directions.ts`, rig in `tools/uvce/fixture-spec.ts`; ADR-02/03; `tests/unit/directions.test.ts` |
| 2 | Versioned, validated appearance + animation + asset schema; deterministic seeded RGBA generator; no AI tools | Done | `src/uvce/schema/*`, `tools/uvce/source-schema.ts`, `tools/uvce/generate-fixtures.ts` (seed 1337, byte-identical reruns) |
| 3 | One character of body, head, hair, armor, hat, weapon with front/back order, correct alpha, aligned pivots | Done | per-direction painter order (weapon front for S/SE/E/NE, behind for SW/W/NW/N); GPU = CPU reference within ±3/255 |
| 4 | Live hat/armor/weapon swap, ≥3 variants each, no combination sheets | Done | 200 unique source images cover 3×4×4×4 = 192 equipment combinations × 8 directions × 16 frames (24,576 composite frames, computed); e2e proves a swap fetches only the new item's page, once |
| 5 | idle/walk clips, 8-direction controls, clip separate from art, shared socket attachment | Done | clips are timing-only JSON; body frames carry per-frame sockets; equipment = 1 image/direction moved by its socket |
| 6 | 3D ground/stage in three.js, second overlapping character, depth + internal order test | Done | `stage` scene (ground, wall, pillars, arch); `2 overlap` preset; `parity` scene with an opaque box between two overlapping characters |
| 7 | 1/20/100 characters (deterministic placement + appearance), runtime layer toggles, page/texture/debug overlay | Done (+300) | side panel, overlay (pivots, sockets, layer boxes + order, painter rank), atlas page viewer with residency state |
| 8 | Unit tests: manifest validation, hash/cache IDs, direction mapping, timing, equipment resolution; reference composite visual tests | Done | 77 Vitest tests incl. 8 golden PNGs + 384-entry hash table; 14 Playwright tests incl. 6 GPU-vs-CPU parity cases + negative controls |
| 9 | Scripts: install, generate:fixtures, assets:build, test, typecheck, dev, build | Done | plus `test:e2e`, `screenshots`, `bench:baseline`, `fixtures:legacy:validate` (see README) |
| 10 | Real screenshots, baseline CPU frame metrics, draw calls; no fabricated GPU numbers | Done | `docs/screenshots/`, `docs/benchmark-results/baseline/2026-10-09/` (software-rasterizer numbers fenced and labelled) |

Constraints honoured: existing starter pack untouched (its Python validator still passes); RunPod / GPT Image /
Blender MCP not connected, not probed, no credentials (disabled typed contracts only); WebGPU, shader composition,
partial/full caches, virtual atlas and streaming exist only as contracts/flags (`src/uvce/render/feature-flags.ts`).

## 2. Verified output (final run from a clean tree: generated dirs, `dist/` and `test-results/` deleted first)

Excerpts of the captured log; progress noise, per-test file paths and per-test timings are trimmed.

```text
$ node --version                → v22.22.0
$ pnpm --version                → 10.28.0
$ pnpm install --frozen-lockfile
Lockfile is up to date, resolution step is skipped
Already up to date
$ pnpm generate:fixtures
[generate:fixtures] seed=1337 -> assets/source/uvce-synthetic: 331 files, 900.0 KiB in 2732 ms
$ pnpm assets:build
[assets:build] m-54f938e6dbf5917a: 13 items, 330 source frames -> 200 unique images (130 deduped), 13 pages, 4.58 MiB RGBA8 (337.4 KiB PNG), 0 warnings in 829 ms -> public/uvce-compiled
$ pnpm typecheck
> tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.node.json      [exit 0]
$ pnpm test
 Test Files  8 passed (8)
      Tests  77 passed (77)
$ pnpm build
dist/index.html                   0.58 kB │ gzip:   0.33 kB
dist/assets/index-NtGHRlJW.css    2.62 kB │ gzip:   1.11 kB
dist/assets/index-C8pZAa5n.js   702.78 kB │ gzip: 184.45 kB │ map: 3,638.01 kB
✓ built in 685ms
$ pnpm test:e2e
  ✓   1 app boot and scene › boots on WebGL2 with a validated manifest, one composed character and no console errors
  ✓   2 app boot and scene › renders deterministic 1 / 20 / 100 crowds and reports draw calls
  ✓   3 app boot and scene › overlap preset: the character nearer the camera is painted last
  ✓   4 app boot and scene › sprite direction is chosen relative to the camera, not from world yaw alone
  ✓   5 runtime equipment swaps › swapping hat / armor / weapon fetches only the newly equipped item page, once
  ✓   6 runtime equipment swaps › unequipping removes the layer; runtime layer toggles hide and restore layers
  ✓   7 runtime equipment swaps › a page that fails to load shows a placeholder and is not retried in a loop
  ✓   8 GPU vs CPU reference parity › SE idle t=0ms matches the reference compositor
  ✓   9 GPU vs CPU reference parity › S idle t=480ms matches the reference compositor
  ✓  10 GPU vs CPU reference parity › E walk t=250ms matches the reference compositor
  ✓  11 GPU vs CPU reference parity › NW walk t=350ms matches the reference compositor
  ✓  12 GPU vs CPU reference parity › W walk t=720ms matches the reference compositor
  ✓  13 GPU vs CPU reference parity › N idle t=900ms matches the reference compositor
  ✓  14 GPU vs CPU reference parity › negative controls: a missing layer or a broken depth test would be detected
  14 passed (18.9s)
$ pnpm fixtures:legacy:validate
PASS: 15 assets, 8 directions, 8 frames, 8 RGBA compositing goldens
```

`pnpm dev` was also started: it regenerated fixtures and assets, Vite reported ready, and the page, the
manifest (`uvce-compiled-manifest-v1`, `m-54f938e6dbf5917a`, 13 items) and a page PNG were served with
COOP/COEP headers.

Additional measured facts (not part of the scripted run above):

- Parity details per case (1280x720 = 921,600 px): 0 pixels beyond ±3, max channel delta 1–2, 666–1,221
  pixels not bit-exact (anti-aliased edges). Negative controls: hiding the hat → 2,703 differing pixels;
  ignoring depth for the box → 2,052.
- Mutation checks run by hand: swapping the SW painter order, changing the blend rounding, and removing the
  packer size clamp each made the intended unit tests fail; restoring the code made them pass.

## 3. Screenshots (real headless Chromium, WebGL2 via SwiftShader; regenerate with `pnpm screenshots`)

| File | Shows |
|---|---|
| `docs/screenshots/app-hero-debug-overlay.png` | Composed hero in the 3D stage with layer boxes + draw order, sockets and foot pivot |
| `docs/screenshots/app-overlap-2.png` | Two overlapping characters, nearer one painted last |
| `docs/screenshots/app-crowd-20.png`, `-100.png`, `-300.png` | Deterministic crowds; wall, pillars and arch occluding sprites |
| `docs/screenshots/parity-scene.png` | The pixel-parity scene (box between the characters in depth, wall behind) |
| `docs/screenshots/browser-8-directions.png` | N NE E SE S SW W NW, idle frame 0 |
| `docs/screenshots/browser-equipment-3x3.png` | Hats 1–3, armors 1–3, weapons 1–3 on the same body |
| `docs/screenshots/browser-walk-cycle-E.png` | 8 walk frames; hat and sword follow the per-frame sockets |
| `docs/screenshots/app-panel-source-pages.png` | Atlas page viewer: only equipped items resident, in-use regions outlined |
| `docs/screenshots/reference-contact-sheet-cpu.png` | CPU reference composites (not a browser screenshot) |

## 4. Baseline metrics (details: `docs/benchmark-results/baseline/2026-10-09/README.md`)

Headless Chromium 141 + **SwiftShader** on a 4-core Xeon container, 1920x1080, commit `3db7a20`. Main-thread CPU
per frame, median of 3 runs: **0.52 ms** (1 character, 16 draw calls), **1.08 ms** (20, 150), **2.95 ms** (100,
718), **9.02 ms** (300, 2,110) at p50; p95 1.70 / 1.99 / 7.89 / 15.91 ms. Cold load: 272 KiB (1 character) to
354 KiB (all 13 pages) transferred, ready in 268–443 ms on localhost. No FPS or GPU performance is claimed: rAF
and timer-query values in that report measure software rasterisation.

## 5. Known limitations

- Synthetic art only; no real artwork import yet (Mode B). The starter-pack Python fixtures are kept but not
  imported into the new runtime.
- FRAME representation only (RIG/HYBRID/PROCEDURAL are rejected by validation with an explicit message).
- Painter order is per direction; per-frame order overrides (e.g. attack swings) are not in the schema yet.
  Sockets are rig-level (hats assume the standard head), not hierarchical per head item.
- Dye and variant fields are validated and part of cache keys, but not rendered.
- No mipmaps: far-zoom crowds alias slightly (mip-safe gutters are Milestone 2).
- Per-item pages only: no cross-item shared atlas, logical handles, budgets, eviction, retry/backoff or
  prefetch (Milestone 2). Byte figures are owner-calculated estimates, not measured VRAM.
- One draw call per layer plus one per shadow (≈7 per character); no batching yet.
- Each sprite uses a single depth (feet − 0.1 units): it cannot partially intersect geometry, and transparent
  world objects are not interleaved with characters.
- WebGL context loss is not handled yet (logical state is separate from GPU state, but there is no rebuild path).
- Parity and timings were verified only on SwiftShader; real GPUs may need a tolerance review and must be
  benchmarked separately. Playwright is pinned to 1.56.1 to match the pre-installed Chromium build 1194.
- WebGPU is feature-detected only; the AI/Blender asset factory is a disabled contract.

## 6. Risks

- Real (AI or Blender) art will be less regular than procedural fixtures: anchors, halos and per-direction
  proportions will exercise the validator harder; thresholds may need tuning.
- Draw calls grow ≈7 per character; batching must stay inside painter-safe runs or it breaks overlap order.
- The 300-character p95/p99 spikes are unexplained until measured on a real GPU (main thread vs back-pressure).

## 7. Next milestones

1. **Finish Milestone 1:** run `pnpm bench:baseline -- --gpu` on a documented desktop GPU (and a laptop iGPU);
   add WebGL context-loss recovery with a test; add crossing-characters and arch/bridge cases to the parity suite.
2. **Milestone 2:** cross-item, usage-aware atlas packing with mip-safe gutters; logical sprite handles with
   generations; residency budgets, eviction, retry/backoff and prefetch; 100-actor swap-storm test; KTX2 only
   after PNG parity.
3. **Mode B art:** import S and SE directions of one real character through `uvce-source-manifest-v1`
   (the compiler is provider-independent); optionally import the starter-pack Python fixtures as a FRAME-only test.
4. **Milestone 3:** batched LAYERED runs, then SHADER / PARTIAL_CACHE / FULL_CACHE behind flags — each must pass
   the parity suite before its benchmark is compared to this baseline.
5. **Milestone 6 (later):** inspect the real RunPod / Blender MCP / image endpoints, then add server-side adapters
   that emit source manifests; keep the offline fixture path working.
