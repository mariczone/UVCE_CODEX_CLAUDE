# AGENTS.md — UVCE Codex Instructions

This repository is implementing the **Unified Virtual Character Engine (UVCE)** for a 2.5D web MMORPG: modular 2D sprites in a Three.js 3D world, highly shared asset caches, replaceable render modes, deterministic benchmarks.

**Authoritative documents:**
1. `UVCE_CHARACTER_ENGINE_BLUEPRINT.md`
2. `UVCE_INPUT_SETUP_CHECKLIST.md`
3. `UVCE_FIRST_TASK_PROMPT.md` (initial task only)

If these files are stored under `docs/`, use that path. Follow the existing repository conventions, not the sample folder structure blindly.

## Rules

- Audit repo before modifications. Do not overwrite current implementation or change unrelated features/deployment.
- Milestone 0 first, then Milestone 1. Never start GPU optimizations without a correctness baseline and measurements.
- POC must work **offline without RunPod, GPT Image or Blender/MCP**. Generate deterministic procedural RGBA fixture data when artwork is missing.
- Keep gameplay/appearance/animation/source asset/physical atlas separate via interfaces; immutable shared source atlas and writable composite cache are distinct pools.
- Correct sprite layer order, foot pivot, 8-direction attachment, alpha color processing and world 3D occlusion before perf tuning.
- Use content-addressed/versioned asset references and deterministic fixtures; never generate a full sprite sheet per item combination.
- Avoid deep refactors or new dependencies unless necessary; pin versions and explain design choices as short ADRs.
- Do not expose secrets in client or repo; RunPod and Blender integrations are optional, disabled until actual endpoint/schema/permission is verified.
- Handle missing assets/capabilities with an explicit fallback; do not fake supporting WebGPU or provider API features.
- Every rendering optimization is feature-flagged and compared against the visually correct baseline on the same test scene.
- Run tests, typecheck, build and report actual results; never fabricate benchmarks, pass counts or GPU measurements.
- Write code and comments pragmatically; TypeScript strict, avoid `any` unless isolated and justified, no speculative giant abstractions.

## Definition of working increment

Working demo page + tiny deterministic example assets + changes scoped to milestone + tested scripts + screenshot(s) + before/after metrics (when applicable) + known limitations.

## First milestone

Read `UVCE_FIRST_TASK_PROMPT.md`; inspect repo; build single-character viewer and modular costume swapping plus test fixtures, not a production GPU atlas system.
