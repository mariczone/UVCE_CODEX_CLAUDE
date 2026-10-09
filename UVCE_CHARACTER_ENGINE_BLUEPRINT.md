# UVCE — Unified Virtual Character Engine
## Production-minded Technical Blueprint + Executable POC Plan for a 2.5D Web MMORPG

> **Version:** 1.0 • **Prepared:** 2026-10-09 • **Audience:** Codex CLI / Claude Code / engineer • **Language:** Thai + technical English  
> **Status:** Architecture specification for a new POC; implementation and benchmarks are **not yet completed**.  
> **Target:** เว็บเกม 2.5D แบบ Ragnarok / Samsara Saga: 2D characters ในโลก 3D (Three.js), เปลี่ยนเครื่องแต่งกาย/อาวุธได้, 100–500 visible characters as stress scenarios.

---

## 0. วิธีใช้เอกสารนี้กับ Coding Agent

1. วางไฟล์นี้ใน root repository เป็น `docs/UVCE_CHARACTER_ENGINE_BLUEPRINT.md` หรือเก็บไว้ตามชื่อเดิม.
2. วาง `AGENTS.md` ที่แจกมาด้วยไว้ root repository สำหรับ Codex; Claude Code ให้อ่านไฟล์นี้และใช้ `UVCE_FIRST_TASK_PROMPT.md` เป็นคำสั่งเริ่ม.
3. Agent ต้อง **inspect existing repository first** และ integrate แบบไม่ทำลายระบบเดิม; หากไม่มี repository ให้ bootstrap standalone monorepo POC.
4. ให้ Agent ทำตาม **Milestone 0 → 1 → 2** ก่อน ไม่กระโดดไปสร้าง GPU virtual texturing/ML optimizer โดยขาด baseline.
5. แต่ละ milestone ต้องมี working demo, tests, benchmark artifact และบันทึกข้อจำกัด/ผลวัดจริง.
6. รายการ RunPod / GPT Image / Blender MCP เป็น **optional integrations** สำหรับ Asset Pipeline ไม่ใช่ข้อกำหนดก่อนเริ่มระบบ Renderer.

### คำศัพท์บังคับ
- **MUST** = ต้องทำ, **SHOULD** = ควรทำ, **MAY** = ทดลองหรือทำภายหลัง.
- **Source Atlas** = รูปต้นฉบับ/Equipment ที่ pack แบบ immutable; **Composite Atlas** = รูปที่ GPU ประกอบแล้วเพื่อ cache.
- **Logical Handle** = ID ของ asset ที่ไม่ขึ้นกับตำแหน่งจริงบน GPU; **Physical Atlas Region** = page + UV/rect ปัจจุบัน.
- **Rig** = bone/socket/anchor + deformation representation; ไม่ได้หมายความว่าต้องมี 3D skeleton ทุกตัว.
- **Appearance** = ชุดอุปกรณ์และสี; **Pose** = action + direction + frame/time/rig state.
- **POC** = validate architecture and compare methods; **Production** = hardened, scalable, tested.

---

## 1. Problem Statement และเป้าหมาย

### 1.1 ปัญหาเดิม

การเก็บ Full-body Sprite Sheet แยกสำหรับชุดผสมทุกแบบทำให้จำนวนไฟล์เติบโตตาม combination เช่น 20 hats × 30 armors × 10 weapons = 6,000 full appearance combinations ก่อนนับ hair, direction และ animation. หากผู้เล่น 100 คนแต่งตัวต่างกัน โหลด, RAM, VRAM และงานสร้าง animation จะขยายอย่างรวดเร็ว.

### 1.2 หลักการแก้

1. **Keep equipment modular:** body, head, hair, hat, armor, weapon, shield, cape ฯลฯ เป็น assets แยก.
2. **Share by content:** ผู้เล่นที่ใช้อุปกรณ์เดียวกันใช้ source texture/metadata เดียวกัน.
3. **Separate animation from artwork:** frame/rig/hybrid/procedural representations อยู่หลัง contract เดียว.
4. **Indirect atlas access:** ตัวละครไม่รู้ physical page / UV ของภาพ.
5. **Choose render strategy adaptively:** layered batching vs shader composition vs partial/full composite caching vs LOD.
6. **Load only necessary resources:** dedupe, bundle, stream, prefetch, cache eviction.
7. **Retain correctness:** transparency, drawing order, depth occlusion, alignment, source fidelity มาก่อน benchmark.
8. **Quantify improvements:** test on identical artwork/scene, profile and compare before enabling complex techniques.

### 1.3 Functional success

- Render 1/20/100/300/500 characters ด้วย configuration ที่แตกต่างกัน.
- เปลี่ยน equipment แบบ runtime โดย **ไม่** generate full-body sheet ใหม่และ **ไม่** reload source assets ที่ไม่เปลี่ยน.
- 8 directions and shared animation timeline with correct pivots, attachment and per-direction draw order.
- World 3D + sprites in a **single coordinated depth/composition pipeline**.
- Character editor/preview, stress panel, cache/LOD debug overlay, benchmark export.
- Works in a minimal offline test mode without a RunPod account, image/video model, or Blender installation.

### 1.4 Non-goals ใน POC แรก

- ไม่เขียน Three.js ใหม่ทั้ง engine, ไม่สร้าง new video diffusion model, ไม่ train H3, ไม่ต้องมี MMO backend จริง.
- ไม่บังคับใช้ Sparse GPU Virtual Textures, bindless textures, Neural Compression หรือ GPU-driven indirect renderer ก่อนพิสูจน์ว่าคุ้ม.
- ไม่ต้องทำ asset-quality pipeline 8 directions ครบทั้งหมดก่อนใช้ procedural placeholder test assets.
- ไม่รับประกัน 60 FPS ที่ 500 characters บนอุปกรณ์ทุกชนิด; benchmark result ต้องรายงาน device-specific เท่านั้น.

### 1.5 Key architectural constraints

- Canvas/WebGPU/WebGL renderer ที่ render world และ sprites ควรใช้ **scene/render pipeline เดียวกัน** เพื่อแก้ occlusion กับฉากอย่างถูกต้อง.
- GPU draw calls ที่ต่ำไม่ใช่ KPI เดียว; watch GPU time, texture bandwidth, transparent overdraw, startup, stutter, memory.
- GPU-compressed Source Atlas กับ Writable Composite Atlas เป็นคนละ pool มีอายุและ policy ต่างกัน.
- 3D physics, hitbox, player ID, locomotion และ network state ห้ามผูกกับแค่ UV/atlas slot.
- Shaders must not assume arbitrarily many independent bound textures. Query device limits and use page classes / batches.
- Renderer modes ต้องสามารถปิดได้ด้วย feature flags และ fallback ที่ correctness เหมือนกัน.

---

## 2. สิ่งที่ผู้พัฒนาต้องเตรียมก่อนเริ่ม (Preflight)

### 2.1 Hardware / Software (minimum to start)

| สิ่งที่เตรียม | Required POC | คำแนะนำ |
|---|:---:|---|
| Repository ที่ต้องการต่อยอดหรือ repo ว่าง | Yes | ถ้ามีเกมเดิม ต้องเปิด branch ใหม่ แยก POC route/page |
| Node.js current LTS + package manager (`pnpm`) | Yes | Pin runtime ใน `.nvmrc`/`package.json#engines` |
| TypeScript + Vite + Three.js | Yes | Lock exact versions หลัง install; อย่าทิ้ง caret อัปเดตโดยไร้การทดสอบ |
| Chrome / Edge desktop และ devtools | Yes | บันทึก Browser version/GPU model/OS พร้อม Benchmark |
| Browser WebGL2 | Yes | baseline พื้นฐาน; หากไม่มีให้ขึ้น unsupported message |
| Browser WebGPU | No | alternate accelerated path, gate by feature detection |
| Python 3 + Pillow หรือ Node `sharp` | Recommended | สร้าง deterministic test assets, validation, atlas compiler |
| Playwright + Vitest | Recommended | visual regression, contract tests, automated scene tests |
| Blender + MCP | No | ฝั่งผลิต asset / directional render / attachment authoring |
| GPT Image Generation | No | ฝั่งทำ source character art / equipment references |
| RunPod GPU + image-to-video | No | ฝั่ง motion generation / segmentation / matting optional |
| FFmpeg | No | สำหรับ extract/normalize video frames เมื่อเชื่อม AI pipeline |
| Git LFS / object storage | Conditional | เมื่อมี binary assets จำนวนมาก; POC minimal assets ยังไม่จำเป็น |

**ข้อแนะนำ:** เริ่ม `webgl2-baseline` ที่ตรวจภาพ/ลำดับ draw ได้ก่อน แล้วเพิ่ม `webgpu` renderer adapter ภายหลัง. `WebGPURenderer` ของ Three.js สามารถใช้ WebGL2 backend fallback แต่มีข้อจำกัดเกี่ยวกับ `ShaderMaterial`/`onBeforeCompile` แบบเดิม; POC ควร isolate shader backend abstraction ตั้งแต่แรก. อ้างอิง: https://threejs.org/manual/pages/webgpurenderer

### 2.2 Required inputs — เริ่มได้แม้ยังไม่มีภาพจริง

**Mode A: Synthetic POC (ต้องผ่านก่อน)**
- ใช้ procedural PNG/RGBA ที่ Agent generate เองแบบ deterministic, 8 directions × 8 frames สำหรับ action `idle` และ `walk`.
- ภาพ 256×256 RGBA canvas; ใช้สี/รูปร่าง/ตัวเลขระบุ body/head/hair/hat/armor/weapon เพื่อเห็น order และ tracking.
- 1 base body, 2 hairstyles, 3 hats, 3 armors, 3 weapons, optional cape/shield, รวม 5–8 layers/character.
- มี `appearanceSeed` ที่สุ่ม 100/300/500 characters แบบ reproducible.
- ภาพทดสอบ *ไม่* เป็น benchmark visual quality ของ AI-generated art แต่พอใช้ verify atlas, swap, cache, sorting, memory และ throughput.

**Mode B: Real artwork test (แนะนำหลัง Milestone 1)**
- Full-body master reference 1 character with no background, fixed proportions and direction definitions.
- Separated RGBA: `body`, `head`, `hair_back`, `hair_front`, `armor_back`, `armor_front`, `hat`, `weapon_back`, `weapon_front`, optional `cape`.
- เริ่ม direction `S` และ `SE` 2 มุมสำหรับตรวจ attachment/depth; เพิ่ม 8 directions เมื่อ pipeline ผ่าน.
- อย่างน้อย `idle` 8–12 logical frames และ `walk` 6–8 frames (หรือ rig clip) ตามงานศิลป์; ไม่กำหนดว่าต้องใช้ frame count เดียวกันทุก animation.
- อุปกรณ์ทดลองอย่างน้อย hats 3, armor 3, weapon 3 ที่สวมสลับได้โดยใช้ shared sockets/rig.
- ชิ้นส่วนวาดเต็มด้านที่ถูกบัง (hidden geometry) ตามช่วง deformation; แยก back/front ชิ้นที่ต้องสอดหน้า/หลังตัวละคร.
- ใช้ source size ที่ใหญ่พอสำหรับ LOD, แต่ทุก layer ต้องมี canonical canvas/pivot ทำให้ประกอบได้แบบ pixel-aligned.

**ไม่จำเป็นตอนเริ่ม:** เกมโลกสมบูรณ์, sprite sheet ทุก item, RunPod URL, trained matting models, database/Mongo/Postgres, real player login.

### 2.3 ข้อมูล configuration ที่ควรรวบรวม (ไม่ใช่ blocker)

กรอกใน `.env.example` หรือ `docs/LOCAL_SETUP.md` โดยไม่ใส่ secret จริง:

```dotenv
# Browser app
VITE_ASSET_BASE_URL=/assets
VITE_DEFAULT_BACKEND=webgl2
VITE_ENABLE_AI_ASSET_PIPELINE=false

# Optional backend bridge ONLY (never expose RunPod secret as VITE_ variable)
RUNPOD_MODE=disabled         # disabled | pod-http | serverless
RUNPOD_ENDPOINT_URL=
RUNPOD_API_KEY=
BLENDER_MCP_ENABLED=false
IMAGE_PROVIDER_ENABLED=false
```

- ห้ามฝัง `RUNPOD_API_KEY` ใน browser bundle. ถ้าจะเรียกจริง ให้ผ่าน server-side adapter/proxy เท่านั้น.
- Agent ต้องไม่ invent URL, model name, payload หรือ MCP tool schema; probe/check configuration แล้ว degrade gracefully.
- ถ้าต้องต่อเข้ากับ repo เดิม ต้องตรวจ license, env policy, ports, deploy convention และ `.gitignore` ก่อนแก้ไฟล์.

### 2.4 เกณฑ์ Ready to Start

- [ ] Repository/working branch พร้อม หรือสร้าง POC repo ใหม่แล้ว
- [ ] `node --version`, `pnpm --version`, `git status` ใช้งานได้
- [ ] Browser WebGL2 ตรวจผ่านและบันทึก `GPU/OS/browser` ได้
- [ ] Agent generate procedural RGBA asset fixture ได้โดยไม่ต่อ network
- [ ] Asset schema และ screen/world coordinate conventions ตกลงแล้ว
- [ ] มีหน้า POC ที่แสดง one character + atlas/debug overlay ได้
- [ ] RunPod/GPT/Blender ถูกระบุเป็น optional integration **ไม่บล็อก** งาน Renderer

---

## 3. Character Asset & Coordinate Convention

### 3.1 Direction and frame conventions

- Directions: `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW`; mapping order fixed and versioned.
- Asset/frame-local 2D coordinate: `(0,0)` = top-left; `x` right, `y` down; unit = source pixel.
- Canonical character canvas for initial fixture: 256×256; bottom foot anchor example `x=128,y=228` (example only, not enforced).
- Trimmed image retains `sourceCanvas`, `trimRect`, `pivot`, and optional `bounds` **in canonical coordinates**.
- World Three.js coordinate: `Y` up, feet at character world transform (ground contact); asset-to-world scale explicit.
- Direction selection is determined from character world facing relative to camera projection, not world yaw alone; define and test lookup.
- Do not mirror asymmetric equipment by default; `allowMirror` only when approved by asset metadata.
- Depth/z order can change by direction/frame: e.g. sword in front for SE but behind for NW.
- All equipment sockets must be named consistently (`head_top`, `neck`, `right_hand`, `left_hand`, `back`, `chest`).
- Each frame may carry socket overrides and offsets when full-frame motion changes silhouette or anatomy.

### 3.2 Source PNG guidelines

- True RGBA transparency (no white/black matte); avoid halos and unintended cropped tips.
- Consistent scale, rotation and palette across directions and items.
- Preserve linework thickness/lighting logic; do not use inconsistent blur and pixel rounding per direction.
- `straight-alpha PNG` accepted; renderer/composer must convert/handle alpha correctly and avoid double premultiplication.
- Trim tight but preserve shadow/attachments, extrude edges and pad for texture filtering/mipmaps.
- Color maps use sRGB interpretation; do alpha blending in correct space; consistent output transform.
- Choose nearest filtering for actual pixel art, linear/appropriate mipmap for HD cutout artwork; both need regression tests.

### 3.3 Equipment design and attachment

The source data is **not** one set of full-body frames for each equipment combo.

Example source set:

```text
assets/source/
  characters/novice_01/reference/master.png
  characters/novice_01/parts/body.png
  characters/novice_01/parts/head.png
  characters/novice_01/parts/hair_back.png
  characters/novice_01/parts/hair_front.png
  rigs/humanoid_2d_v1.json
  equipment/hats/hat_01/part.png
  equipment/hats/hat_02/part.png
  equipment/armors/armor_01/part.png
  equipment/weapons/sword_01/part.png
  animations/humanoid/idle.json
  animations/humanoid/walk.json
```

Core idea: static image parts with sockets for Idle; some animated parts may use per-direction sprite frames. A `weapon` can have an attachment transform and per-frame manual override, not necessarily a whole-body sprite sheet.

### 3.4 Input validation (compiler MUST implement)

- image dimensions, alpha channel, unsupported color profile, frames exceeding canvas, transparent blank layer.
- missing socket/attachment/rig-profile mismatch, invalid direction, frame count/duration, layer order cycles.
- pose alignment tolerance and required explicit overrides for outlier frames.
- verify target has transparent pixels and no external matte/baked background.
- warn if PNG from generative AI contains anatomy defects or orientation inconsistency; validation cannot magically fix artwork.
- independent preview must reconstruct a reference composite correctly before atlas packing.

---

## 4. Rendering Architecture — from logical player to GPU

```text
Multiplayer State (playerId, position, motion, equipmentIds)
  -> AppearanceResolver (IDs, versions, dependency graph)
  -> AnimationController (shared clip/pose/socket transforms)
  -> AssetRegistry (logical handles, source dependencies)
  -> AssetStreaming + CPU decode/transcode + GPU residency
  -> Visibility, projected-size LOD, render-cost estimator
  -> RenderPlanner chooses one of:
     A: Layered instanced quads / ordered batches
     B: Shader layer composition
     C: Partial group composite cache
     D: Full appearance/frame composite cache
  -> Scene-integrated depth-aware render ordering
  -> Three.js 2.5D world render
```

### 4.1 Keep these independent

- `CharacterWorldState`: sim/network authority (actor world position, action, facing) **without** sprite details.
- `AppearanceDefinition`: immutable logical look/equipment IDs, dyes and variants.
- `AnimationState`: clip, elapsed ticks/time, direction, local motion data.
- `AssetRegistry`: hash mapping logical asset -> manifest and resident resource.
- `RenderRepresentation`: a chosen way of showing a frame without changing character data.

### 4.2 Rendering modes and tradeoffs

| Mode | GPU work | Extra VRAM | Strength | Risk |
|---|---|---|---|---|
| A: Direct Layered Batch | Multiple sprites/layers per actor with batching | Minimal beyond source textures | Good for unique looks/changes | Draw order can fragment batches; transparent overdraw |
| B: Shader Compose per actor | 1 quad actor, multi-layer texture samples | Minimal intermediate texture | No rebuild after equipment swap | Heavy fragment shader, limits, deformation/occlusion complexity |
| C: Partial Group Cache | Compose torso/head/etc. group to writable atlas | Medium | Reuse groups across players | Sub-group layer order can interleave |
| D: Full Frame Cache | Compose exact pose+appearance to atlas | Potentially high | Cheap re-use for stable animation | Low hit ratio for unique or highly deforming appearance |
| E: Low-LOD simplified | Fewer pixels/details/updates | Usually lower | Crowd scenes | Quality loss, pop-in |

**Rule:** do NOT claim 1 draw per character or universal batching performance. Sort correctness comes first; modes may require multiple passes.

### 4.3 Dynamic rendering plan heuristics

- Default all characters to Mode A until modes B/C/D meet correctness and measurement thresholds.
- Cache mode candidate only when expected reuse savings outweigh compose cost + occupied memory + eviction cost.
- Estimate from projected pixel area, visible layers, changed layers, source atlas page count, cache reuse probability, GPU timings, equipment-swap rate.
- Cost must include precomputation and conversion, not only per-frame draw call count.
- Apply hysteresis/minimum residence interval to prevent thrashing between modes.
- Planner can turn off costly effects for distant NPCs but cannot change hitboxes/network animation truth.

### 4.4 Correct 2.5D sorting, transparency and occlusion

1. Use world-space foot contact and camera projection to generate a stable **character-level order**.
2. Within a character obey per-direction/per-frame part draw order and socket transforms.
3. Preserve inter-character ordering when batching. Do **not** draw all hats across 100 players then all bodies if this violates correct overlap.
4. Minimize batching fragmentation only within safe consecutive painter-order runs; full composites offer another option.
5. Test sprite occlusion with 3D opaque geometry; use meaningful depth handling for alpha-test parts vs blended edges; do not blindly write depth for transparent RGBA sprites.
6. Test two characters crossing each other, bridge/arch occlusion, stairs, left/right foot alignment, and character partially behind a wall.
7. If a single GPU compositing shader cannot preserve independent cape/weapon in front/back order, fallback to layered mode or additional passes.

### 4.5 Alpha compositing correctness

- For **premultiplied alpha**, front-over-back: `C_out = C_front + (1 - A_front) * C_back`, `A_out = A_front + (1 - A_front) * A_back`.
- For straight alpha use the mathematically correct conversion; ensure consistent blending space and no double premultiply.
- Add screenshot tests against CPU reference compositor with same layer order, including partially transparent cloth/hair edges.
- Ensure atlas padding/extruded pixels and mips do not leak colors from adjacent frames.

---

## 5. Suggested monorepo / package ownership

```text
uvce/
  apps/
    benchmark/               # Vite + Three.js interactive stress scene
    asset-preview/           # optional small review UI
  packages/
    character-core/          # logical appearance, rigs, clips, math, pure TS
    asset-schema/            # Zod / JSON schema / examples
    asset-compiler/          # PNG validation, trim, dedupe, pack, bundle
    virtual-assets/          # handles, registry, cache, streamer, residency
    character-renderer/      # planner, render queue, GPU adapters, modes
    benchmark-core/          # deterministic fixtures, telemetry, CSV/JSON
    ai-asset-bridge/         # optional server-side RunPod/GPT/Blender adapters
  assets/
    source/                  # hand-authored/AI-rendered PNGs
    fixtures/                # generated synthetic reproducible inputs
    compiled/                # generated output; gitignored unless fixtures
  docs/
    decisions/               # ADRs for tradeoffs
    benchmark-results/       # reports, hardware description, screenshots
    UVCE_CHARACTER_ENGINE_BLUEPRINT.md
  tools/
    generate-fixtures.*
    validate-assets.*
  AGENTS.md
  package.json
  pnpm-workspace.yaml
```

Use existing repository's structure if already present. Do not introduce monorepo migration unless it is clearly advantageous or the user explicitly approves a restructuring. Keep boundary/interfaces equivalent even in a single app.

---

## 6. TypeScript Data Contracts (v1 proposal)

The following are normative **design examples**, not a claim of tested implementation. Agent should implement Zod/JSON schema or equivalent validation, migrations and unit tests.

```ts
export type Direction8 = 'N'|'NE'|'E'|'SE'|'S'|'SW'|'W'|'NW';
export type Representation = 'FRAME'|'RIG'|'HYBRID'|'PROCEDURAL';
export type RenderMode = 'LAYERED'|'SHADER'|'PARTIAL_CACHE'|'FULL_CACHE';
export type SocketName = 'head_top'|'neck'|'right_hand'|'left_hand'|'back'|'chest';

export interface Vec2 { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface AssetRef { id: string; version: string; contentHash: string }

export interface SpriteFrame {
  source: AssetRef;
  sourceCanvas: { width: number; height: number };
  trimRect: Rect;              // in original canonical canvas pixels
  pivot: Vec2;                 // in original canonical canvas pixels
  durationMs: number;
  socketOverrides?: Partial<Record<SocketName, Vec2>>;
  localOffset?: Vec2;
}

export interface LayerDefinition {
  slot: string;
  asset: AssetRef;
  representation: Representation;
  parentSocket?: SocketName;
  drawGroup?: 'BACK'|'BODY'|'FRONT';
  framesByDirection?: Partial<Record<Direction8, SpriteFrame[]>>;
  allowMirror?: boolean;
}

export interface RigProfile {
  id: string;
  version: string;
  canonicalCanvas: { width: number; height: number };
  footPivot: Vec2;
  socketsByDirection: Record<Direction8, Partial<Record<SocketName, Vec2>>>;
}

export interface ClipDefinition {
  id: string;
  durationMs: number;
  loop: boolean;
  directionSet: Direction8[];
  representation: Representation;
  // Stable clip sampling/timing; per-layer frames can differ but sync to clip time.
  events?: Array<{ timeMs: number; name: string }>;
}

export interface EquipmentSlot {
  asset: AssetRef;
  dye?: Record<string, string>;
  hidden?: boolean;
  variant?: string;
}

export interface AppearanceDefinition {
  rigProfileId: string;
  body: AssetRef;
  head: AssetRef;
  slots: Record<string, EquipmentSlot>;
}

export interface AnimationState {
  clipId: string;
  direction: Direction8;
  elapsedMs: number;
  speed: number;
  phaseOffsetMs?: number;
}

export interface CharacterInstance {
  entityId: string;          // runtime reference; never cache key
  position: { x: number; y: number; z: number };
  facingYawRadians: number;
  appearance: AppearanceDefinition;
  animation: AnimationState;
  visible: boolean;
}

export interface VirtualSpriteHandle {
  index: number;
  generation: number;         // guard recycled handle / ABA problem
}

export interface PhysicalSpriteRegion {
  atlasClass: string;
  pageId: number;
  uvRect: Rect;               // normalized UV coordinates
  pixelSize: { width: number; height: number };
  residentVersion: number;
}

export interface CompositeCacheKey {
  partGroupHash: string;      // covers assets, render order, dyes, sockets, shader version
  clipId: string;
  direction: Direction8;
  poseKey: string;            // quantized pose only if visual error is acceptable
  resolutionTier: number;
  compilerVersion: string;
}

export interface CharacterRenderMetrics {
  backend: string;
  visibleCharacters: number;
  visibleLayers: number;
  drawCalls: number | null;
  cpuFrameMs: number;
  gpuFrameMs: number | null;   // optional timer query support
  sourceEstimatedBytes: number;
  compositeEstimatedBytes: number;
  pendingDownloads: number;
  pendingUploads: number;
  cacheHitRatio: number;
  cacheEvictions: number;
}

export interface ICharacterRenderer {
  prepareFrame(characters: readonly CharacterInstance[], nowMs: number): void;
  render(): void;
  getMetrics(): CharacterRenderMetrics;
  dispose(): void;
}
```

### 6.1 Event semantics

- `equipmentChanged(entityId, slot, assetRef)` updates only logical appearance and dependent caches; no forced full scene reload.
- `animationStateChanged` uses same runtime timer and clip IDs for all appearance layers of the same character.
- `assetResident(handle)` updates physical mapping; uses stable logical reference.
- `assetEvicted(handle)` marks nonresident; renderer uses placeholder or lower LOD until resident.
- `contextLost` releases GPU handles; logical character states stay intact.

### 6.2 Deterministic appearance hashing

- Serialize ordered slot names, content hashes, variants, dyes, rig and shader versions canonically.
- Never include world position/entity ID unless the pixel result genuinely depends on it.
- Include animation pose/time only for cached *rendered frames*; source assets can be shared independently of phase.
- On change, invalidate only affected dependency graph nodes (`head` group rather than `torso` if only hat changes).
- Quantized pose sharing is optional: if compression introduces visible snapping, turn off.

---

## 7. Asset Compiler / Build Pipeline

### 7.1 Pipeline

```text
Source PNG/PSD-export/Blender Render
 -> input schema + RGBA validation
 -> canonical alignment and alpha checks
 -> optional trim with retained original canvas/pivot
 -> exact dedupe (content hash) + duplicate animation frame elimination
 -> edge extrusion and padding
 -> tight atlas packing by usage/LOD/render-material class
 -> generate per-frame atlas metadata and content-addressed bundles
 -> optional KTX2 encoding (only after PNG baseline correctness)
 -> manifest integrity hashes + checksum/size report
 -> visual reference composite/regression images
```

### 7.2 Recommended build options

- Deterministic pack with fixed seed/order/config; track `compilerVersion` in manifest.
- Separate groups with different filtering requirements (pixel art nearest vs HD cutout linear).
- Choose gutter/extrusion with intended mip/filter strategy; do not assume 1px gutter works for all mip levels.
- Keep source PNG as build input; runtime bundle may be GPU-compressed.
- Use `KTX2Loader` or equivalent for compressed assets if hardware supports, with PNG fallback for compatibility and quality.
- Content hash can identify same pixel content even under different logical alias names; use explicit aliases.
- Split source asset bundles based on actual co-use, not just large universal atlas. Avoid 1 request per tiny frame.

### 7.3 Lossless and lossy opportunities

- **Lossless P0:** trim whitespace, exact identical frame dedupe, canonical asset dedupe, stable rig offsets instead of re-exporting still equipment.
- **Low-risk P1:** offline usage-aware atlas pack, palette/dye parameterization, LOD variants, duplicate pose cache.
- **Experimental P3:** temporal residual patches, low-rank/rate-distortion hybrid keyframes, flow/deformation compression, per-pixel procedural shader. Must include quality and decode cost comparison.

### 7.4 Four animation representations

1. `FRAME`: original full per-frame artwork (needed for complex action silhouettes).
2. `RIG`: a few images + bones/socket transforms/mesh morphs, suited for idle breathing, hair/cape sway.
3. `HYBRID`: keyframes + deformation curves + bounded residual corrections to preserve artistic details.
4. `PROCEDURAL`: glow/aura/particles/simple VFX from params rather than pixel sheet per frame.

All must use shared clip clock and compatible attachment conventions. For first milestone implement `FRAME` only + sockets; next `RIG`, then other formats behind feature flags.

---

## 8. Virtual Asset Registry, Streaming, GPU Residency

### 8.1 Resource state machine

```text
UNRESOLVED -> REQUESTED -> FETCHING -> DECODED -> UPLOAD_QUEUED -> RESIDENT
     |           |             |             |                 |
     +--------> FAILED/RETRY_BACKOFF <--------+-----------------+
RESIDENT -> EVICTION_PENDING -> EVICTED -> REQUESTED
```

- Logical asset reference remains valid while physical region changes.
- Do not present a freed/recycled GPU slot as active because handle generations or asset version did not match.
- Queue decode/transcode in workers where feasible; schedule bounded GPU uploads per frame.
- Support cancellation/deduplication of identical pending requests.
- Pin assets used in the current render submission; evict safely only after GPU work using them has completed / resource lifetime is guaranteed by backend.
- Release composite cache before shared heavily used source atlas when memory pressure rises, unless metrics prove otherwise.
- Keep a lower-LOD fallback resident for nearby but not fully loaded appearance where possible.
- Do not blindly trust `performance.memory` or estimate total GPU VRAM via browser; track renderer-owned bytes as estimates.

### 8.2 Memory / cache layers

| Layer | Data | Policy |
|---|---|---|
| HTTP/CDN/browser disk cache | Versioned source bundles | Immutable URL/hash, cache-control |
| CPU decode cache | Raw/decoded RGBA, metadata | Bounded LRU/TTL; reference count |
| GPU source page pool | Immutable KTX2/PNG upload | Asset sharing, page residency, pin + safe evict |
| GPU composite page pool | Writable RGBA8 render targets | Budget, weighted LRU, rebuildable |
| GPU lookups | Handle -> current page, UV, pivot | Compact, updated on compaction/eviction |

### 8.3 Budget defaults (examples, configurable)

- Start conservative and adapt after profiling: desktop source budget **256 MiB** + composite **64 MiB**; mobile substantially lower by capability profile. These are **initial test parameters**, not universal device limits.
- Example 2048×2048 RGBA8 atlas page = `2048² × 4 / 2²⁰ = 16 MiB` excluding mips/overheads.
- 128×128 RGBA8 cached frame = 64 KiB; full cache of 100 unique characters × 8 frames = ~50 MiB before padding/mips (source data excluded).
- 256×256 RGBA8 cached frame = 256 KiB; 100 × 8 frames = ~200 MiB — composite caching can become expensive quickly.
- Maintain high/low-water marks; avoid per-frame allocate/free thrashing.

### 8.4 Virtual handle indirection

- `VirtualSpriteHandle { index, generation }` and immutable `AssetRef` are distinct.
- A physical page can be moved/repacked without changing gameplay appearance reference.
- Update region lookup atomically at frame boundaries; never mutate UV page mapping mid-render in a way that affects in-flight submissions.
- Source pools are immutable. Composite pages are writable and can reuse slots via allocator (grid/skyline/free-rect; compare fragmentation).
- Defragmentation is a later optimization, not a prerequisite for usable allocator.

---

## 9. Partial / Full Composite Cache and Shader Composition

### 9.1 Group layout

```text
BACK       : cape_back, hair_back, weapon_back, armor_back
TORSO      : body + armor torso (can share with same torso appearance)
HEAD       : head + hair parts + hat (can share when same group)
FRONT      : weapon_front, shield, cloth_front
```

This is a conceptual group; **actual layer order must be modeled as ordered segments**, because head and arm/weapon may interleave. Do not force group compositing when true order needs interleaving; split segments or fallback.

### 9.2 Composite key correctness

Cache input needs art-affecting state: `partGroupHash`, direction, pose/frame, quality tier, renderer/compiler version, atlas color/filter handling, draw order, cloth or rig deformation, dye/variant. Omit `playerId`, `networkId` and world position when output does not depend on them.

### 9.3 Shader composer limitations

- Multi-layer sampling within single shader may be faster for unique appearances but can become texture-bandwidth heavy.
- Dynamic branching, layer bounds checks and samplers/bind groups have hardware constraints.
- Single-quad composition cannot trivially represent detached weapon depth vs other world objects, multiple disjoint deformations or complex interleave; allow fallback.
- If using WebGPU/TLS or WGSL, pin renderer version and test device limits; do not assume true bindless textures.
- Never assert visual equivalence without per-pixel screenshot test.

### 9.4 Modes acceptance

- A layered baseline must produce reference output.
- B/C/D must match baseline within chosen tolerance with correct alpha/occlusion.
- Planner must demonstrate no cache misuse after rapid swaps, animation phase differences, LOD switches.
- Measure transition spikes and memory; prefer baseline where expensive mode provides no repeatable win.

---

## 10. Rendering & Animation Scheduling

- One authoritative animation clock per character, then sample all component poses via same time; layer frame durations may differ.
- Static equipment follows sockets; deforming cloth can be driven by rig or per-frame animation.
- Frustum/visibility cull characters before expensive processing; only prefetch data for near-future arrivals.
- Projected screen height governs LOD more reliably than unprojected world distance alone.
- Optionally update *visual animation pose* less often at small sizes (e.g. 8–15 Hz), still render world at target frame rate.
- Server/physics simulation state remains unaffected by visual animation throttling.
- CPU animation can be baseline; GPU-side clip lookup is P3 optimization when large instance counts justify it.
- Movement/attack motion synchronization must use time stamps/clip IDs, not blindly share every character's start time.
- Shared cache frames may still be reused across different phase offsets by resolving each character to same source frame.

### Example LOD policy (tunable, not normative quality guarantee)

| Projected height | Suggested detail | Notes |
|---|---|---|
| >150 px | High source, full animation | Near hero/main characters |
| 80–150 px | Medium, trim unimportant effects | Blend smoothly on switching |
| 30–80 px | Low, low-rate animation | Prioritize silhouette |
| <30 px | Impostor/few frames or reduced animation | Maintain readable equipment colors |

Use **hysteresis** on screen size thresholds, cross-fade/consistent frame mapping where feasible and cap per-frame asset uploads.

---

## 11. Multiplayer / Appearance Streaming

**Server should send IDs + pose/network states, not character image blobs.** Example event:

```json
{
  "type": "appearance.changed",
  "entityId": "player-002",
  "appearanceRevision": 37,
  "changes": { "hat": "hat_003", "weapon": "sword_007" },
  "assetManifestVersion": "dev-v1"
}
```

- Treat revisions as monotonic per entity to avoid out-of-order accessory changes.
- Interest management/prefetch can broadcast logical appearance before entering viewport.
- Client uses manifest resolver to request only absent source dependencies.
- Use placeholders or low LOD while pending, without blocking world simulation or halting animation.
- Streaming requests dedupe across 100 players; cancel unneeded high LOD jobs; maintain shared low-quality fallback.
- Hot patch/version changes must invalidate changed asset hashes; stale references should not corrupt atlas lookups.

---

## 12. Existing Tools Integration — RunPod / GPT Image / Blender MCP

### 12.1 Two independent development tracks

**Track R — Real-time Renderer & Asset Runtime:** no AI inference or GPU server required; deterministic test assets, browser GPU, source manifests, repeatable benchmark.

**Track A — Optional AI Asset Factory:** generates/imports images and animation that become validated Source Assets. Only connect after asset contracts and compiler already work with synthetic assets.

### 12.2 GPT Image Generator — suggested outputs

- `character_master_{direction}.png`: consistent model sheet/style reference; not a separate wardrobe combination.
- RGBA `hair_front`, `hair_back`, `head`, `torso`, `cape`, `hat`, `armor`, `weapon` as separate components.
- For consistency, use canonical master as reference; require unchanged scale, camera angle, costume fit, attachment anchors, outline and proportions.
- Store prompts, seeds (if supported), model/version, timestamps and human validation notes as provenance; do not assume seed control exists on every provider.
- For a single item, prefer one master image + layers and use rig or Blender to create consistent directions rather than independently generating 8 unrelated character variants.
- If output has opaque background or inconsistent silhouette, fail validation or request human correction; don't silently accept.

### 12.3 Blender + MCP — where it adds highest value

Blender can be used as **offline asset tool**, not runtime renderer:

1. Maintain a canonical character rig/sockets in 3D or 2.5D board/cutout.
2. Set a deterministic orthographic/isometric camera, lighting, material and fixed character scale.
3. Render 8 directions from a common rig (32/45-degree yaw convention must align to `Direction8`).
4. Export RGBA image sequences with Film Transparent and transparent background.
5. Export/or compute sockets per frame and direction, pivots, trim metadata and animation ID.
6. Use MCP to automate Blender scene setup/render/export/validation **after inspecting the actual MCP tools available**.
7. No need to model every item in 3D if source art is hand-painted; Blender may be used only for anchors, motion, visibility and camera rigs.

Suggested output:

```text
asset-factory/blender-output/
  novice_01/
    S/idle/frame_000.png ...
    SE/idle/frame_000.png ...
    rig-sockets.json
    render-settings.json
```

Blender official rendering guidance: https://docs.blender.org/manual/en/latest/render/output/introduction.html

### 12.4 RunPod GPU — optional AI animation service

Use existing RunPod deployment as a **separate asset-processing backend**, not as remote renderer for every player frame.

Potential jobs:
- `generate_master_video`: full-body art → motion reference video.
- `track_motion_and_masks`: segment hair/head/torso/equipment and derive frame-wise motion.
- `extract_rig_curves`: estimate shared clip curves for body/head/hair/cloth.
- `render_layered_rgba`: optional layer generation/matting/inpainting.
- `validate_animation`: temporal consistency and loop reports.

**Important:** A full-body video reference plus separate per-part model generation does **not** guarantee 100% frame-accurate synchronization. When exact alignment is needed, use a shared motion field/rig/anchors or extract visible regions from master + correct missing content. Treat generated content as authoring candidates needing review.

Create a neutral server-side adapter:

```ts
export interface AssetJobRequest {
  jobType: 'generate_master_video'|'track_motion_and_masks'|'extract_rig_curves'|'render_layered_rgba';
  inputAssetUris: string[];
  prompt?: string;
  options: Record<string, unknown>;
  pipelineVersion: string;
}
export interface AssetJobStatus {
  jobId: string;
  state: 'queued'|'running'|'succeeded'|'failed'|'cancelled';
  progress?: number;
  outputUris?: string[];
  error?: string;
}
```

- For existing **GPU Pod** with exposed HTTP, use its configured proxy/secure endpoint; **Serverless** can use queue-based jobs and async status. Never assume which one the user has.
- Secrets in server env only. Asset output into configured object storage/versioned file store. Browser receives safe temporary URLs or processed asset manifests only.
- Sanitize file names/size, enforce timeouts/concurrency, retries, idempotent job IDs and cancellation where provided by backend.
- Maintain optional `AI_ASSET_PIPELINE_ENABLED=false` so renderer/demo remains fully operational offline.
- **RunPod API integration:** use current supported interface; RunPod documentation states management REST v1 is deprecated and due for retirement 2026-11-15, so prefer v2 for new management integrations and verify with current docs. The *inference endpoint* of existing service may have its own API contract and must be probed instead of guessed.
- Current docs: https://docs.runpod.io/ and https://github.com/runpod/docs/blob/main/serverless/endpoints/overview.mdx

### 12.5 AI pipeline input/output acceptance

Each generated or imported asset must conform to `AssetSchema`:

| Gate | Validation |
|---|---|
| Composition | Recombines into full body at canonical pivot/scale |
| RGBA | Transparent backgrounds, no cut edges/halos |
| Consistency | 8-direction identity, body proportions, equipment sockets consistent |
| Animation | Clip timing, stable foot anchor, per-frame ID/metadata, exact action name |
| Quality | Temporal flicker, line thickness, limb drift, trailing artifacts inspected |
| License | Model/tool/generated asset usage permissions documented; do not assume commercial rights |
| Runtime | Compiler converts to source atlas + manifest independent of AI provider |

If generated animation has no layer structure, isolate as `FRAME` reference/preview; do not fake editable layers.

---

## 13. Correctness Test Matrix

### 13.1 Mandatory functional tests

- Appearance hash deterministic, identical appearances share source cache while different dyes/variants are distinct when needed.
- Switching one hat leaves torso/weapon resident and unchanged; head group invalidates only if actually affected.
- Missing/corrupt asset shows fallback and error event; never crashed infinite retry.
- 8 directions, direction-dependent equipment front/back and anchor alignment.
- walk→idle→attack change without frame time drift/sprite desync.
- Different animation phase offset for two players with same appearance uses shared frames without shared clock bugs.
- Transparent edges, hair matte, sprite outline and bleeding near neighbor atlas sprites.
- Sort two overlapping players and transparent bridge/wall, back/front weapon pass.
- Camera zoom/rotational camera if allowed, resizing, DPR 1/2 and pixel snapping.
- Resource eviction and re-request stable, no stale generation handles.
- Rapid equipment swap 20 times and remove/create 500 entities; after stabilization memory returns to expected cache watermark.
- Context/device lost handling: retain logical game state and rebuild GPU resources or fall back gracefully.

### 13.2 Visual tests

- CPU deterministic reference compositor generates a full-character PNG for a fixed pose/direction.
- Compare Mode A/B/C/D screenshots to reference with alpha-aware tolerance; screenshot generated on same GPU/viewport settings.
- Create golden shots for `S`, `SE`, `NW`, animation changes, camera occlusion, extreme transparency.
- If packed/padded/compressed atlas differs, display difference heatmap, count wrong pixels, and document tolerance.
- Record reproducible test seed, asset version, browser, renderer backend, DPR, texture filter.

### 13.3 Performance scenarios

| Scenario | Visible players | Unique looks | Motion | Cache |
|---|---:|---:|---|---|
| A: baseline | 1–20 | 0–100% | idle | cold + warm |
| B: town | 100 | ~50% | idle/walk | cold + warm |
| C: busy town | 300 | ~90% | mixed | warm |
| D: stress | 500 | 100% | mixed + swaps | cold + warm |
| E: shared-look | 300 | 5% | idle | warm |
| F: churn | 100–300 | 50% | frequent hat/weapon swaps | fluctuating |
| G: streaming | 100 | mixed | camera move/enter area | throttled network |

`0% unique` means low uniqueness / high sharing in this table; define exact counts for fixtures instead of dividing by zero or assuming impossible absolute zero.

**Benchmark fairness:** same art, positions, number visible, DPR, viewport (e.g. 1920×1080), animation mix, scene geometry, shader-quality parity, deterministic seed and warmup. Run ≥3 captures/condition; report median and P95 for FPS/frame time, memory estimates, cache, load size, uploads, overdraw proxies, GPU time if available.

### 13.4 Metrics and instrumentation

At minimum collect:
- CPU frame time P50/P95/P99, simulation/update/render-prep breakdown if possible.
- GPU frame time if supported (else `null` and note missing capability).
- Draw calls, triangle/quad counts, visible layers, stage timings (web GL renderer stats with caveats).
- GPU source/composite allocated bytes estimates and page fragmentation.
- Asset fetch requests/bytes, duplicate avoided requests, cache hit/miss, upload bytes/frame.
- CPU heap estimate optional only where supported, JS main-thread long tasks.
- Visual mismatch statistics against reference compositor.

Produce `docs/benchmark-results/<timestamp>/summary.json`, `.csv`, screenshots and `README.md` documenting hardware/config/commit.

### 13.5 Initial performance targets, not promises

- Optimize on a **specified** desktop GPU/driver, browser and 1080p scenario; first target 100 visible characters at ~60 FPS total scene (P95 frame ≤16.7 ms, if feasible).
- Then target 300 characters at acceptable responsiveness/quality; 500 is stress goal, may reduce detail.
- Character pass GPU time ≤4 ms is a **stretch target**, not measured fact; device/resolution must be documented.
- No correctness regression, no unbounded CPU/GPU memory rise during churn, no unrecoverable missing sprite after eviction.
- Do not present unmeasured theoretical speedups as results.

---

## 14. Milestone Plan / Agent Task Breakdown

### Milestone 0 — Repo Audit & Deterministic Fixture, MUST first

Tasks:
1. Inspect existing repo, `package.json`, renderer code, asset loader, character components, test infra; write a short audit and design decisions.
2. If repo empty, create Vite/TS/Three.js/pnpm setup with a route for POC; set fixed dependency versions.
3. Add `character-core` types, validated manifests, directions/sockets, deterministic placeholder RGBA fixture generator.
4. Build simple one-character viewer with per-layer toggle, direction switch, animation selector, equipment selector, true transparency check.
5. Add tests for manifest, direction lookup, pivot and hash; snapshot reference composite.

**Exit:** One character with changeable hat/armor/weapon, no outfit-sheet regeneration, compiled sample assets, first screenshots and tests passing. Asset factory/cloud services not used.

### Milestone 1 — Functional Modular Renderer / Reference Baseline

Tasks:
1. Add `AppearanceResolver`, `AnimationController`, `SourceAssetRegistry`, one normalized canvas/world projection.
2. Implement `LAYERED` renderer with correct per-character layer order and overlap sorting.
3. Render 1/20/100/300 characters; debug overlay for loaded source atlas and asset cache.
4. Implement reference CPU compositor (golden image) and automated screenshots.
5. Measure baseline network, CPU, GPU if available, memory estimates, draw calls, correctness.

**Exit:** Baseline is correct, deterministic, benchmark report committed/archived.

### Milestone 2 — Compiler / Shared Atlas / Streaming

Tasks:
1. Deterministic PNG trim/dedupe/pack with pivot metadata, gutters and optional mip-safe extrusion.
2. Introduce content-addressed manifests and logical sprite handles.
3. Add shared registry dedupe, request cancellation, retry/backoff, placeholder fallback.
4. Add GPU page residency budget and generation-safe eviction, asset resumption.
5. Implement 100 actors equipment swap storm test and cache correctness tests.
6. Benchmark PNG vs optional KTX2 on source atlas after baseline.

**Exit:** Duplicate assets fetched only once per content hash/session, runtime swap doesn't reload unchanged assets; no stale atlas handle glitches.

### Milestone 3 — Advanced render mode comparisons

Tasks:
1. Implement `PARTIAL_CACHE` for safe non-interleaving groups first; compare screenshot correctness.
2. Implement `FULL_CACHE` with composite page allocator and reference count/budget.
3. Implement `SHADER` composition behind capability flags with safe fallback.
4. Toggle modes in UI; benchmark same stress matrix; compare cost and visual fidelity.
5. Implement first heuristic `AdaptiveRenderPlanner`, with hysteresis, feature flags.

**Exit:** Every enabled mode visually correct; report clearly says which wins per workload. Modes that lose stay disabled by default.

### Milestone 4 — Animation representations, LOD and multiplayer-style streaming

Tasks:
1. Shared socket rig with Idle/Walk and optional hair/cape secondary motion.
2. FRAME + RIG support; HYBRID behind experimental flag.
3. Projected-size LOD and adaptive visual animation budget; no simulation changes.
4. Synthetic nearby-player appearance broadcast, dependency prefetch, queued GPU uploads.
5. Full 3D scene occlusion/bridge/crossing tests with realistic sprite artwork.

**Exit:** 100/300 crowd can switch LOD and equipment without harsh popping; stats and acceptance tests pass.

### Milestone 5 — WebGPU and experimental GPU optimizations

Tasks:
1. Add WebGPU backend *without breaking WebGL2 baseline*; test TSL/node materials and GPU capabilities.
2. Investigate GPU-side animation lookup, indirect draw/compute culling only with measurements and proper extension support.
3. Experiment with residual animation compression, value of content DAG cache reuse, automatic cost model tuning.
4. Record regressions and back out losing techniques; device-lost recovery.

**Exit:** benchmarks and performance deltas on at least two capability profiles; fallback stable; no false claims.

### Milestone 6 — Optional AI/Blender asset adapter

Tasks:
1. Inspect actual RunPod endpoints/Blender MCP schemas securely; add env configuration and health checks.
2. Add backend-only async asset-job adapter (`generate_master_video` etc.), upload/download/provenance validation.
3. Import output RGBA layers, 8-direction Blender renders, or extracted video frames to Asset Compiler.
4. Keep per-part gen as experimental; require shared motion/rig extraction for deterministic alignment.
5. Human review page for masks, frame mismatch, anchors and render quality.

**Exit:** Able to import one external/generated character animation into same runtime manifest while offline fixture pipeline still works.

---

## 15. MVP UX / Developer Tools

Create simple no-frills dev app:

- Center: isometric 3D ground + characters; camera controls, orthographic reference toggle.
- Sidebar: count (1/20/100/300/500), outfit uniqueness %, visible layers, sprites/frame size, random seed, animation, direction, LOD policy.
- Render modes: layered, shader, partial cache, full cache, adaptive; unsupported mode disabled with explanation.
- Resource: source pages thumbnails, composite pages occupancy, live loaded/missing/evicted resources, pending fetch/upload.
- Debug: show character pivot, sockets, per-layer bounding boxes, draw order, world feet sorting, background occluders.
- Perf: CPU P50/P95/P99, GPU where supported, draw calls, loaded bytes, estimated GPU bytes, hit rate and page fragmentation.
- Controls: reset cache, swap outfits for random subset, force load miss, simulate slow network, export benchmark CSV/JSON, capture screenshot.

**No permanent dashboard backend or complex auth required for the POC.**

---

## 16. First Agent Session: exact execution contract

On first run, Agent MUST:

1. Read this whole spec and `AGENTS.md`.
2. Inspect actual repo, dependencies, current character/renderer code; record findings in `docs/UVCE_REPO_AUDIT.md`.
3. Start with Milestone 0; **do not** perform broad unrelated refactors, API migrations or modify deployment settings.
4. If there are no real input images, generate clear dummy sprites from seeded shapes and test that works now.
5. Deliver a local browser page plus compile script, asset fixture manifest, unit tests and short instructions.
6. Run available `lint`, `typecheck`, `test`, `build`; report commands run and outcomes; avoid claiming unrun tests passed.
7. Record performance numbers only after a reproducible browser benchmark, with hardware/browser details.
8. Preserve optional adapters disabled by default. Never commit secrets or request creds until that milestone.
9. List tradeoffs and the next unimplemented milestone precisely, including any blockers.

### Initial executable command guidance

If new repo, agent should choose appropriate package versions, set up scripts and make these examples work:

```bash
pnpm install
pnpm generate:fixtures
pnpm assets:build
pnpm test
pnpm typecheck
pnpm dev
```

Exact scripts can vary in existing repositories; document the actual commands after implementation. No fabricated “all tests pass” statements.

### Initial requested deliverables

- `docs/UVCE_REPO_AUDIT.md`
- `docs/UVCE_ARCHITECTURE_DECISIONS.md` (ADRs on backend/canvas/rig/sorting/cache)
- runnable example app + 1 composited character + 8-direction controls
- deterministic fixture generator and validated manifest
- changeable equipment and correct sorting/foot anchors
- `docs/benchmark-results/baseline/` with test protocol even before numeric results
- tests and screenshot diffs
- short milestone report including **What works / What is missing / Risks / Next milestone**.

---

## 17. Risks, Traps, Anti-patterns

1. **Generating a full sprite sheet per equipment combination:** content explosion; reject as core architecture.
2. **Assuming every character requires a GPU texture copy:** source images shared by asset ID/hash.
3. **Trying to batch hats across players at the expense of painter order:** correctness failure.
4. **Single-quad shader for all cases:** may break off-body weapons/occlusion or increase texture sampling; retain fallback.
5. **Full composite cache always faster:** memory + cache misses + recompose can lose.
6. **Compression output always visually safe:** alpha/outline bleed and platform support vary; screenshot-check.
7. **Trusting imported AI PNG alignment:** validate pivots and visual silhouette per direction.
8. **Browser-side GPU calling RunPod for every active character:** architecture/cost/latency mistake; remote AI is offline authoring only.
9. **RunPod API key in client `.env`:** security issue; server-only secret.
10. **Training a model just to start renderer POC:** large unnecessary dependency.
11. **Creating all optimizers before baseline benchmarks:** cannot prove value, high debugging complexity.
12. **Assuming device support from one browser:** feature detect and have fallback.
13. **Relying on one-liner `InstancedMesh` to handle arbitrary materials/textures:** batching requires compatible material/atlas and sorting design.
14. **Evicting GPU atlas slot too early:** stale handles/flicker; frame-safe residency and generations.
15. **Conflating measured GPU VRAM and owner-calculated allocation estimate:** report separately.
16. **Treating deformable rig appearance cache without pose in key:** incorrect reuse.
17. **Ignoring mesh/rig rotation direction:** x/y offset and reverse order break when facing NW vs SE.

---

## 18. Definition of Done, milestone-specific

**At Milestone 0:** Demo shows 1 character switching 3 hats, 3 armors, 3 weapons, 8 direction support (synthetic is fine), correct alpha; validation and unit tests.

**At Milestone 1:** 100 entities in browser, visually correct overlap and animations, shared source handle, deterministic replay and recorded baseline.

**At Milestone 2:** Runtime atlas cache/residency, no repeat downloads for same asset hash, safe evict/reload, equipment swap changes only necessary dependencies.

**At Milestone 3:** At least two render modes work on same inputs; screenshot parity and performance benchmark; planner no catastrophic mode thrashing.

**At Milestone 4:** Real art import (2 directions first), shared rig/direction/attachment, LOD and prefetch, crowd scenes 100/300 with report.

**At Milestone 5/6:** WebGPU fallback and optional AI asset bridge implemented and validated independently, no regressions of browser-only POC.

**Overall:** architecture is extensible, correct under test, no exponential outfit-sprite generation, code reviewed, version-locked dependencies and reproducible benchmark methodology.

---

## 19. Additional R&D Queue (not POC blockers)

Potential experiments to prioritize only after profiling:

- Dynamic atlas allocation: grid vs skyline vs free-rect allocator, fragmentation/compaction, multi-resolution page classes.
- Per-part composite cache sharing, dye/post-composite masking, color palette index textures.
- GPU-side animation frame lookup and directional layer-order tables.
- Geometry trimming/tight mesh silhouettes to reduce alpha overdraw.
- Temporal residual compression for AI-produced sprites (rate-distortion vs runtime cost).
- Procedural cloth/hair movement driven by common motion curves from a video.
- Render pipeline instrumentation for browser GPU timer queries and device-lost repro.
- Usage/co-occurrence-aware asset bundling with CDN immutable manifests and patches.
- LoD or direction-specific bundle streaming and background asset prefetch.
- MMO interest-management prioritizing appearance manifests ahead of character visibility.
- Shared cache composition across exact appearance group IDs; weighted eviction by expected future reuse.
- Asset Factory loop: GPT Image/Blender directions + RunPod video + optional video mask tracking + alpha validation + compiler.

---

## 20. Technical References / Current Verification

The agent should re-check docs against pinned library versions before implementing APIs. These are **references**, not claims that techniques automatically perform best.

- Three.js `WebGPURenderer` (WebGL2 backend fallback; materials migration caveat): https://threejs.org/manual/pages/webgpurenderer
- Three.js `WebGPURenderer` API: https://threejs.org/docs/pages/WebGPURenderer.html
- Three.js `WebGLRenderer` API: https://threejs.org/docs/pages/WebGLRenderer.html
- Three.js `InstancedMesh` (same geometry/material shared instancing): https://threejs.org/docs/pages/InstancedMesh.html
- Three.js `BatchedMesh` multi-draw: https://threejs.org/docs/pages/BatchedMesh.html
- Three.js `KTX2Loader`: https://threejs.org/docs/pages/KTX2Loader.html
- WebGPU device limits: https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/limits
- WebGPU device lost: https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/lost
- Blender render output and image sequences: https://docs.blender.org/manual/en/latest/render/output/introduction.html
- RunPod current docs: https://docs.runpod.io/
- RunPod serverless endpoint overview: https://github.com/runpod/docs/blob/main/serverless/endpoints/overview.mdx
- RunPod REST API v2 announcement (2026-08-25): https://www.runpod.io/blog/runpods-rest-api-v2-is-here-one-api-for-your-entire-gpu-stack

---

## 21. Pre-implementation decisions to record as ADRs

Before coding beyond Milestone 0, write actual decisions for:

1. Existing repo integration or standalone POC, and allowed directories.
2. World orientation, camera conventions, sprite foot pivot, `Direction8` mapping.
3. Transparent layering and 3D depth/occlusion strategy with screenshot proof.
4. Backend path (`WebGLRenderer` baseline; WebGPU optional), how shader compatibility is isolated.
5. Texture filtering/correct color space/alpha compositing/padding.
6. Sprite frame dimensions and resolution tiers (default 256×256 fixture only).
7. Manifest/version/hash scheme, content addressing and migration policy.
8. Residency budgets and fallback constraints.
9. Benchmark target device/browser/resolution and acceptance thresholds.
10. Optional RunPod/Blender MCP adapter discoverability and secret policy.

**Implementation philosophy:** build foundational contracts for maximum headroom, but only ship expensive optimizations when real measurements and correctness tests justify them.

---

## 22. Short answer for 'what do I need to provide before the agent starts?'

**Required now:** the repository to work in (or permission to create a new POC repo), target web runtime, ability to execute Node and open Chrome/Edge; Agent can generate sample assets itself.

**Recommended to provide soon:** one source full-body image + a handful of RGBA parts, either S/SE or 8 directions, one idle/walk example, head/hand anchors and equipment variants.

**Optional for later:** RunPod endpoints and model API samples (securely configured), GPT Image prompt templates and image provenance, Blender project plus access to MCP tools; do not expose API keys to browser or commit them.

This sequence ensures the engine and benchmark work before the AI Asset Factory is connected, while retaining a direct path to the user's existing RunPod + GPT Image + Blender tools.
