# Market snapshot consumer isolation / bounded partial refresh

## Scope and consumer audit

This change is a scan-only projection in the existing monolith, not a second market fetch pipeline.

Current-task files (12; some already carried the separately authorized equity expansion):

- `server/modules/arbitrage/ArbitrageDashboardService.ts`
- `server/modules/arbitrage/ArbitrageDashboardService.test.ts`
- `server/modules/arbitrage/arbitrageTypes.ts`
- `server/modules/api/arbitrageRoutes.ts`
- `server/modules/api/arbitrageRoutes.test.ts`
- `server/modules/arbitrage-execution/ArbitrageExecutionDraftService.test.ts`
- `server/modules/arbitrage-funding/BybitFundingIngestionService.test.ts`
- `src/features/arbitrage/model/types.ts`
- `src/features/arbitrage/components/ArbitrageMarketTable.tsx`
- `src/features/arbitrage/components/ArbitrageMarketTable.test.tsx`
- `src/features/arbitrage/components/ArbitrageOpportunityTable.tsx`
- `docs/reports/2026-09-06-market-snapshot-consumer-isolation.md`

Other pre-existing equity expansion, local fixture and runtime changes are preserved, not silently included in this task's changes. Impeccable guidance influenced only the minimal historical-data wording and attention styling; no layout redesign.

| Consumer | Class | Read contract after change | Boundary |
| --- | --- | --- | --- |
| Public dashboard route / opportunity UI | SCAN_PRESENTATION | `getScanSnapshot()` | Bounded partial scan; explicit market freshness |
| ArbitrageExecutionDraftService | EXECUTION_SENSITIVE | Existing `getSnapshot()` | Catalog identity only; `contexts.load()` and ExecutionQuantityPlanner use separate verified quote |
| BybitFundingIngestionService | ACCOUNTING/FUNDING_SENSITIVE | Existing `getCurrentMarketSnapshot()` | Original authoritative schedule, timestamp and coverage rules |
| ArbitragePositionPresentationService | Position UI valuation | Existing `getCurrentMarketSnapshot()` | Original freshness gate, no scan fallback |
| AccountUsdtValuationService | Account valuation | Existing `getSnapshot()` | Original asset/time/status validation, no scan fallback |

No execution, funding, account or position consumer implementation was edited. Additional tests make scan methods throw in strict-consumer harnesses; Draft tests deliberately poison catalog quotes and still obtain sizing price from verified context.

## Scan contract

- Existing raw load, history/orderbook caches, concurrency 8, transport timeout 10 seconds and two-attempt retry remain unchanged.
- Scan raw wait defaults to experimental 4000 ms. Scoring starts after the raw wait, so total response can exceed 4000 ms by scoring/assembly time.
- Each scan market has `freshness` and `sourceUpdatedAt`; the latter retains original `fetchedAt`, never batch completion time.
- Completed usable facts: FRESH. Pending/failed with eligible previous facts: STALE. No eligible facts: UNAVAILABLE. Scan fallback age limit is 60 seconds, with finite/nonfuture timestamp validation.
- STALE retains its score for reference, but recommendation/entry are blocked, confidence low, automation ineligible and UI explicitly historical. Client-selected sorting can still order historical rows by their retained numeric score; they do not carry live recommendation badges.
- UNAVAILABLE is excluded before opportunity scoring and market UI hides its quote values.
- Scan cache is independent of strict dashboard cache. Fresh scan cache returns immediately. Expired cache returns a marked historical view immediately and starts background refresh. Existing 25-second visible-page polling is unchanged; updated values are delivered on subsequent existing requests (no push).
- Null source timestamps remain null through later stale views.

## Late work / resource bounds

One raw worker pool is shared by strict and scan callers. Scan expiry does not cancel transport needed by strict callers. Subsequent scans join the still-running raw request; no extra pool is queued by scan refresh. Workers finish under existing timeout/retry behavior.

Raw progress is captured in a generation-local map. A scan takes copies at its deadline, then commits once under its per-horizon generation guard. Later raw completion may populate the original strict cache, but has no callback that republishes an old scan result. Per-horizon scan in-flight state is cleared in finally; deadline timer is cleared and late raw rejection has a handler. State size is bounded by the configured market universe and the two supported horizons.

## Verification and release boundary

Targeted tests cover deadline, shared raw in-flight work, stale timestamps, unavailable exclusion, retries after deadline, late completion, strict contracts and UI labels.

Initial full-suite run had one timing-sensitive failure in unchanged `ArbitrageHedgeStartTiming.test.ts` (`executionRecordPersistMs >= 0.5`). It passed in targeted rerun; subsequent full suite passed. No production code was changed to suppress this failure.

Performance and browser results are recorded below after measurement. No release is authorized by local test success alone. The pre-existing unrelated server/index and local fixture/runtime changes are excluded from this scope.

## Repeat measurements (same host, sequential variants, real public reads)

Standalone bundles on the production host, outside application containers, with empty environment and no account credentials/database. Only public GET and existing Hyperliquid read-only `/info` requests were permitted. No production deployment or configuration changes. Each non-hit scenario has 3 samples; cache hits have 9. P95 is nearest rank and equals maximum at these small sample sizes: these are experiment percentiles, not a production SLO.

Times below are service result readiness in milliseconds, excluding HTTP transfer/browser paint. For expired cache, the original cached response is immediate; the table measures completion of the background replacement snapshot, not a blocking HTTP response.

| Scenario | 90 baseline P50 / P95 / max | 163 before P50 / P95 / max | 163 after P50 / P95 / max |
| --- | --- | --- | --- |
| Cold | 2718.735 / 2898.946 / 2898.946 | 4287.873 / 4691.773 / 4691.773 | 4524.073 / 4612.120 / 4612.120 |
| Cache hit | 0.005 / 0.009 / 0.009 | 0.007 / 0.014 / 0.014 | 0.007 / 0.019 / 0.019 |
| Expired, normal (31-second wait) | 1856.417 / 1950.316 / 1950.316 | 2832.294 / 5449.883 / 5449.883 | 2742.752 / 2790.396 / 2790.396 |
| Expired, injected single OKX 10-second timeout + retry | 11114.602 / 11297.262 / 11297.262 | 11375.474 / 11429.549 / 11429.549 | 4908.308 / 4918.625 / 4918.625 |

After-fix raw scan wait: cold 3545.625–3746.536 ms; normal expired 1837.328–1888.111 ms; injected 4000.690–4001.566 ms. Scoring/assembly: 855.916–967.277 ms. Injected strict raw work still completes at 10479.902–10484.924 ms, successfully, with one retry in each round. No additional scan commit occurs on that late completion.

After-fix counts: ordinary samples 163 FRESH / 0 STALE / 0 UNAVAILABLE; injected samples 162 FRESH / 1 STALE / 0 UNAVAILABLE. The no-previous-value UNAVAILABLE path is covered by service and UI tests, not falsely claimed as naturally observed in these live samples.

Requests including attempts: 90 cold 229, warm expired 113, injected 114; 163 before AND after cold 465, warm expired 202, injected 203 after draining the late retry. The after-fix scan returns before its final retry request, so its immediate sample counter is 202, not the final 203. All three variants have exactly 3 injected retries and no market failures after drain. Thus isolation adds zero Provider reads relative to the expanded 163 candidate; expansion itself is not zero-cost versus 90. No new polling or mutations.

Bundle SHA256:

- 90: `eaa707d0e9c34e12c21cd947811c56755d9ffab3f79fa401a6e12a20fbfd353f`
- 163 before: `0b7763b19664e5aedbdce0a9268d9c334cdd5c4b600ac044ff3a03937a622b03`
- 163 after: `34ade9a2474218b3fe3d9bf66d5b237af50a1a88abce1d95cdd5436261450e9b`

Reproduction/evidence: `/tmp/stellax-equity-perf.mDC355/partial-run.mjs`, `partial-all.log`, `summarize.mjs`; remote standalone directory `/tmp/stellax-equity-perf.k4CwKs`. These are temporary diagnostics, not added application infrastructure.

## Browser acceptance: PARTIAL PASS, RELEASE BLOCKED

Local Vite application used an SSH-loopback-only temporary public-market server importing the after-fix bundle. It exposed only the dashboard GET; all other routes/methods returned 404. No trading backend was started. The server and acceptance browser were stopped after verification.

- Cold dashboard server response: 4809.379 ms, 163 FRESH. Browser displayed 25 opportunity rows (615 combinations), and switching to market comparison displayed 44 grouped rows and all four venue columns. The restricted browser tool did not expose Resource Timing, so no exact browser first-paint milliseconds are claimed.
- Manual refresh during the injected AAPL/OKX timeout preserved all 44 market rows. Response carried 162 FRESH / 1 STALE; browser inspection showed exactly one historical cell and the original quote values/time. Table width 1414 px within main width 1480 px.
- Existing periodic refresh kept rows visible, advanced generatedAt and updated values. Historical opportunity badges replaced live recommendation/entry badges.
- **Blocker:** the existing 25-second polling interval exceeds the 20-second scan-cache TTL. Refresh usually finishes in under 5 seconds, so the next poll again finds an expired scan cache and receives a fully STALE view while another background refresh starts. This can leave the UI continually historical (quality summary 0 / best APR unavailable) even though new batches complete successfully. Observed consecutive generatedAt values `1788694113962`, `1788694140807`, `1788694164709`, `1788694190756` all returned 0 FRESH / 163 STALE. Final DOM had 25/25 historical opportunity rows.
- This is not an execution-safety failure, but it fails the end-to-end progressive-fresh-display release gate. Do not silently loosen freshness, alter TTL, add polling, or claim browser PASS. Resolving cache freshness versus delivery timing needs a separately agreed minimal change.

Final targeted consumer/service/UI tests: 98/98 PASS. Final full suite: 2480/2480 PASS. Typecheck and build PASS (`npm run build` includes both TypeScript projects). Diff check PASS.

**RECOMMENDATION=KEEP_90.** Implementation retained uncommitted; no push/deploy. Long-tail isolation is effective, but browser refresh acceptance is not complete.
