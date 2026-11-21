# Phase 1 Perf Baseline

## Goal
Collect comparable runtime metrics before/after performance changes using built-in sampler.

## How to capture
1. Open game in browser.
2. Open DevTools console.
3. Run:
   - `window.__armtdPerf = true`
4. Start a run and keep the same scenario each time:
   - same map
   - same wave window (example: wave 35-45)
   - same speed (example: 2.0x)
   - similar tower composition
5. Watch either console `[PERF] ...` lines or top-right perf HUD.
6. Record 20-30 seconds average.
7. Disable sampler when done:
   - `window.__armtdPerf = false`

## Metrics
- `fps`
- `frame ms`
- `p95 ms` and `p99 ms` (one-second frame-time percentiles)
- `update ms`
- `draw ms`
- `ui ms`

The sampler prints the p95/p99 values alongside the averages. Keep the same
scenario for each build and record the percentile columns; do not infer a
device-wide baseline from the synthetic audit cases.

## Baseline Table
| Date | Build | Scenario | fps | frame ms | p95 ms | p99 ms | update ms | draw ms | ui ms | Notes |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| — | — | Not measured yet |  |  |  |  |  |  |  | Run on a named reference device before claiming a baseline. |
