# UVCE Architecture Decisions (ADRs) — Milestones 0–2

Short decision records for the POC. Each lists the decision, why, and what would make us revisit it.
Numbering follows the topics required by blueprint §21. Status of all: **accepted for M0–M2** (ADR-13/14/15: M3); paragraphs marked
**(M1)** / **(M2)** record what those milestones changed.

## ADR-01 Standalone single-package POC next to the starter pack

- **Decision:** No existing app existed (see `UVCE_REPO_AUDIT.md`), so a standalone Vite + TypeScript + three.js
  app was bootstrapped at the repo root. One package; folders mirror the blueprint's package boundaries:
  `src/uvce/core` (character-core), `src/uvce/schema` (asset-schema), `src/uvce/assets` (virtual-assets subset),
  `src/uvce/render` (character-renderer), `src/uvce/compositor`, `src/uvce/bench` (benchmark-core),
  `src/uvce/integrations` (ai-asset-bridge contracts), `tools/uvce` (asset-compiler + generator), `src/app` (demo).
- **Why:** a pnpm monorepo adds build plumbing without benefit at this size; the boundaries are kept by import
  direction (`tools/` and `tests/` may import `src/uvce`, never the reverse; `src/` is type-checked without Node types).
- **Starter pack:** the Python generator/validator and the 968 committed PNGs are untouched and still validate.
  The new pipeline writes only to git-ignored directories.
- **Revisit:** when a second app (e.g. asset preview) or a server-side bridge needs to share packages.

## ADR-02 Coordinates, camera-relative 8-direction mapping, foot pivot

- **Sprite space:** canonical canvas 256x256, origin top-left, x right, y down, unit = source pixel.
  Foot pivot (ground contact) = (128, 228). Trimmed frames keep their rect on the canonical canvas.
- **World space:** three.js Y up, ground = XZ, north = -Z, east = +X. Scale: 128 source px = 1 world unit.
- **Facing:** compass yaw ψ, clockwise from above (N=0, E=π/2, S=π, W=3π/2), forward(ψ) = (sin ψ, 0, -cos ψ).
- **Direction selection (`dir8-compass-cw-v1`):** order `N NE E SE S SW W NW`; sprite = sector of
  (facing yaw − view yaw), sectors ±22.5°, an exact boundary belongs to the clockwise-next sector.
  View yaw = yaw of the camera→feet ray for perspective cameras (edge-of-screen characters are seen at a
  different angle), camera forward for orthographic cameras. Relative 0 = we see the back ("N").
- **Proof:** `tests/unit/directions.test.ts`; e2e `sprite direction is chosen relative to the camera` orbits the
  camera and checks N→S→W for the same world facing.
- **Mirroring:** supported since ADR-16 (`allowMirror: true` parts get W/SW/NW from E/SE/NE). The fixture's base
  items stay fully drawn; the generator mirrors their *geometry* for W-facing views but keeps hand semantics (the
  right hand is the far hand facing west).

## ADR-03 Rig, sockets, layers and per-direction painter order

- **Rig `humanoid_2d_v1`:** sockets `head_top, neck, chest, right_hand, left_hand, back` (+ implicit `root` =
  foot pivot); layers `hair_back, body, arm_front, armor, head, hair_front, hat, weapon`; slots own layers
  (`body→body,arm_front`, `head→head`, `hair→hair_back,hair_front`, `armor`, `hat`, `weapon`). A layer belongs to
  exactly one slot, so two equipped items can never fight over a layer.
- **Animation vs artwork:** clips are timing only (`frameDurationsMs`, `loop`, events). The body is the single
  *socket-driver* layer: FRAME art per clip/direction/frame **plus per-frame socket positions**. Every
  equipment part is **one static image per direction**, authored on the canonical canvas at the rest-pose socket
  (its `anchor`), and moved at runtime by `socket(frame) − anchor`. New clips therefore never multiply
  equipment art; equipment never needs per-frame art.
- **Painter order:** `rig.layerOrder[direction]`, a complete permutation of the layers (validated). Derived from
  which hand faces the camera (right-hand weapon in front for S/SE/E/NE, behind for SW/W/NW/N); back views draw
  the hair mass over the head and have no fringe frame; `arm_front` (the arm crossing the torso) is drawn above
  armor and is absent in S/N. Per-frame order overrides are a future schema extension.
- **Placement is integer-pixel exact** (v1 schema requires integer pivots/anchors/sockets/rects). This is what
  makes the CPU reference and GPU output comparable pixel for pixel.

## ADR-04 Sorting, transparency and 3D occlusion (one depth pipeline)

- Characters and world share one three.js scene and one render pass. Each character is a `THREE.Group` whose
  `renderOrder` is its painter rank (back→front by view-space foot depth, tie-break by entity id); each layer
  mesh's `renderOrder` is its per-direction layer index. three.js sorts transparent objects by
  (groupOrder, renderOrder, …), giving exact per-character order **without** "all hats after all bodies".
- Sprites are screen-aligned quads built in view space at the feet: constant depth = foot depth pulled
  0.1 world units toward the camera (keeps soles from z-fighting the ground). `depthTest` on, `depthWrite` off:
  opaque 3D geometry occludes sprites correctly, sprites never occlude each other through depth.
- Ground shadows are decals in a group with `renderOrder −1` (after opaque, before any character).
- **Proof (screenshots + tests):** `tests/e2e/parity.spec.ts` renders two overlapping characters with an opaque
  box *between* them in depth and a wall behind; the GPU image equals the CPU expectation (back char, box, front
  char) within ±3/255 on all 921,600 pixels, and a negative control shows that an image ignoring depth differs on
  2,052 pixels (test threshold >800). `docs/screenshots/parity-scene.png`, `app-crowd-100.png` (wall, pillars, arch occluding sprites).
- **(M1) Transparent world objects** (glass, water, bridges) are registered with `addSortedObject(id, object)` and
  ranked in the *same* back-to-front sort as the characters (key `obj:<id>`, depth of the object's anchor), so a
  character behind a pane is tinted and one in front is not. Opaque objects need nothing: the depth test handles
  them. **Proof:** parity variants `crossing` (two characters swap order mid-walk), `arch` (pillars and lintel
  occlude a character, another stands in front) and `glass` (50 % pane between two characters) all match the CPU
  reference, and each has a negative control (stale order / unsorted glass differ by > 300 pixels).
- **Known limits:** very tall sprites under low overhangs use the foot depth for the whole sprite (classic
  billboard trade-off); a sorted transparent object has one depth too, so large transparent surfaces that span
  many depths must be split.

## ADR-05 Backend: WebGL2 `WebGLRenderer` baseline; WebGPU only behind a flag

- three.js 0.186.1 `WebGLRenderer` (WebGL2 only). The single custom GLSL material lives in
  `src/uvce/render/webgl/sprite-material.ts` because `WebGPURenderer` cannot run `ShaderMaterial`; a WebGPU
  path needs a TSL equivalent and parity tests first (M5).
- WebGPU is feature-detected only (`navigator.gpu.requestAdapter()`), reported in the UI, never used.
  In the CI container the API is exposed but returns no adapter.
- Unsupported WebGL2 shows an explicit message instead of a blank page.

## ADR-06 Color space, alpha, filtering, padding

- **Storage:** straight-alpha 8-bit sRGB PNG pages (`alpha: "straight"`, `colorSpace: "srgb"` in the manifest).
- **Decode/upload (M2):** `createImageBitmap(blob, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none',
  imageOrientation: 'flipY' })` decodes off the main thread; the texture is uploaded with `premultiplyAlpha = false`
  and `flipY = false` because both were applied at decode (WebGL ignores the UNPACK_* flags for ImageBitmaps).
  Premultiplied texels keep bilinear filtering and mip averaging correct at edges; `NoColorSpace` = no sRGB→linear
  decode and no browser colour conversion. (M0 decoded via `<img>` and premultiplied on upload: same result.)
- **Blend:** shader outputs the premultiplied texel unchanged; blending `ONE, ONE_MINUS_SRC_ALPHA` into the sRGB
  canvas. Result = straight-alpha "over" in 8-bit sRGB space — the same math as the CPU reference
  (`overPixel`), so there is exactly one premultiplication. 3D lit props use three.js' linear workflow with sRGB
  output; sprites deliberately stay display-referred like conventional 2D art.
- **Filtering:** pages declare `linear` or `nearest`; fixtures are `linear`; parity/studio scenes force
  `nearest` without mipmaps (pixel-exact tests).
- **(M2) Mip-safe layout:** linear pages carry `mipLevels` L (default 3). The compiler starts every image on a
  2^L-texel boundary and separates images (and the page border) by at least 2^L transparent texels (≥ the 2 px
  padding), so mip levels 0..L never average two images together and bilinear taps at those levels only reach
  transparent texels. The uploader generates the chain and sets `TEXTURE_MAX_LEVEL = L` on the raw GL texture
  (three.js never sets it), so deeper, image-mixing levels are never sampled; if the GL handle is unavailable it
  falls back to no mipmaps rather than risk bleed. **Proof:** a unit test box-filters every packed page like GL
  does and finds 0 mixed texels and 0 cross-image bilinear reach at levels 1..3; shrinking the gap to 2 px makes it
  fail. **Cost** for the fixtures: level-0 page bytes 4.58 → 6.06 MiB (+32 %, alignment and gutters), 8.08 MiB with
  chains; trilinear sampling also costs more raster time (see `docs/benchmark-results/m2/`). `mips=0` turns
  chains off for A/B comparisons.
- **Padding:** 2 px transparent gutter (2^L when mipmapped); quads include 1 extra texel on each side so bilinear
  edges fade into transparent texels instead of being clipped.
- **Tolerance:** parity tests allow ±3/255 per channel. Measured on SwiftShader: max delta 2, and only 666–1,221 of
  921,600 pixels per case are not bit-exact (anti-aliased edges: premultiply-on-upload and blend rounding).

## ADR-07 Frame size and resolution tiers

- Fixtures: 256x256 canonical canvas, trimmed on build (e.g. the body idle S frame trims to 76x140 px; the head is a
  separate layer). One resolution tier (0).
  Composite keys already carry `resolutionTier`; LOD variants are M4.

## ADR-08 Manifests, versions, hashing, migration

- **Schemas (Zod 4, versioned strings):** `uvce-source-manifest-v1` (compiler input: PNG paths, anchors, sockets;
  M2 adds optional `atlasGroup` and `mipLevels` per item), `uvce-compiled-manifest-v2` (runtime; v1 in M0),
  `uvce-appearance-v2`. Structural Zod checks plus semantic checks
  (layer order permutations, socket completeness, frame counts vs clips, slot/layer ownership, image regions
  inside pages, aliases). The browser validates the manifest before rendering.
- **Content hashes:** image key = SHA-256 over the *trimmed RGBA pixels* (independent of PNG encoder and atlas
  placement); item `contentHash` = SHA-256 over canonical item metadata (image keys, trims, anchors, sockets);
  `manifestVersion` = hash of the manifest body (no timestamps → identical inputs, identical bytes).
- **Runtime keys (FNV-1a 64 over canonical JSON):** `appearanceKey` covers rig id+version, render-semantics
  version and, per visible slot, item id/version/content hash/variant/dye. It excludes entity id, position,
  facing and time; a hidden slot equals an empty one. `partGroupKey` covers only the slots feeding a layer group
  (hat swap changes HEAD, not TORSO). `compositeFrameKey` uses the logical frame index (shared across phase
  offsets), direction, clip, tier, compiler version and debug layer toggles. Dye/variant are keyed
  conservatively although M0 does not render them yet.
- **(M2) Compiled manifest v2:** pages carry `group`, `items` (who uses the page) and `mipLevels`; items carry
  `atlasGroup`; stats add `pageBytesWithMips` and `crossGroupSharedImages`. New semantic checks: image regions are
  aligned to their page's 2^mipLevels (`image.mip-align`) and every page an item lists also lists the item. The
  compiler (0.2.0) validates every frame of every item before packing anything (a bad item fails the build before
  any output is written).
- **(M2) Atlas groups:** an item may declare an `atlasGroup` (a co-use bundle packed onto shared pages); the default
  is the item itself, i.e. M0's per-item pages. The fixtures put `body_base` + `head_base` (always used together) in
  `core`: one page instead of two. Dedupe is global — an image already placed by another group is referenced, not
  copied. A group may not mix filters or mip levels (`item.atlas-group`). The page stays the residency unit, so a
  hat swap still fetches only that hat's page; packing groups from usage statistics is future work.
- **Migration:** `parseAppearance` accepts the starter-pack `uvce-appearance-v1` example and migrates it to v2,
  reporting every dropped field (placeholder `demo-*` hashes, entityId, animation, footPivotPx). Explicit
  manifest aliases map its ids (`sword_01→weapon_01`, …). Unknown versions are rejected.

## ADR-09 Residency, budgets and fallbacks (M2: registry v2)

- **States per page:** `UNRESOLVED → REQUESTED → FETCHING → DECODED → UPLOAD_QUEUED → RESIDENT`, plus
  `RETRY_BACKOFF`, `FAILED`, `EVICTED` (`src/uvce/assets/source-registry.ts`). Network + decode and GPU upload are
  injected ports (`src/uvce/render/webgl/page-io.ts` in the browser, fakes with a manual clock in unit tests).
- **Pins:** a visible character pins its items (refcount per page); pinned pages are never evicted. The renderer
  keeps one frozen item array per appearance and compares pins by identity, so steady-state frames make no
  registry calls at all.
- **Budget:** resident GPU bytes (RGBA8 incl. mip chain — an estimate, not measured VRAM) above `budgetBytes`
  (default 256 MiB, blueprint §8.3; URL `budgetMiB=`) evict unpinned pages LRU-first down to `lowWaterRatio`
  (0.75, hysteresis). A page's LRU stamp is the frame it lost its last pin (only pinned pages are drawn), so there is
  no per-layer "touch" in the frame loop. If the pinned set alone exceeds the budget nothing pinned is evicted and
  `overBudget` is reported: correctness before memory.
- **Prefetch:** frustum-culled characters unpin and issue **one** low-priority prefetch per culling (not per
  frame). Prefetches are opportunistic: one that would push resident + in-flight bytes above the low watermark is
  dropped (`prefetchSkipped`), and a prefetched page evicted by the budget is not requested again until the
  character is visible or culled anew — no fetch/evict thrash (unit-tested).
- **Network:** demand before prefetch, then FIFO; ≤ 4 concurrent fetches; a load nobody needs any more is aborted
  (`AbortController`) or its decoded copy released. Transient failures (network error, HTTP 408/429/5xx) retry with
  exponential backoff (250 ms, 500 ms; 3 attempts); 404 and decode errors fail at once. FAILED layers draw a magenta
  checker placeholder and the rest of the character keeps rendering; `retry()` is explicit (UI/debug).
- **Uploads:** at most 2 per frame, in `beginFrame()` between frames, which bounds upload hitches. Trade-off:
  time-to-ready grows when frames are slow (12 pages need ≥ 6 frames; visible in the SwiftShader runs).
- **Handles:** a RESIDENT page owns a slot; `PageHandle = { index, generation }`. Eviction, context loss and
  dispose free the slot and bump its generation, so an old handle can never resolve to a page that later reuses the
  slot (ABA guard). Renderers bind through `handleFor` / `resolve` and re-bind whenever `revision` changes (every
  transition into or out of RESIDENT/FAILED bumps it). Independently of that, a per-frame audit re-checks a
  character's layer handles whenever `handleEpoch` (count of slot frees) has moved since it was bound, and hides any
  stale layer instead of drawing a recycled texture — O(1) per character in steady state.
- **Context loss (M1):** pages keep their decoded `ImageBitmap` (`keepDecodedCopies`); on `webglcontextlost`
  resident pages become UPLOAD_QUEUED and every handle goes stale; after `webglcontextrestored` they are re-uploaded
  without any network request. Without decoded copies they would be refetched (unit-tested both ways). The GPU
  timer re-acquires its extension after a restore.
- **Proof:** registry unit tests (concurrency, dedupe, cancellation, backoff, 404, LRU, budget, headroom, ABA,
  context loss) and renderer unit tests (identity pins, prefetch once per culling, defence-in-depth audit); e2e
  swap storm (100 characters, 1 MiB budget, 60 × 40 slot changes: evictions and reloads happen, 0 binding
  violations, resident = pinned), evict/reload parity and context-loss parity (pixel-exact, no page request).
- **Not yet:** usage statistics for packing, KTX2/Basis, hot manifest patching, per-device budgets, measured VRAM,
  explicit queues instead of the per-frame O(pages) scan in `beginFrame` (12 pages: measured ≈ 0.02 ms).

## ADR-10 Benchmark protocol

- `pnpm bench:baseline`: production build, Chromium, 1920x1080 @ DPR 1, fixed seed, scenes of 1/20/100/300
  characters, 2 s warmup, 15 s window, 3 fresh page loads per scene, medians of per-run percentiles.
  Cross-origin isolated pages (COOP/COEP) give ~5 µs `performance.now()` resolution.
- In GPU-less containers Chromium runs ANGLE→SwiftShader: rAF intervals and GPU timer queries then measure
  software rasterization and are labelled as such; **no FPS or GPU performance is claimed**. CPU update and
  render-submit times are the meaningful (still device-specific) numbers. Run with `--gpu` on a workstation for
  hardware numbers.
- **(M2) Same-session controls.** The cloud container's speed drifts: the unchanged M0 build measured ~20–25 % slower
  in a later session than in its own baseline run. Comparisons between builds are therefore only made against a
  control measured in the same session (`docs/benchmark-results/m2/2026-10-09/`), never against an old run.
- **(M2) Attribution tools:** `--query "&mips=0"` runs the same protocol with extra URL parameters; `pnpm bench:stages`
  stops the rAF loop and times each stage of a frame in isolation (registry pump, world, prepare, submit, raster
  wait via a 1-px `readPixels`), at full size and clipped to a 1-px scissor, optionally A/B against another build.

## ADR-11 Optional AI / Blender integrations

- Not connected, not probed, no credentials. `src/uvce/integrations/asset-factory.ts` only defines job contracts
  and a `DisabledAssetFactory` the UI reports. Real adapters must be server-side; `.env.example` lists empty
  server-only placeholders and the browser-safe `VITE_*` flags. Any future output must enter through the same
  source-manifest → compiler path.

## ADR-12 Testing strategy and pinned toolchain

- **Oracle:** the CPU reference compositor consumes the same `ResolvedPose` as the GPU renderer.
- Unit (Vitest, 94 tests): schemas, keys, directions, timing, resolution (exhaustive 24,576-pose sweep), generator
  determinism, compiler round-trip, packing, atlas groups, cross-group dedupe, mip-bleed simulation, goldens (8 PNGs
  + 384-entry hash table), registry v2 state machine (12), renderer residency bookkeeping (3), crowd.
- E2E (Playwright, 22 tests): boot/capabilities, deterministic crowds, camera-relative directions, GPU-vs-CPU parity
  on 6 poses + 4 scene variants (crossing ×2, arch, glass) with negative controls, equipment swaps with request
  counting, layer toggles, failed-page fallback, swap storm, evict/reload parity, context-loss parity.
- Mutation checks were run by hand: M0 (swapped painter order, altered blend rounding, removed packer clamp) and M2
  (2 px gap instead of 2^L, no LRU stamp on release, no revision bump on a failed upload, no prefetch headroom
  check, prefetch every frame, audit disabled, handle epoch never bumped). Each was caught by the intended test.
- **Pins (exact):** three 0.186.1, zod 4.6.5, vite 8.3.3, vitest 4.1.11, typescript 7.0.2, pngjs 7.0.0,
  @playwright/test 1.56.1 (matches the pre-installed Chromium 141 build 1194; newer Playwright needs
  `pnpm exec playwright install chromium`), Node ≥ 22.18 (native TypeScript type stripping runs the tools;
  `.nvmrc` = 22.22.0), pnpm 10.28.0.

## ADR-13 SHADER render mode: one composited quad per character (M3)

- **Decision:** the first Milestone 3 mode is `SHADER` (blueprint mode B), chosen over PARTIAL/FULL_CACHE because the
  RTX 3070 baseline showed the frame is bound by CPU submission (~7 draws per character), not by fill or memory.
- **How:** `composite-material.ts` draws one quad per character covering the union of its layer rectangles. The
  fragment shader samples up to 8 layers (separate sampler uniforms; GLSL ES 3.00 forbids dynamic indexing of
  sampler arrays) and composites back to front with premultiplied over (`acc = s + (1 - s.a) * acc`), the same
  operation as the LAYERED blend state. Same vertex transform, foot depth and bias as LAYERED, so 3D occlusion and
  character painter order are unchanged; transparent world objects still sort between characters. Layer masks are
  half-open like the rasterizer's top-left rule. Sampling is unconditional inside uniform branches, so mip
  derivatives are well defined.
- **Fallback per character, per pose:** a FAILED page (the magenta placeholder is a LAYERED feature) or more than 8
  layers draws that pose with LAYERED quads. Devices with fewer than 8 texture units get LAYERED with the reason in
  the panel. The generation audit covers composite slots; a stale slot hides the whole quad.
- **Proof:** all parity scenes pass in SHADER mode (0 px beyond ±3, max delta 1) with a check that every character
  was really composited; a SHADER swap storm (100 characters, 1 MiB budget) shows 0 binding violations. Mutation
  checks (reversed composite order, no FAILED fallback, composite audit disabled) are each caught.
- **Result (RTX 3070):** draw calls 2,108 → 606 and CPU per frame 10.5 → 4.3 ms at 300 characters, with GPU raster
  +0.7 ms (`docs/benchmark-results/gpu/2026-10-09-rtx3070-m3/`).
- **Status:** **default since 2026-10-09** (owner decision after the RTX 3070 matrix: SHADER won or tied every workload
  at 1080p and 4K). LAYERED remains the automatic fallback (per pose, or for the whole device when there are too few
  texture units) and stays available as `mode=LAYERED`. An iGPU check is still open. Previously SHADER sat behind
  `mode=SHADER`, and LAYERED stayed the default until a weaker GPU (iGPU) confirmed the trade-off. The
  renderer is ready for a planner to choose per character. PARTIAL_CACHE, FULL_CACHE and the adaptive planner are
  not built yet.

## ADR-14 FULL_CACHE render mode: baked whole frames with admission control and a thrash breaker (M3)

- **Decision:** blueprint mode D. A character's exact frame (appearance key, clip, direction, frame index, debug
  toggles) is baked once into a cell of a render-target "cache page" and then drawn as one quad with one texture
  sample per pixel. That is cheaper per pixel than SHADER (up to 8 samples), so it is the candidate for weak GPUs
  and for repeated looks.
- **How:** `frame-cache.ts`. Pages are 2048² RGBA8 render targets with fixed 280×280 cells (the 256² canvas at offset
  8). Cells sit on a grid aligned to 8, so mip levels 0..3 never mix two cells, and `TEXTURE_MAX_LEVEL = 3`. The bake
  pass reuses the SHADER fragment code (`createBakeMaterial`, no blending, writes the whole cell including the
  gutter); all of a frame's bakes for one page go into one render call before the frame renders. The budget is
  `cacheMiB` (default 64 MiB = 3 pages = 147 cells), with at most 24 bakes per frame.
- **Correctness:** each character keeps `{key, cell, generation}`. Any reassignment or `clear()` bumps the cell's
  generation, so a character never draws another frame's cell (unit-tested with a forced eviction). LRU eviction
  never takes a cell used in the current frame. Context loss clears the cache; characters fall back and re-bake
  after restore (unit test + e2e: pixel-identical, frame drawn from the cache again).
- **Fallback chain per character and frame:** FULL_CACHE → SHADER → LAYERED. A miss, an exhausted bake budget, a
  pending or FAILED page, or bounds outside the cell draw the pose directly.
- **Not thrashing** (blueprint: "planner no catastrophic mode thrashing"):
  1. *Admission:* a frame is baked only on its second request within 120 frames, so one-off frames never displace
     reused ones.
  2. *Thrash breaker:* if a 60-frame window keeps baking (≥ 25 % of the budget per frame, or ≥ 1 bake per 10
     lookups) while the hit ratio stays below 60 %, baking pauses for 240 frames. Cached cells are still served and
     misses use SHADER; then it retries.
  Measured (SwiftShader probe, 400 frames): at 300 random characters the breaker trips once per window and baking
  stops; at 100 characters the hit ratio stays at 0.71–0.89 and the cache keeps working. In the 2,400-swap storm the
  cache served up to 86 characters, then paused itself.
- **Proof:** all 10 parity scenes pass in FULL_CACHE mode with every character drawn from the cache (0 px beyond ±3,
  max delta 2); storm and context-loss e2e; 9 unit tests (allocator, generations, admission, breaker, context loss,
  shared cells). Mutations (no generation check, breaker off) are caught.
- **Known difference under minification:** in the lit stage scene with mipmaps, FULL_CACHE differs from LAYERED by
  up to 64/255 on 8.7 % of pixels at 300 characters. With `mips=0` or nearest filtering it is in line with SHADER.
  The cause is order and grid: FULL_CACHE downsamples the finished composite on the canvas grid; LAYERED downsamples
  each layer on its own atlas grid and then composites. Both are valid, and downsampling the finished image is the
  more faithful of the two. Crops look the same, with FULL_CACHE marginally softer.
- **Status:** behind `mode=FULL_CACHE`. Whether it wins is workload-dependent; `looks=N` and `sync=1` produce
  cache-friendly crowds for the benchmark. The GPU benchmark matrix is pending (owner's machine).

## ADR-15 Adaptive render planner (mode=AUTO) (M3)

- **Decision:** choose the representation per appearance group from measurements. SHADER is the default for every
  group; a group moves to FULL_CACHE only when its frames are measured to repeat. This follows blueprint §4.3:
  hysteresis, cost-based, no mode thrashing.
- **Signals (`src/uvce/render/planner.ts`, 60-frame windows):** while a group is on SHADER, its potential hit ratio is
  `1 − distinct frame keys / requests`, i.e. the hits a big enough cache would get, measured without baking. Once it
  is cached, the measured hit ratio of its lookups is used instead.
- **Rules (thresholds from the RTX 3070 matrix):**
  - Promote when potential ≥ 0.9 and the frames all cached groups need at the same time (peak distinct keys in one
    frame) fit in 80 % of the cache cells; larger groups get the room first. An earlier version counted every frame of
    the window, which over-estimated by ~7× for animated crowds (LRU recycles frames that are no longer shown), so it
    cached only 1 of 8 looks in the formation crowd. Fixed and unit-tested.
  - Demote when the measured hit ratio < 0.6.
  - Each group must stay in its mode for at least 240 frames before switching again.
  - Groups out of view for a window are forgotten.
  - Context loss resets all groups to SHADER.
  - The FULL_CACHE thrash breaker stays active as a global safety net.
- **Promoted groups skip admission control:** their reuse has already been measured, so even the first character to
  reach a new animation frame bakes it instead of falling back for one frame.
- **Proof:** unit tests for promotion, hysteresis, capacity, forgetting, renderer integration and context loss. E2e:
  in the parity scene both looks are promoted and the frame stays pixel-exact against the CPU reference; AUTO swap
  storm with 0 binding violations. Mutations (hysteresis off, capacity check off) are caught.
- **GPU-pressure gate (added after the first benchmark):** without a gate the planner was 4–15 % slower than SHADER
  on the CPU-bound RTX 3070 (`docs/benchmark-results/gpu/2026-10-09-rtx3070-auto/`), because FULL_CACHE saves GPU
  fill, not draw calls. `src/uvce/render/pressure.ts` now derives GPU pressure from frame timing (timer queries were
  too noisy): pressure means the median frame interval is above 1.2× the learned vsync period while median CPU time
  stays below 75 % of the interval. Groups are promoted only under pressure; demotion needs none.
  `plannerPressure=on|off` forces the signal for tests and A/B runs.
- **Bookkeeping cost:** `request` counts per character per frame through a group reference returned by `enter()`;
  `enter`/`leave` run only when a character's frame changes. The remaining cost without promotions is ~0.13–0.19 ms
  per frame at 300 characters (profiled).
- **Status:** opt-in (`mode=AUTO`). With the gate, AUTO matches SHADER within noise on the RTX 3070 (ABBA order: −4 % to
  +7 %, overlapping ranges, nothing promoted: `docs/benchmark-results/gpu/2026-10-09-rtx3070-auto-gated/`). It becomes
  a default candidate once a fill-limited device shows real pressure and a better frame interval with the planner.

## ADR-16 Mirrored directions (W/SW/NW from E/SE/NE)

- **Decision (owner, 2026-10-09):** real characters are drawn in 5 directions (N NE E SE S); W, SW and NW are the
  horizontal mirrors of E, SE and NE. Accepted consequences: a right-hand item appears in the left hand in the
  mirrored views, and asymmetric details flip (the character has few).
- **Where:** compile time decides, runtime only flips sampling.
  - `tools/uvce/compiler.ts` `deriveMirroredDirections`: for a part with `allowMirror: true`, each missing mirrored
    direction becomes a copy of its source frames with the same image key and `mirror: true`. A direction that was
    drawn explicitly always wins. The mirrored image must stay inside the canvas (`mirror.canvas` error).
  - Coordinates (`src/uvce/core/mirror.ts`): pixel columns and points `x' = 2·pivot.x − 1 − x` (255 − x at pivot
    128); rects `x' = 2·pivot.x − (x + w)`; root-attached anchors stay at the pivot. With these rules the placement
    `trim + socket − anchor` of a mirrored layer is exactly the mirror of the source placement.
  - Runtime: `ResolvedLayer.mirror`; the CPU reference compositor blits flipped; LAYERED, SHADER and the FULL_CACHE
    bake swap u0/u1 (`layerUvRect`). The filter margin is symmetric, so the swap is an exact flip.
  - A fully mirrored character also needs mirrored rig directions (painter order of E for W, mirrored rest sockets):
    `mirrorRigDirections`. The compiler warns (`mirror.rig`) when a mirrored socket driver meets a rig that is not.
- **Cost:** no extra texture memory, download or atlas space for the mirrored directions (~37 % fewer images per
  character); no measurable per-frame CPU/GPU change (the same quads and samples are drawn).
- **Proof:** `tests/unit/mirror.test.ts`. Math round trips. A fully mirrored build of the fixture set renders
  W/SW/NW pixel-exactly as the mirror of E/SE/NE (96 composites, 2 looks × 2 clips × 3 pairs × 8 frames). Mirrored
  layers sample column i as column w−1−i. An explicitly drawn direction wins. The validator rejects `mirror` without
  `allowMirror`. The rig warning fires.
  The fixture companion items hair_02, hat_03, armor_03 and weapon_02 are now mirrored (330 → 316 source frames). Only
  the 48 hashes of the mixed look in W/SW/NW changed; the default-look goldens are unchanged. The e2e W/NW parity cases
  in LAYERED, SHADER and FULL_CACHE therefore cover mirrored layers on the GPU. Disabling the flip fails 3 tests.
## ADR-17 Projected-size LOD and visual animation budget (M4)

- **Decision:** the renderer measures each visible character's projected canvas height (foot and canvas top through
  the view-projection matrix, × viewport height) and picks a level with hysteresis (`src/uvce/render/lod.ts`; blueprint
  §10 thresholds 150/80/30 px, ±10 % band). The level only sets the **visual** animation rate (null/null/12/8 Hz):
  the clip clock is sampled at that rate with a stable per-entity stagger. Positions, facing and the simulation are
  untouched. Texture detail at small sizes already comes from the mip chains.
- **Budget:** `animationBudget` caps animation-only pose updates per frame below HIGH; a character is deferred at most
  3 frames in a row. Appearance, direction, residency and debug-toggle changes are never deferred (they are
  correctness, the frame is not).
- **No popping by construction:** the throttled clock never runs backwards and lags by less than one period, so frames
  advance in clip order; a level change shortens or lengthens one hold. Nothing is swapped (same images, same quads).
- **Proof:** `tests/unit/lod.test.ts`, LOD cases in `tests/unit/layered-renderer.test.ts` (rate, order, bounded
  deferral, appearance changes pass the budget, projected height), `tests/e2e/lod.spec.ts` (levels follow framing;
  the parity frame is pixel-identical with and without LOD). Mutations (no throttle, unbounded deferral) are caught.
- **Status:** opt-in (`lod=1`, `animBudget=N`). Headless A/B showed no measurable gain in the synthetic scene because
  its clips (5.5–10 fps) are slower than the LOW/TINY rates ([results](benchmark-results/lod/README.md)). Re-test
  with the real sprite set and on the GPU at 60 Hz before any default change.

## ADR-18 Multiplayer-style appearance streaming (M4)

- **Protocol** (`src/uvce/net/appearance-stream.ts`, blueprint §11): ids and revisions, never images.
  `appearance.snapshot` (full look at revision r; on entering interest and as a resync answer), `appearance.changed`
  (slot delta at r, applies only on r − 1), `appearance.revision` (heartbeat, piggybacks on state updates) and
  `entity.left`. Events for another manifest version are rejected.
- **Ordering and loss:** stale and duplicate deltas are dropped; future deltas are held until the gap fills; a gap
  open longer than 400 ms requests one snapshot. Deltas are partial, so skipping a lost one is never allowed.
- **Found by the convergence test:** losing the *last* delta leaves no later delta to reveal the gap, so a client
  could stay wrong forever. The revision heartbeat closes that hole (a heartbeat ahead of the client opens a gap).
- **Prefetch:** every applied change reports the entity's item dependencies; the app prefetches them while the
  player is in interest but not yet visible. The registry deduplicates, so shared items cost nothing.
- **Queued uploads:** the registry already uploaded at most `uploadsPerFrame` pages per frame, demand first. It now
  also takes `uploadBytesPerFrame` (the first upload of a frame always goes through) and reports `uploadQueue` /
  `uploadsDeferred`. The default stays uncapped (0) until a hitch measurement asks for a value.
- **Synthetic network** (`src/uvce/bench/synthetic-network.ts`): deterministic, unreliable deltas (latency jitter,
  duplicates, loss) and reliable snapshots. The app's `net=1` drives the NPCs with it.
- **Proof:** `tests/unit/appearance-stream.test.ts` (100 players, 5 % loss, 10 % duplicates, reordering: every client
  converges to the server revision and slots), the registry byte-cap test, and `tests/e2e/net.spec.ts`. In the real
  app 100 players arrived over a lossy link: 27 deltas lost, all repaired by resyncs; with a 1.5 s prefetch lead
  0 pop-ins, without a lead 6 of 99 players appeared with layers still loading (that run).