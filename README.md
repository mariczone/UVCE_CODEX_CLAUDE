# UVCE Starter Pack — What to open first

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
