# AUTO with the GPU-pressure gate vs SHADER — RTX 3070, 2026-10-09

Follow-up to [`../2026-10-09-rtx3070-auto/`](../2026-10-09-rtx3070-auto/README.md), where the planner without a
pressure gate was 4–15 % slower than SHADER on this CPU-bound machine.

- **Setup:** Windows 11, Ryzen 5 5600, Chromium 141 headed, ANGLE D3D11 on the RTX 3070, 1920×1080, 300 characters,
  baseline protocol. Every run recorded a clean tree.
- **`abba2/` (final, commit `c94393f`):** for each workload, AUTO, SHADER, SHADER, AUTO, each run being 3 fresh
  page loads of 15 s, so there are 6 per-load values per mode. The ABBA order cancels linear drift between the modes.
  An earlier sequential series (`auto3/`, commit `1303428`) ran AUTO after SHADER in every pair, which biased against
  AUTO. `abba-run-log.txt` holds the per-load values.

## Result (CPU per frame p50, 300 characters)

| Workload | SHADER median (6 loads) | AUTO median (6 loads) | AUTO vs SHADER | AUTO characters cached |
|---|---:|---:|---:|---:|
| random | 5.19 ms (5.00–5.85) | 5.22 ms (4.86–6.94) | +0.8 % | 0 |
| looks=8 | 5.48 ms (5.38–6.39) | 5.27 ms (4.96–6.19) | −3.8 % | 0 |
| looks=8, sync (formation) | 4.48 ms (3.99–4.99) | 4.79 ms (4.33–4.88) | +6.8 % | 0 |

- **The gate works as designed.** Frames fit vsync (no missed frames), so there is no GPU pressure and the planner
  promotes nothing. AUTO then draws exactly what SHADER draws.
- **AUTO now matches SHADER within the noise.** The ranges overlap in all three workloads, and the medians differ by
  −4 to +7 % in both directions.
- **Remaining overhead, isolated:** a CPU profile of stepped `prepareFrame` (unminified build) puts it at
  ~0.13–0.19 ms per frame at 300 characters. That is the frame-change bookkeeping the reuse estimate needs, down from
  ~0.25 ms before the O(1) group references.
- **Forced pressure** (`auto3/auto-looks8-sync-auto-forced`, sequential series): with `plannerPressure=on` the planner
  cached 99/100 and 188/300 characters (hit ratios 0.98 and 0.95) and was not faster on this machine. That is
  expected: the cache saves GPU work this GPU doesn't need saved.
- The whole machine drifted about 20 % slower across this session (SHADER at 300 characters: ~4.4 ms in the earlier
  matrix vs ~5.2 ms here). This is why only same-session, interleaved comparisons are used.

## Decision

- **SHADER stays the default.** AUTO is now **safe** (no measurable cost where it does nothing) but not proven
  useful: its only lever, the frame cache, pays off only under GPU pressure, which this machine never shows.
- AUTO is ready to become the default once a fill-limited device (e.g. a laptop iGPU) shows that, under real
  pressure, the planner promotes groups and the frame interval improves. Commands: `bench:baseline -- --gpu --headed
  --query '&mode=AUTO&looks=8&sync=1'` against `&mode=SHADER`, in ABBA order.
