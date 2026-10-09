# UVCE Architecture Decisions (ADRs) — Milestone 0

Short decision records for the POC. Each lists the decision, why, and what would make us revisit it.
Numbering follows the topics required by blueprint §21. Status of all: **accepted for M0/M1**.

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
- **Mirroring:** not used at runtime (`allowMirror: false` everywhere). The generator mirrors *geometry* for
  W-facing views but swaps hand semantics (the right hand is the far hand facing west).

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
- **Known limits:** transparent world geometry is not interleaved with characters; very tall sprites under low
  overhangs use the foot depth for the whole sprite (classic billboard trade-off).

## ADR-05 Backend: WebGL2 `WebGLRenderer` baseline; WebGPU only behind a flag

- three.js 0.186.1 `WebGLRenderer` (WebGL2 only). The single custom GLSL material lives in
  `src/uvce/render/webgl/sprite-material.ts` because `WebGPURenderer` cannot run `ShaderMaterial`; a WebGPU
  path needs a TSL equivalent and parity tests first (M5).
- WebGPU is feature-detected only (`navigator.gpu.requestAdapter()`), reported in the UI, never used.
  In the CI container the API is exposed but returns no adapter.
- Unsupported WebGL2 shows an explicit message instead of a blank page.

## ADR-06 Color space, alpha, filtering, padding

- **Storage:** straight-alpha 8-bit sRGB PNG pages (`alpha: "straight"`, `colorSpace: "srgb"` in the manifest).
- **Upload:** `premultiplyAlpha = true` (UNPACK_PREMULTIPLY_ALPHA_WEBGL) so bilinear filtering is correct at
  edges; `NoColorSpace` (no sRGB→linear decode, no browser color conversion).
- **Blend:** shader outputs the premultiplied texel unchanged; blending `ONE, ONE_MINUS_SRC_ALPHA` into the sRGB
  canvas. Result = straight-alpha "over" in 8-bit sRGB space — the same math as the CPU reference
  (`overPixel`), so there is exactly one premultiplication. 3D lit props use three.js' linear workflow with sRGB
  output; sprites deliberately stay display-referred like conventional 2D art.
- **Filtering:** pages declare `linear` or `nearest`; fixtures are `linear`; parity/studio scenes force
  `nearest`. **No mipmaps in M0** (mip-safe gutters are an M2 compiler task) — minified crowds alias slightly.
- **Padding:** 2 px transparent gutter around every packed image; quads include 1 extra texel on each side so
  bilinear edges fade into transparent texels instead of being clipped.
- **Tolerance:** parity tests allow ±3/255 per channel. Measured on SwiftShader: max delta 2, and only 666–1,221 of
  921,600 pixels per case are not bit-exact (anti-aliased edges: premultiply-on-upload and blend rounding).

## ADR-07 Frame size and resolution tiers

- Fixtures: 256x256 canonical canvas, trimmed on build (e.g. the body idle S frame trims to 76x140 px; the head is a
  separate layer). One resolution tier (0).
  Composite keys already carry `resolutionTier`; LOD variants are M4.

## ADR-08 Manifests, versions, hashing, migration

- **Schemas (Zod 4, versioned strings):** `uvce-source-manifest-v1` (compiler input: PNG paths, anchors, sockets),
  `uvce-compiled-manifest-v1` (runtime), `uvce-appearance-v2`. Structural Zod checks plus semantic checks
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
- **Migration:** `parseAppearance` accepts the starter-pack `uvce-appearance-v1` example and migrates it to v2,
  reporting every dropped field (placeholder `demo-*` hashes, entityId, animation, footPivotPx). Explicit
  manifest aliases map its ids (`sword_01→weapon_01`, …). Unknown versions are rejected.

## ADR-09 Residency and fallbacks (M0 subset)

- `SourceAssetRegistry`: `UNRESOLVED → FETCHING → RESIDENT | FAILED` per page; concurrent requests share one
  promise; pages are uploaded to the GPU eagerly (`initTexture`) so RESIDENT means usable.
- The residency unit is the **per-item page**: equipping an item fetches only that item's page(s); unchanged
  items are never re-fetched (e2e test counts network requests).
- FAILED pages are never retried automatically (explicit `retry()` only) and their layers draw a magenta checker
  placeholder; the rest of the character keeps rendering.
- **Not yet:** budgets, eviction, generation-checked handles, retry/backoff, prefetch (M2). Byte figures are
  owner-calculated RGBA8 estimates, not measured VRAM.

## ADR-10 Benchmark protocol

- `pnpm bench:baseline`: production build, Chromium, 1920x1080 @ DPR 1, fixed seed, scenes of 1/20/100/300
  characters, 2 s warmup, 15 s window, 3 fresh page loads per scene, medians of per-run percentiles.
  Cross-origin isolated pages (COOP/COEP) give ~5 µs `performance.now()` resolution.
- In GPU-less containers Chromium runs ANGLE→SwiftShader: rAF intervals and GPU timer queries then measure
  software rasterization and are labelled as such; **no FPS or GPU performance is claimed**. CPU update and
  render-submit times are the meaningful (still device-specific) numbers. Run with `--gpu` on a workstation for
  hardware numbers.

## ADR-11 Optional AI / Blender integrations

- Not connected, not probed, no credentials. `src/uvce/integrations/asset-factory.ts` only defines job contracts
  and a `DisabledAssetFactory` the UI reports. Real adapters must be server-side; `.env.example` lists empty
  server-only placeholders and the browser-safe `VITE_*` flags. Any future output must enter through the same
  source-manifest → compiler path.

## ADR-12 Testing strategy and pinned toolchain

- **Oracle:** the CPU reference compositor consumes the same `ResolvedPose` as the GPU renderer.
- Unit (Vitest): schemas, keys, directions, timing, resolution (exhaustive 24,576-pose sweep), generator
  determinism, compiler round-trip, packing, goldens (8 PNGs + 384-entry hash table), registry, crowd.
- E2E (Playwright): boot/capabilities, deterministic crowds, camera-relative directions, GPU-vs-CPU parity on 6
  poses + negative controls, equipment swaps with request counting, layer toggles, failed-page fallback.
- Mutation checks were run by hand (swapped painter order, altered blend rounding, removed packer clamp): each
  was caught by the intended test.
- **Pins (exact):** three 0.186.1, zod 4.6.5, vite 8.3.3, vitest 4.1.11, typescript 7.0.2, pngjs 7.0.0,
  @playwright/test 1.56.1 (matches the pre-installed Chromium 141 build 1194; newer Playwright needs
  `pnpm exec playwright install chromium`), Node ≥ 22.18 (native TypeScript type stripping runs the tools;
  `.nvmrc` = 22.22.0), pnpm 10.28.0.
