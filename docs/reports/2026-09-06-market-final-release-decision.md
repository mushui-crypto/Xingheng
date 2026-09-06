# 163 market final release decision: cache refresh is not source staleness

## Latency audit

Prior cadence acceptance measured normal expired-cache user responses at 35.157 / 22.647 / 32.316 ms in the standalone probe, and 186.015 / 46.453 ms in browser-backed requests. These return the existing view immediately, without waiting for new market requests or scoring.

The 4642.951 ms outlier was a **background replacement scan duration** (raw 3166.565 ms + scoring 1476.429 ms), not that request's blocking duration. Its paired user response was 186.015 ms. Under the latest user-defined release standard, this background outlier alone is not a release blocker.

## Semantic audit and minimal fix

The previous `staleScanView()` conflated cache scheduling and fact quality: expiry rewrote all available markets to STALE, all opportunities to blocked, and summary quality to zero. Cycle 2/4 at cache ages 46.290/46.749 seconds did not prove all 163 source facts were invalid.

Two independent axes now represent the requested states:

- `snapshot.refreshState`: FRESH / REFRESHING. FRESH means this scan generation is complete, not that every market is fresh. REFRESHING means the response was served while the next scan is being refreshed.
- `market.freshness`: existing FRESH / STALE / UNAVAILABLE. Starting a background refresh does not rewrite this field. Source timestamps remain unchanged; current cache reads still enforce the existing 60-second maximum usable fact age.
- Existing per-market bounded fallback is preserved: if a market is not successfully refreshed by the batch deadline, only its previous usable facts are tagged STALE. Missing facts or facts beyond the existing retention bound become UNAVAILABLE. This does not introduce a new timestamp threshold or apply scan rules to strict consumers.

`refreshingScanView()` now delegates only to the source-expiry check and adds the REFRESHING field. It does not clear quality summaries or block all opportunities. Completed scan results set cache refresh state FRESH while retaining any genuine per-market fallback flags. The original cached object is not mutated by the REFRESHING response.

UI adds one neutral `后台更新中` status beside the existing update time. Per-market historical warnings remain for actual fallback facts. Impeccable guidance influenced state consistency and neutral status styling only; no layout changes.

No changes to scan TTL 30s, raw TTL 20s, UI polling 25s, deadline 4000ms, workers, retry, timeout, scoring algorithm, execution, funding, account/position freshness, or Provider mutation/read paths.

## Current task files

- `server/modules/arbitrage/ArbitrageDashboardService.ts`
- `server/modules/arbitrage/ArbitrageDashboardService.test.ts`
- `server/modules/arbitrage/arbitrageTypes.ts`
- `server/modules/api/arbitrageRoutes.test.ts`
- `src/features/arbitrage/model/types.ts`
- `src/pages/app/ArbitragePage.tsx`
- `src/features/arbitrage/components/ArbitrageMarketTable.test.tsx`
- This report.

Existing uncommitted expansion/isolation and unrelated user work remain separate; this decision is not a commit or deployment.

## Verification

Targeted tests: 102/102 PASS. Full tests: 2484/2484 PASS. Typecheck/build PASS. Diff check PASS. Tests preserve strict consumers, 30/35-second cadence behavior, source timestamps and per-market expiry, verify that REFRESHING does not rewrite summaries/opportunities, and retain the one-market long-tail fallback.

Live read-only probe and browser evidence follows below.

## Final read-only acceptance

Real public-market standalone long-tail probe after the DTO fix:

- Expired user response: **34.463 ms**, refreshState REFRESHING, **163 FRESH / 0 STALE**. It does not wait for the injected slow market.
- Completed replacement scan: **4876.837 ms**, refreshState FRESH, **162 FRESH / 1 STALE / 0 UNAVAILABLE**. The completed cache generation and one stale market coexist without conflation.
- Original strict request drained at **10488.700 ms**, 203 total attempts including retained retry; no extra scan-driven request pool.

Local browser, existing 25-second polling, no manual refresh:

| RequestTime epoch ms | Cache age | Cache state | Response refreshState | Response duration | Market F / S / U |
| --- | --- | --- | --- | --- | --- |
| 1788697216104 | 21145 ms | FRESH | FRESH | 16.116 ms | 163 / 0 / 0 |
| 1788697241215 | 46256 ms | EXPIRED | REFRESHING | **110.453 ms** | 163 / 0 / 0 |
| 1788697266191 | 22009 ms | FRESH | FRESH | 16.890 ms | 163 / 0 / 0 |

The paired background refresh took **4644.729 ms** (raw 2966.761 + scoring 1678.014 ms), while its user response returned in 110.453 ms. This independently confirms that background duration is not user-blocking. Both are server-side timings in the isolated browser probe, not claimed as production browser end-to-end measurements.

DOM acceptance: throughout refresh there were 25 visible rows, 0 historical-warning rows, quality count 118 and available yield summary. During REFRESHING the neutral status was present and update time remained 20:19:54; following the next existing poll it disappeared and update time advanced to 20:20:44. No whole-area loading or source timestamp fabrication. Initial selector wait expired before the first data response; subsequent DOM inspection confirmed successful cold render, not an application error.

Source trace/evidence: `/tmp/stellax-equity-perf.mDC355/final-longtail.log`, `final-browser.log`, `final-run.mjs`; bundle SHA256 `8b8b7a1c2b94d6ef8d05378c5a338867130ce1916d0474761df243029162353c`. The temporary read-only server and browser tab are stopped after verification. No credentials, real trading backend, Provider mutations, new production reads or polling.

**RECOMMENDATION=DEPLOY_163** under the latest release standard. No remaining blocker in this decision's scope. This supersedes the prior approximately-3-second-background gate; it does not claim that scoring or raw work became faster. No commit/push/deploy was performed in this decision task; unrelated work remains excluded from the future release fileset.
