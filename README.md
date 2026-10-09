# UVCE — Unified Virtual Character Engine (proof of concept)

Modular 2D RGBA sprite characters (body, head, hair, armor, hat, weapon) composed at runtime inside a
three.js 2.5D scene: 8 camera-relative directions, idle/walk clips, socket-attached equipment that can be
swapped live without any per-combination sprite sheet, and a CPU reference compositor that the WebGL output is
tested against pixel by pixel. Source pages stream through a budgeted residency registry: grouped, mip-safe atlas
pages, generation-checked handles, LRU eviction, retry/backoff, prefetch and WebGL context-loss recovery.
**Milestones 0–2 are implemented (the hardware-GPU benchmark is still to be run); the art is synthetic placeholder
art.**

| Read | What |
|---|---|
| [`docs/LOCAL_TEST_CHECKLIST.md`](docs/LOCAL_TEST_CHECKLIST.md) | **Run this on your own machine:** every test, the GPU benchmark and a manual browser pass, in one go |
| [`docs/UVCE_MILESTONE_1_2_REPORT.md`](docs/UVCE_MILESTONE_1_2_REPORT.md) | Milestones 1–2: what was built, verified output, performance vs M0, limitations, next steps |
| [`docs/UVCE_MILESTONE_0_REPORT.md`](docs/UVCE_MILESTONE_0_REPORT.md) | Milestone 0: what was built, verified output, limitations |
| [`docs/UVCE_ARCHITECTURE_DECISIONS.md`](docs/UVCE_ARCHITECTURE_DECISIONS.md) | ADRs: coordinates, directions, sorting/depth, alpha and mips, schemas, hashing, residency |
| [`docs/UVCE_REPO_AUDIT.md`](docs/UVCE_REPO_AUDIT.md) | What the repository contained before this work |
| [`docs/benchmark-results/baseline/`](docs/benchmark-results/baseline/README.md) | Benchmark protocol, the M0 baseline and the M2 rerun with its attribution |
| [`docs/screenshots/`](docs/screenshots/) | Real headless-Chromium screenshots |

## Usage

Requirements: Node.js >= 22.18 (tested with 22.22.0, see `.nvmrc`; the TypeScript tools run on Node's built-in
type stripping), pnpm 10 (`corepack enable`), and for e2e/screenshots a Chromium for Playwright 1.56.1
(`pnpm exec playwright install chromium` on a fresh machine). No GPU service, AI tool or network asset is needed.

```bash
pnpm install                    # exact, pinned dependencies
pnpm generate:fixtures          # seeded synthetic RGBA sources  -> assets/source/uvce-synthetic/   (git-ignored)
pnpm assets:build               # validate, trim, hash, dedupe, pack -> public/uvce-compiled/       (git-ignored)
pnpm dev                        # runs both steps above, then Vite on http://localhost:5173
pnpm typecheck                  # strict TS: browser code and Node tooling separately
pnpm test                       # Vitest unit tests (build their own temporary fixtures)
pnpm build                      # fixtures + assets + production build -> dist/
pnpm test:e2e                   # build + Playwright: GPU-vs-CPU parity, swaps, crowds, directions
pnpm screenshots                # real browser screenshots -> docs/screenshots/            (after pnpm build)
pnpm bench:baseline             # baseline metrics -> docs/benchmark-results/baseline/<date>/ (after pnpm build)
pnpm bench:stages               # per-stage frame timing (pump/world/prepare/submit/raster), optional A/B   (after pnpm build)
pnpm fixtures:legacy:validate   # original starter-pack Python validator (needs Pillow)
```

In the app: crowd size 1 / 2 (overlap) / 20 / 100 / 300, seed, play/pause, hero clip, 8 direction buttons
(relative to the camera — orbit with the mouse and the displayed direction changes), hair/hat/armor/weapon
selectors, per-layer toggles, debug overlay (pivots, sockets, layer boxes with draw order, painter rank), live
CPU/draw-call stats, residency counters (fetches, reloads, evictions, budget, stale-handle hits), the atlas page
viewer with each page's state, and a "simulate GPU context loss (1 s)" button.

URL parameters: `count=20`, `seed=42`, `dir=SE`, `clip=walk`, `t=350` (ms), `paused=1`, `hat=hat_02` /
`weapon=none`, `hide=weapon,hat`, `debug=1`, `test=1` (deterministic: paused clock, no MSAA), `scene=parity` /
`scene=studio` (pixel-exact orthographic camera), `variant=crossing|arch|glass` (with `scene=parity`),
`budgetMiB=1` (source page budget, default 256 — small values force evictions), `mips=0` (no mip chains, for A/B),
`filter=nearest|linear`, `bench=1` (panel off, for measurements), `mode=SHADER` (falls back to LAYERED with the
reason shown — only LAYERED is implemented).

---

## UVCE Starter Pack — what to open first (original starter-pack notes)

**For user / POC owner:** start with `UVCE_INPUT_SETUP_CHECKLIST.md`. It says which tools/assets are required *now*, optional later, and how to reuse GPT Image / RunPod GPU / Blender MCP.

**For architecture and all milestones:** `UVCE_CHARACTER_ENGINE_BLUEPRINT.md` (the main long technical specification).

**For Codex:** copy `AGENTS.md` + main docs to repo root and paste `UVCE_FIRST_TASK_PROMPT.md` into Codex.

**For Claude Code:** also copy `CLAUDE.md` and give the same first-task prompt.

**Examples:** `examples/` includes proposal JSON data; `contentHash` fields marked `demo-*` are placeholders **not valid production hashes**. Agent must compute actual hashes at compile time. The rig example repeats coordinates across directions intentionally as a placeholder, not a verified game rig.

**Synthetic asset generator (optional quick-start):**

```bash
python -m pip install Pillow
python tools/generate_fixture_assets.py assets/fixtures
```

This generates procedural placeholder RGBA PNGs for 8 directions × 8 frames × multiple parts and a demo fixture manifest. The images are for renderer correctness and load testing only, not the intended final art. Any generated output should be reviewed before treating it as an authoritative source format.

No RunPod API key, GPT Image request, Blender MCP connection, or user-created art is required for Milestone 0.
