# Mage v3 (first real character set) vs the synthetic fixture — memory, packing, frame time, encoding

Date: 2026-10-10 · Code: commit `514eb41` · Machine: Ryzen 5 5600, RTX 3070 (ANGLE D3D11), Windows 11, Chromium 141.
Art: Mage v3 source tree from the character session (`art-concepts/claude-2026-10-09/mage-v3/loop/export/uvce/`,
283 PNG, 256² canvas), copied to `bench-data/mage-v3/source/` (git-ignored: the owner decides whether it is committed)
and compiled with the current compiler to `bench-data/mage-v3/public/uvce-compiled/` (manifest `m-337bda7075f854bc`,
identical to the handoff's). `public/uvce-compiled` and the dev server on :5173 were not touched; the app runs came from
a separate build (`UVCE_PUBLIC_DIR=bench-data/mage-v3/public vite build --outDir dist-mage`).

## 1. Before: Mage v3 as delivered vs fixture

### Static (from the compiled manifests, `tools/uvce/atlas-report.ts`)

GPU bytes = RGBA8 incl. the mip chain the runtime builds (estimate, not measured VRAM). Look = all pages of one
appearance's items (mean over the crowd's random looks). Crowd = union over the app's seeded crowd (hero + random NPC
outfits; the crowd randomises hair/hat/armor/weapon, not body/head).

| | Fixture (synthetic) | Mage v3 |
|---|---:|---:|
| Items / unique images | 13 / 188 | 14 / 283 |
| Pages | 12 | 13 |
| Page fill (image px / page px) | 57.7 % | 67.3 % |
| All pages, GPU | 7.75 MiB | 17.16 MiB |
| PNG download, all pages | 322 KiB | 2,565 KiB |
| One look (mean) | 6.09 MiB | **14.25 MiB** |
| Crowd 1 / 20 / 100 / 300 | 6.18 / 7.75 / 7.75 / 7.75 MiB | 14.71 / 16.83 / 16.83 / 16.83 MiB |
| Distinct looks in crowd 300 | 150 | 55 |

Mage v3 pages:

| Page | Size | Fill | GPU (mips) | Items |
|---|---|---:|---:|---|
| page-core-0 | 2048×1288 | 74.0 % | 13.36 MiB | body_base, body_navy |
| page-hair_01-0 / hair_long_auburn / hair_long_brown | 512×224 each | 43.5 % | 0.58 MiB each | one hair item each |
| page-hair_bob-0 | 256×192 | 46.3 % | 0.25 MiB | hair_bob |
| page-hair_ponytail-0 | 256×256 | 46.8 % | 0.33 MiB | hair_ponytail |
| page-hat_01-0 | 256×288 | 49.6 % | 0.37 MiB | hat_01 |
| page-hat_beret-0 | 256×120 | 43.5 % | 0.16 MiB | hat_beret |
| page-head_base / head_blink / head_face2 | 256×128 each | 33.2 % | 0.17 MiB each | one head each |
| page-weapon_01-0 | 256×176 | 44.3 % | 0.23 MiB | weapon_01 |
| page-weapon_moon-0 | 256×168 | 47.7 % | 0.22 MiB | weapon_moon |

Small pages are only 33–50 % filled because every image carries an 8 px aligned gutter (needed for bleed-free mips
down to level 3), but together they are < 4 MiB. **The body page dominates: 13.4 MiB, and every look pays for both
bodies** (body_navy sits in body_base's `core` atlas group).

### In the app (headed GPU runs)

Protocol: `bench:baseline --gpu --headed`, 1920×1080, crowds 1/20/100/300, 2 runs per session (median), 10 s windows
after 2 s warm-up, the four modes in ABBA order (L S F A A F S L) per dataset, reported = median of a mode's two
sessions. Raw: `docs/benchmark-results/gpu/2026-10-10-mage-v3/` (`aggregate.json`).

| 300 characters | Fixture LAYERED | SHADER | FULL_CACHE | AUTO | Mage LAYERED | SHADER | FULL_CACHE | AUTO |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| CPU per frame p50 (ms) | 9.35 | 4.84 | 5.24 | 4.82 | 9.19 | 4.76 | 5.13 | 4.69 |
| CPU per frame p95 (ms) | 11.62 | 6.00 | 6.22 | 5.81 | 11.12 | 5.71 | 6.18 | 5.66 |
| rAF interval p50 (ms) | 16.68 | 16.68 | 16.67 | 16.68 | 16.68 | 16.68 | 16.68 | 16.68 |
| Draw calls | 2,112 | 606 | 606 | 606 | 1,935 | 606 | 606 | 606 |
| Resident source pages, GPU | 7.78 MiB | 7.78 | 7.78 | 7.78 | 16.89 MiB | 16.89 | 16.89 | 16.89 |
| Frame cache, GPU | 0 | 0 | **64 MiB** | 0 | 0 | 0 | **64 MiB** | 0 |

| Mage, SHADER | 1 | 20 | 100 | 300 |
|---|---:|---:|---:|---:|
| CPU p50 / p95 (ms) | 0.40 / 0.54 | 0.73 / 0.95 | 1.86 / 2.34 | 4.76 / 5.71 |
| Resident GPU (pages) | 14.77 MiB (5) | 16.89 MiB (11) | 16.89 (11) | 16.89 (11) |

Reading:
- **Frame time does not depend on the art.** Real art costs the same CPU as the synthetic fixture in every mode (same
  layer count per character); SHADER halves CPU against LAYERED at 300; FULL_CACHE is ~8 % slower than SHADER here
  (random looks); AUTO matches SHADER (no GPU pressure, nothing promoted).
- **GPU time:** every configuration holds the 60 Hz vsync (rAF 16.68 ms), so the RTX 3070 is not GPU-bound here. The
  WebGL timer-query values (in `aggregate.json`) jump between 0.5 and 15 ms for the same scene and are not used, as in
  earlier reports. A GPU-bound comparison needs a weaker GPU (iGPU, still pending).
- **Memory is what real art changes: 2.2× the fixture** (16.9 vs 7.8 MiB resident at 300), and FULL_CACHE adds a
  64 MiB frame cache (its budget) for no frame-time gain at this scale.

## 2. Experiments

### 2a. Packing (no pixel changes) — compiled with the real compiler, measured with atlas-report

Raw: `pack-variants.json` (script `scripts/pack-variants.ts`).

| Variant | Pages | Fill | All pages GPU | Look mean | Crowd 300 |
|---|---:|---:|---:|---:|---:|
| V0 as delivered | 13 | 67.3 % | 17.16 MiB | 14.25 MiB | 16.83 MiB |
| V1 body_navy on its own pages | 14 | 61.6 % | 18.74 | 15.82 ✗ | 18.41 ✗ |
| V2 V1 + one group per accessory slot | 6 | 64.7 % | 17.84 | 17.27 | 17.84 |
| V3 V1 + all accessories in one group | 3 | 64.1 % | 18.01 | 18.01 | 18.01 |
| **V1s V1 + shared-image pages** | 15 | 60.8 % | 18.98 | **8.59 (−40 %)** | **11.17 (−34 %)** |
| V2s V2 + shared-image pages | 7 | 63.9 % | 18.07 | 10.04 | 10.60 |
| V3s V3 + shared-image pages | 4 | 63.3 % | 18.25 | 10.78 | 10.78 |

- V1 alone got *worse*: body_navy reuses body_base's 48 arm_front images, and the compiler stores an image shared by two
  atlas groups in the group packed first (alphabetical: `body_navy` < `core`), so every body_base look loaded the navy
  page too. New compiler option `sharedImages: 'shared-group'` (commit `514eb41`, opt-in) gives such images their own
  page set: **V1s cuts one look from 14.25 to 8.59 MiB and the 300 crowd from 16.83 to 11.17 MiB without changing a
  pixel.** Confirmed in the app (SHADER, resident GPU): 1 character 14.77 → 9.09 MiB, 20–300 characters 16.89 → 11.22
  MiB, CPU unchanged (300: 4.76 → 4.58 ms p50; one V1s run drew 249 instead of 300 characters, likely a covered or
  resized headed window, so its session is excluded from CPU comparisons).
- Merging accessories into fewer pages (V2/V3) saves textures, not memory: a look then loads every accessory of its
  group. With SHADER (one draw per character, up to 8 samplers) fewer textures do not change the draw count. Not worth
  it for memory; keep one page group per item unless items are always worn together.

### 2b. Dye instead of duplicate images (offline fit, no engine change) — `scripts/dye-fit.ts`

Alpha is identical in every pair (shapes match), so a dye could reproduce the variants if the colour mapping allows:

| Variant from base | Changed px | 1 global colour LUT | Luminance ramp, 64 steps | + hue groups (multi-channel mask) |
|---|---:|---|---|---|
| hair_long_auburn from hair_long_brown | 100 % | 36 % px wrong | mean 3.1, p95 7, max 15 | mean 2.9, p95 6 |
| hair_01 (blue) from hair_long_brown | 100 % | 33 % px wrong | mean 3.0, p95 8, max 20 | mean 2.9, p95 8 |
| body_navy from body_base | 61.6 % | 21 % px wrong | mean 9.5, p95 41, max 213 | mean 8.6, p95 34, max 163 |

(errors in 8-bit units on changed pixels). **Hair: a luminance gradient map reproduces the other colours almost
exactly** (p95 ≤ 8/255): one hair image set + a 64-entry ramp per colour. Saves 2 of 3 hair pages (1.16 MiB GPU, 126
KiB PNG; with V1s: look 8.49, crowd 300 10.01 MiB). **Body: navy is not derivable from the red robe** by any
luminance-based dye (the art session shaded it differently). A shader dye for clothing needs the art pipeline to export
the robe in a dye-ready form (see section 4). The engine side (sampling a ramp per dye channel in the composite shader)
is a visual-path change and is **not implemented** until the owner agrees.

### 2c. Mip levels (no pixel changes at level 0)

| Mage V1s with mipLevels | Fill | All pages GPU | Look mean | Crowd 300 | Clean minification down to |
|---|---:|---:|---:|---:|---|
| 3 (current default) | 60.8 % | 18.98 MiB | 8.59 MiB | 11.17 MiB | 1/8 |
| 2 | 64.9 % | 17.58 | 7.99 | 10.26 | 1/4 |
| 1 | 85.1 % | 12.78 | 5.78 | 7.55 | 1/2 |
| 0 (no mips) | 85.2 % | 10.21 | 4.62 | 6.02 | none (aliasing) |

The mip cost is mostly the gutter and alignment that keep levels bleed-free (fill 61 % at level 3 vs 85 % at level 1),
plus the chain itself (+33 %). In the 1080p stage scene the 256 px canvas is drawn at ~100 px (300 crowd) to ~380 px
(close), i.e. down to ~2.5–4× minification, which needs level 2. `mips-vs-nomips-crop.png` (300 crowd, 3× crop,
with mips left, without right): without mips the thin outlines are crisper but jagged; with mips they soften. Motion
shimmer cannot be judged from a still: look at `?count=300&mips=0` vs default in the app before choosing. Recommendation
for now: keep level 3 for the body, consider level 2 for accessories.

### 2d. LOD

The real clips run at 5.3 fps (idle, 188 ms frames) and 6.2 fps (walk, 161 ms), even slower than the synthetic ones,
so the M4 visual-rate LOD (12/8 Hz) cannot skip frames and saves nothing (no run needed: the throttle rate exceeds the
clip rate; see `docs/benchmark-results/lod/`). A LOD that would save memory instead is a half-resolution page set for far
characters (×¼ GPU for the crowd beyond ~2× minification); not built.

### 2e. KTX2 (Basis Universal) vs PNG — `scripts/ktx2-measure.ts`

Encoder: ktx2-encoder 0.6.0 (Basis Universal WASM), installed in a scratch folder (not a project dependency). Input
premultiplied (compressed textures cannot be premultiplied at upload like the PNG path), mip chains generated.

| Download | Fixture | Mage v3 |
|---|---:|---:|
| PNG (current) | 322 KiB | 2,565 KiB |
| KTX2 ETC1S q128 | 220 KiB (−32 %) | **514 KiB (−80 %)** |
| KTX2 UASTC + RDO + Zstandard | 258 KiB (−20 %) | **1,388 KiB (−46 %)** |
| GPU after transcoding (BC7/ASTC/ETC2, full chain) | 7.78 → 1.95 MiB | 17.23 → 4.31 MiB (÷4) |

Real painted art gains far more than the flat synthetic art. **Quality was not measured** (the package has no
transcoder): ETC1S at q128 is likely to smear thin outlines; UASTC is the usual choice for character art. Runtime support
is not built: it needs the Basis transcoder in the browser (WASM), a compressed-texture upload path with capability
detection, and pages that are multiples of 4 px (already true: every page dimension is a multiple of 8).

## 3. Before → after (Mage v3, measured)

| | Before (as delivered) | After, no pixel changes (V1s, in app) | + hair dye (static) | + KTX2 UASTC (static) |
|---|---:|---:|---:|---:|
| One look, GPU | 14.25 MiB (app: 14.77) | 8.59 (app: 9.09) | 8.49 | ≈ 2.2 (÷4) |
| Crowd 300, GPU | 16.83 MiB (app: 16.89) | 11.17 (app: 11.22) | 10.01 | ≈ 2.8 |
| Download, all pages | 2,565 KiB | 2,574 KiB | 2,448 KiB | ≈ 1,330 |
| CPU 300, SHADER p50 | 4.76 ms | 4.58 ms (same within noise) | – | – |

## 4. Recommendations

Pipeline / compiler (no visual change):
1. **Turn on `sharedImages: 'shared-group'` and give colour variants their own atlas group** (never share a group with
   the base). Biggest win measured: −40 % per look, −34 % per crowd. Proposed to become the compiler default.
2. Keep one page group per accessory; do not merge accessories for memory.
3. Do not use FULL_CACHE for random crowds on this class of GPU (64 MiB for no gain); SHADER stays the default.

Art spec / art pipeline (affects how the art is delivered — owner's decision):
4. **Hair colours: deliver one neutral (mid-value) hair image set per style plus a colour ramp per colour** instead of
   one PNG set per colour. Measured: the existing brown → auburn/blue variants are reproducible by a 64-step ramp
   within p95 8/255. Needs an engine dye path (composite shader samples a ramp texture); I will implement it only on
   your go-ahead.
5. **Clothing colours: the art session should export a dye-ready robe**: a neutral-value robe layer plus a dye mask
   (which pixels take which dye), and per-colour ramps, instead of re-shaded colour copies. body_navy as delivered
   cannot be produced from body_base by a shader. Until then, keep variant bodies as separate items in separate atlas
   groups (recommendation 1).
6. **Canvas:** 256² with automatic trim costs nothing for empty canvas, so the canvas size itself is not a memory
   problem; memory follows the trimmed art area (body frames dominate). The character is 167 px tall because the
   wizard hat needs headroom. A taller canvas (e.g. 256×320) would let the body be drawn at the spec's 180–200 px; at
   the same detail that is ≈ +30–40 % body memory. Only worth it if close-ups look soft; decide from the studio scene.
7. Mips: keep 3 levels for the body; test 2 levels for accessories after looking at motion (`mips=0` vs default).
8. KTX2 UASTC: worth building (download −46 %, VRAM ÷4 on real art) once its quality is checked on these pages.

Not measured / open: GPU-bound behaviour (needs the iGPU), KTX2 quality, mip shimmer in motion, weapon rotation from
`frames.json` (`prop.delta`): that would change visuals and needs your decision first.

## Reproduce

```powershell
node tools/uvce/build-assets.ts --src bench-data/mage-v3/source --out bench-data/mage-v3/public/uvce-compiled
node tools/uvce/atlas-report.ts --dir bench-data/mage-v3/public/uvce-compiled
$env:UVCE_PUBLIC_DIR='bench-data/mage-v3/public'; pnpm exec vite build --outDir dist-mage; $env:UVCE_PUBLIC_DIR=$null
pnpm bench:baseline -- --gpu --headed --dist dist-mage --counts '1,20,100,300' --runs 2 --measure-ms 10000 --query '&mode=SHADER' --out <dir>
```

`scripts/` holds the one-off experiment scripts exactly as run (absolute paths to this checkout).
