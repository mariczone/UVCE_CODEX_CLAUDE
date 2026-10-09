# UVCE — Preflight Setup & Input Checklist

> อ่านไฟล์นี้ก่อนเริ่ม Coding Agent. ถ้า **มี repo ปัจจุบัน** ให้ agent inspect ก่อนติดตั้ง/สร้างอะไรใหม่. เช็กลิสต์นี้ให้เริ่ม POC แบบ **ไม่ต้องต่อ RunPod** ได้ทันที.

## A. เตรียมอะไร 'จำเป็นตอนนี้'

| ของที่ต้องมี | ต้องมีเดี๋ยวนี้ | เจ้าของ/วิธีทำ |
|---|:---:|---|
| Existing game repo หรือ empty POC directory | ✅ | ให้ Codex/Claude ทำงานใน repo จริง; สร้าง branch feature ใหม่ |
| Node.js LTS, pnpm, TypeScript, Vite/Three.js | ✅ | Agent ตรวจ dependency เดิมแล้ว pin versions |
| Browser desktop WebGL2 (Chrome/Edge) | ✅ | Agent ทำ hardware/backend capability probe |
| 1-character placeholder assets | ✅ | Agent generate procedural RGBA; *ไม่ต้องรอ AI image* |
| 8-direction mapping and fixed foot pivot convention | ✅ | มีค่าเริ่มต้นใน Blueprint; Agent ต้อง implement validation |
| Playwright/Vitest และ benchmark page | ✅ | Agent ติดตั้งเพื่อ repeatable checks |
| GPU Server / Image-to-Video | ❌ | ต่อภายหลังเมื่อ renderer stable |
| Blender / MCP | ❌ | สำหรับ asset authoring บางส่วนใน Phase ต่อมา |
| GPT Image | ❌ | ทำ Artwork จริงเมื่อพร้อม; ไม่ต้องบล็อก renderer |

### คำสั่งที่ Agent ควรตรวจ (ไม่ต้องรันถ้าไม่มี environment)

```bash
node -v
pnpm -v
git status --short
```

- ตรวจ `WebGL2`, `WebGPU`, `renderer backend`, `GPU adapter/limits`, Browser/OS, `devicePixelRatio`, resolution.
- ไม่บังคับ WebGPU เพื่อให้ POC เปิดได้บน Browser ที่รองรับ WebGL2.
- ถ้าเป็น repo เดิมให้ป้องกันการ overwrite config/network/deployment ของเกมโดยไม่จำเป็น.

## B. ถ้าจะใช้ Artwork จริง ต้องเตรียมภาพอะไร?

### B1 — Minimum real-character pack (แนะนำ)

| File / layer | จำนวนเริ่มต้น | หมายเหตุ |
|---|---:|---|
| `master_fullbody.png` | 1 | ตัวละครเต็มตัว เป็น reference เดียวกันทั้งชุด |
| `body.png`, `head.png` | อย่างละ 1 | RGBA transparent, identical canvas/pivot |
| `hair_front.png`, `hair_back.png` | อย่างละ 1 | แยกชั้นหน้า/หลังสำหรับ occlusion |
| `armor_front.png`, `armor_back.png` | อย่างละ 1 | ถ้าชุดเรียบอาจรวมได้ แต่ต้องยังติดบน rig ถูกต้อง |
| `hat_01.png` ... `hat_03.png` | 3 | อุปกรณ์เปลี่ยนได้และแชร์ผ่าน ID |
| `armor_01.png` ... `armor_03.png` | 3 | ต้องตรง proportions/anchor ของ character rig |
| `weapon_01.png` ... `weapon_03.png` | 3 | ระบุตำแหน่ง handle/hilt ใน local image coords |
| `reference_composite.png` | 1 | ภาพ expected result ของการนำทุก layer กลับมารวม |
| `rig_sockets.json` | 1 | foot pivot, head top, right hand, left hand, back |
| `animations/idle.json` | 1 | frame durations หรือ curves ที่แชร์กัน |

เริ่มทำ **1 หรือ 2 มุม (`S`, `SE`)** ก่อน ให้ equip/alpha/depth ผ่าน แล้วค่อยทำ `N, NE, E, SE, S, SW, W, NW` รวม 8 มุม. ห้าม generate 8 มุมแบบอิสระโดยไม่ตรวจ body proportions.

### B2 — Image technical specification

- Format: PNG RGBA (straight-alpha inputs acceptable) transparent background, no shadows baked into alpha unless intentional.
- Default fixture canvas: **256×256**. Artwork จริงอาจเตรียมต้นฉบับ **512×512** หรือสูงกว่าแล้วให้ compiler สร้าง LOD; เลือกจาก projected size/device profile ไม่ใช่ทุกชิ้นต้องขนาดใหญ่สุด.
- Pixel coordinates origin top-left; x→right, y→down; foot pivot and sockets documented; no last-minute re-crop after anchor annotation.
- Align layers on same canonical canvas; if source frames trimmed, preserve trim rectangle and original pivot metadata.
- Include back-facing drawings where back/hidden regions needed. Equipment that passes in front/behind must define ordered segments.
- Avoid outline edge halo and inconsistent palette/filter among parts; manually inspect result in checkerboard background.

### B3 — Asset handoff folder (examples)

```text
incoming-assets/
  character_novice_v01/
    master_fullbody.png
    reference_composite.png
    README.md  # art license, prompt provenance, canvas, sockets, style
    directions/
      S/body.png
      S/head.png
      S/hair_front.png
      S/hair_back.png
      SE/body.png
      SE/head.png
    equipment/
      hats/hat_01.png
      hats/hat_02.png
      hats/hat_03.png
      armors/armor_01.png
      armors/armor_02.png
      armors/armor_03.png
      weapons/weapon_01.png
      weapons/weapon_02.png
      weapons/weapon_03.png
    metadata/
      rig_sockets.json
      render_profile.json
      animation_idle.json
```

**ถ้าไม่มีภาพจริง:** ให้ Agent ใช้ `tools/generate_fixture_assets.py` ใน starter pack หรือสร้างไฟล์ fixture เอง แล้วเริ่ม Milestone 0 ทันที.

## C. ใช้ GPT Image Generation ที่คุณมีอย่างไร

GPT Image = ภาพ **source art** ไม่ใช่ Browser Runtime Renderer.

1. สร้างตัวละคร master ด้วยรูปแบบสัดส่วนเดียวกันทุกมุม (เช่น fantasy 2D RPG, 3.5–4 head proportions, HD cutout line art).
2. สร้าง/แยก RGBA component ที่สวมลงบน canonical character; อย่าแอบเปลี่ยนตำแหน่ง attachment.
3. ให้เก็บ `master_fullbody`, `parts`, prompt/version และ expected composite เพื่อเปรียบเทียบ.
4. หากภาพที่ gen ไม่ align ให้ตรวจแก้ก่อนเข้า compiler; agent ไม่ควร compensate ทุกปัญหาใน shader.

**Suggested master-generation prompt:**

```text
Create one original full-body 2D RPG character master for a modular 2.5D game.
Fixed frontal south-facing view, 3.5–4 heads tall, consistent proportions,
clean readable silhouette, high-quality hand-painted/cel-shaded details,
no background, no floor, no cast shadow, no perspective change, no text.
Equipment must later be separable into body, head, front/back hair,
armor front/back, headgear, and hand-held weapon. Neutral idle pose.
Deliver a clean character reference for pixel-aligned layer authoring.
```

**Suggested layer-cut prompt:**

```text
Using the original full-body master as the only style and proportion reference,
isolate the specified part as a transparent RGBA image, preserving exact
scale, camera angle, position and linework. Output only the requested part,
no other character parts, no background, no shadows, no extra elements.
Do not redesign the character. Keep unoccluded hidden part geometry where needed.
```

Generated PNG quality must be manually reviewed. "Like reference" is not a mathematically perfect pixel lock.

## D. ใช้ Blender + MCP อย่างไร

Blender มีประโยชน์แม้ตัวละครปลายทางจะยังเป็น Sprite 2D.

**Set up (optional):**
- ตรวจ Blender version และ MCP server command/connection; agent ต้อง introspect available MCP actions ก่อนใช้ ไม่สมมุติว่า connect สำเร็จ.
- Create `character_rig.blend` template with fixed orthographic view, defined world axis/direction, foot at world origin, named attachment sockets.
- Set transparent film and output PNG RGBA image sequences with known fps/size and no dynamic camera/random lighting drift.
- Export 8 directions in agreed order and animation timeline; export metadata from transforms for sockets, pivots, frame bounds.
- If using cutout 2D art, Blender can animate plane rigs or layers; no requirement to make all equipment as full 3D meshes.
- Save `.blend`, export settings, Blender/MCP tool versions and an example output folder.

**Blender outputs for handoff:** `RGBA sequence + rig_sockets.json + render_profile.json + screenshot/reference composite`.

## E. ใช้ RunPod GPU Image-to-Video ที่มีอย่างไร

RunPod เป็น asset generation / offline compute. ไม่ใช่ตัว render sprite 100 player แบบ real-time.

**ไม่ต้องส่ง secret ตอนเริ่ม**. ตอนจะต่อจริง ให้เตรียมข้อมูลที่ไม่ใช่ credential:

| ข้อมูล | ตัวอย่างเนื้อหาที่ต้องเก็บ |
|---|---|
| Deployment kind | GPU Pod / Serverless Queue / Serverless Load-balancing |
| Public-safe endpoint contract | API route format, request/response JSON schema (redact auth) |
| Model identifier/version | ชื่อ model ที่ติดตั้งจริง, resolution, fps, duration |
| Supported conditioning | image/video reference, first/last frame, mask/pose/flow controls ที่ **รองรับจริง** |
| Job status | queued/running/succeeded/failed, retry, cancel, output storage |
| Resource limits | max input size, job concurrency, timeout, estimated run cost |
| Output | MP4, RGBA, PNG sequence, sidecar metadata, frame timestamps |
| Storage/permissions | authorized object store, safe signed URL expiry, license |

**Proposed optional bridge jobs:**

```text
full-body source PNG → RunPod image-to-video → master motion video
master video + original RGBA parts → mask/flow/rig extraction
→ anchored layer sequences or rig curves → human quality gate
→ compiler validates and packs into engine-ready bundles
```

- การ Generate แต่ละ Layer แยกรอบโดยเอา full-body video เป็น ref **ล็อก motion แบบ 100% ไม่ได้** หากต้องการตรงทุก Frame ให้ใช้ shared extracted motion/anchors + deform, matting หรือ frame extraction แล้ว refine เฉพาะจุด.
- Agent ต้องไม่สร้าง caller ด้วย payload สมมุติ; inspect actual endpoint and model capabilities.
- Server-only API keys; browser never stores/shares RunPod credential. Use minimal backend adapter and optional flag.
- RunPod management API ใหม่ควรพิจารณา v2; endpoint inference ที่มีอยู่แล้วอาจใช้ contract แยกต่างหาก.

## F. สิ่งที่ให้ Codex/Claude ทำวันแรกแม้ยังไม่ได้เตรียม Artwork

- [ ] Inspect repo and create `docs/UVCE_REPO_AUDIT.md`
- [ ] Lock asset/animation schemas and 8-direction coordinate conventions
- [ ] Create seeded procedural RGBA fixture + 3 hats/3 armors/3 weapons
- [ ] Build single-character viewer with per-layer toggle and equipment swaps
- [ ] Add 100-player scene and correctness/CPU draw-call metrics
- [ ] Save reference screenshots and failing/passing tests
- [ ] Provide next steps to add RunPod/Blender/GPT later; do not require them now

## G. What to hand the coding agent

- `UVCE_CHARACTER_ENGINE_BLUEPRINT.md` — complete architecture/spec.
- `AGENTS.md` (Codex) or `CLAUDE.md` (Claude Code) — agent policies.
- `UVCE_FIRST_TASK_PROMPT.md` — exact first command to run.
- `examples/` — example appearance/manifest structure.
- Optionally attach an existing repo or have the agent work in the current working directory.

**Recommendation:** send the exact start prompt unchanged first, let it finish Milestone 0 and report tested results, then authorize Milestone 1–2. That locks the architecture once while retaining fast feedback and avoids piling GPU optimizations on a broken baseline.
