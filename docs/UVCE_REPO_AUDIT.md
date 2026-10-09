# UVCE Repository Audit (Milestone 0, step 1)

Audited: 2026-10-09, branch `claude/nifty-thompson-7t015u`, base commit `bef986c` ("initial", single commit).
Method: listed every tracked file, read all docs/tools/examples, ran the existing tooling.

## 1. What exists

| Path | What it is | Status |
|---|---|---|
| `UVCE_CHARACTER_ENGINE_BLUEPRINT.md` | Architecture spec (milestones 0–6, contracts, test matrix) | Authoritative spec, unchanged |
| `UVCE_INPUT_SETUP_CHECKLIST.md`, `UVCE_FIRST_TASK_PROMPT.md` | Preflight checklist, first-task prompt | Unchanged |
| `AGENTS.md`, `CLAUDE.md` | Agent engineering policy | Unchanged, followed |
| `README.md` | Starter-pack readme | Extended with usage commands (original text kept) |
| `tools/generate_fixture_assets.py` | Python + Pillow procedural fixture generator (15 assets × 8 dirs × 8 idle frames, 256×256 RGBA, foot pivot 128,228) | Kept, untouched |
| `tools/validate_fixture_assets.py` | Read-only validator incl. 8 golden composites | Kept, untouched |
| `assets/fixtures/**` | 968 committed PNGs (960 frames + 8 goldens, ~610 KiB) + `fixture-manifest.json` (`uvce-fixture-v1`) | Kept, untouched |
| `examples/appearance.example.json` | Proposal appearance (`uvce-appearance-v1`, `demo-*` placeholder hashes) | Kept; parsed via a v1→v2 migration test |
| `examples/rig-profile.example.json` | Proposal rig (identical placeholder sockets for all dirs) | Kept as reference only |

**Not present:** `package.json`, any JS/TS source, Three.js scene/renderer, sprite/character runtime, asset loader,
unit/visual tests, CI, `.gitignore`, LICENSE, deployment config. There is no existing game to integrate with, so
nothing can be broken by adding a scoped POC; per the blueprint §0/§16 the POC is bootstrapped standalone.

## 2. Verified by running

```text
$ python3 tools/validate_fixture_assets.py assets/fixtures
PASS: 15 assets, 8 directions, 8 frames, 8 RGBA compositing goldens

# regenerated into a scratch dir and compared with the committed fixtures
compared=968 byte_differences=0 pixel_differences=0   (Pillow 12.3.0, Python 3.13.16)
```

Toolchain in this container: Node v22.22.0, pnpm 10.28.0, Python 3.13.16 + Pillow 12.3.0, git 2.43,
pre-installed Chromium 141.0.7390.37 (Playwright build 1194) at `/opt/pw-browsers`, no physical GPU
(WebGL runs on SwiftShader, i.e. CPU rasterisation — relevant for any benchmark numbers).

## 3. Gaps in the starter fixtures (why a new generator is needed, without deleting the old one)

1. **Idle only** – no `walk` clip (Milestone 0 requires idle + walk).
2. **No sockets** – every equipment layer is a full 256×256 canvas per frame, so equipment art multiplies with
   animation frames instead of attaching to shared sockets (blueprint §3.3, §7.4).
3. **Back views are not direction-aware** – N/NE/NW draw the fringe (`hair_front`) over the back of the head and
   the weapon is always on screen-right regardless of which hand faces the camera.
4. `drawOrderByDirection` lists concrete asset ids (`hat_01`…) rather than slots, so swapping equipment
   changes the order table.
5. No content hashes, trim metadata, validation schema or reference for the walk clip.

The starter pack stays as-is (still validated by its own Python script). The new TypeScript pipeline writes to
separate, git-ignored directories (`assets/source/uvce-synthetic/`, `public/uvce-compiled/`).

## 4. Decisions taken from this audit (details in `UVCE_ARCHITECTURE_DECISIONS.md`)

- Standalone single-package Vite + TypeScript (strict) + Three.js app; module folders mirror the blueprint's
  package boundaries instead of a premature monorepo.
- Deterministic TypeScript generator + compiler run with Node's built-in type stripping (no Python needed for the
  new pipeline; the Python tools remain for the legacy fixtures).
- WebGL2 `WebGLRenderer` baseline; WebGPU, shader composition, partial/full caches, virtual atlas and streaming are
  contracts/feature flags only.
- RunPod / GPT Image / Blender MCP: **not connected, not probed, no credentials**. Only disabled, typed adapter
  interfaces exist; `.env.example` contains empty server-side placeholders.
