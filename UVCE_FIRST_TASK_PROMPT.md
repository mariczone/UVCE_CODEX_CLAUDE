# Copy-Paste Prompt — Start UVCE with Codex / Claude Code

> Open the target repository first. Place blueprint, checklist and agent rules in its root (or let agent resolve paths). Paste the text below as the **first** instruction.

```text
You are acting as a senior real-time graphics / Three.js / TypeScript engine engineer.

Read these files completely before modifying code:
- UVCE_CHARACTER_ENGINE_BLUEPRINT.md
- UVCE_INPUT_SETUP_CHECKLIST.md
- AGENTS.md (also CLAUDE.md if present)

Goal: Start a production-minded proof of concept of Unified Virtual Character Engine (UVCE) for a 2.5D web MMORPG. Characters are 2D modular RGBA sprites integrated with a 3D Three.js scene. Do NOT create an entire new game, train video models, or over-engineer GPU systems yet.

FIRST inspect the actual current repository, package.json, existing Three.js/world rendering, current sprite/character system, files and tests. Make a concise docs/UVCE_REPO_AUDIT.md. Keep existing functionality and work in a scoped feature/module. If no project exists, bootstrap a standalone Vite + TypeScript + Three.js POC with pnpm, strict TS, and tested runnable scripts.

Implement Milestone 0 (and begin Milestone 1 only if Milestone 0 works):
1) Establish canonical sprite axes, 8 directional mapping, foot pivot and named sockets.
2) Implement initial versioned/validated appearance + animation + asset schema and deterministic seeded procedural RGBA fixture generator; NEVER require external AI tools to start.
3) Provide one character composed of body, head, hair, armor, hat, weapon with front/back draw order, correct alpha and aligned pivots.
4) Allow live hat/armor/weapon changes from at least 3 variants each without creating full combination sprite sheets.
5) Add idle/walk clip and 8-direction controls. Keep clip/timeline separate from artwork and use shared socket attachment.
6) Make a small 3D ground/stage scene in the existing Three.js renderer, add a second overlapping character and test depth/correct internal draw order.
7) Provide simple controls for 1/20/100 characters with deterministic placement and appearance, runtime layer toggles, page/texture/debug overlay.
8) Write unit tests for manifest validation, hash/cache ID semantics, direction mapping, animation timing, equipment resolution; prepare reference composite visual tests.
9) Add scripts: install, generate:fixtures, assets:build, test, typecheck, dev and build (adjust names according to actual repo; document actual commands).
10) Capture real screenshots, record baseline CPU frame metrics and renderer draw calls if available. DO NOT fabricate GPU FPS numbers or benchmarks.

DO NOT connect RunPod, GPT Image or Blender MCP yet. They are already available to the user for a later Asset Factory phase. Design optional interfaces but don't introduce GPU cloud credentials or depend on provider endpoints. Keep future WebGPU, shader-compositor, partial/full cache, virtual atlas and streaming behind contracts/feature flags; implement only the minimal needed for the first working POC.

Deliverables: working local app + fixture generator + validated manifest + tests + docs/UVCE_REPO_AUDIT.md + docs/UVCE_ARCHITECTURE_DECISIONS.md + short usage commands + a milestone completion report (implemented, tested, known limitations, next milestones). Run tests/typecheck/build and include truthful output in the report. Don't ask me for artwork unless technically blocked; placeholders are explicitly allowed.
```

## Follow-up command after Milestone 0

```text
Continue UVCE by implementing Milestones 1–2 from the blueprint (correct baseline renderer, deterministic benchmark scene, shared source atlas, streaming/cache, logical sprite handles). Keep screenshot parity against the baseline. Preserve existing app behavior, include tests and measured metrics; do not claim an optimization win without repeatable measurements. Run typecheck/test/build and report limits.
```

## Follow-up command for integration of existing AI tooling (later)

```text
Implement the optional UVCE Asset Factory integration ONLY after the standalone renderer/compiler POC works. Inspect my current RunPod GPU deployment/model endpoints, GPT Image workflow and Blender MCP tool capabilities; do not invent endpoints, tool names or request payloads. Set up server-side adapters with secrets excluded from browser, probe actual health/capabilities, normalize output to canonical PNG RGBA + rig/frame metadata, validate & import through the existing Asset Compiler. Keep AI_ASSET_PIPELINE_ENABLED=false default and no regression in offline POC.
```
