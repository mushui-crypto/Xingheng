# 163 market scan cache cadence fix

## Verified root cause

Before this task `getScanSnapshot()` used `this.snapshotTtl` (20000 ms), the same setting as the original strict/raw cache. The UI visibility poller is 25000 ms. A normal background refresh completes in approximately 2–5 seconds, placing cache expiry before the next poll. The previous browser audit observed repeated 0 FRESH / 163 STALE responses despite advancing generatedAt.

Representative deterministic timeline (milliseconds relative to initial scan):

| Event | Request time | Cache generatedAt | Cache age | Background start / complete | Next request |
| --- | --- | --- | --- | --- | --- |
| Old 20s TTL, cycle 1 | 25000 | 0 | 25000 | 25000 / 27000 | 50000 |
| Old 20s TTL, cycle 2 | 50000 | 25000 | 25000 | 50000 / 52000 | 75000 |
| Old 20s TTL, cycle 3 | 75000 | 50000 | 25000 | 75000 / 77000 | 100000 |
| Old 20s TTL, cycle 4 | 100000 | 75000 | 25000 | 100000 / 102000 | 125000 |

This is cadence mismatch, not a failure to complete the background batch.

## TTL experiment and implementation

Tests exercise 20000, 30000 and 35000 ms against four unchanged 25000-ms cycles, including two-second background completion. Old 20s produces STALE/STALE/STALE/STALE, with four refreshes after initial load. Both 30s and 35s produce FRESH/STALE/FRESH/STALE, with two refreshes after initial load. Both have the same sampled cache ages (25s / 50s / 25s / 50s) and refresh count. Cold rendering has no TTL-dependent path. 35s offers no benefit for this cadence, so select the smaller **30000 ms**.

`scanCacheTtlMs` is independent of `snapshotTtlMs`; the latter remains 20000 ms. No changes to execution, funding, position, orderbook freshness, timeout, retry, batch deadline (4000 ms), workers, scoring, UI code or polling.

Cache scheduling freshness does not override source freshness. A scan-cache hit preserves the existing market FRESH/STALE classification only while the source facts remain within the original 60-second scan fact-age bound. Individually expired/invalid facts become UNAVAILABLE; related opportunities are removed and summary aggregates reflect the remaining opportunities. There is no new scoring calculation or Provider request. The cached object and original source timestamps remain unchanged. Tests cover a 65-second-old source inside a still-fresh 35-second scan cache, while another market stays FRESH and strict/raw output remains unaffected.

Only this task's service, service tests and this report are modified. Earlier uncommitted consumer isolation, equity expansion, UI, environment, Funding-test and local fixture changes are preserved, not committed or deployed together.

## Verification

Targeted consumer/service/UI tests: 100/100 PASS. Full suite: 2482/2482 PASS. Typecheck/build PASS. Diff check PASS.

Browser acceptance follows impeccable's state-consistency guidance only; no UI redesign or frontend edit.

Read-only performance and browser results follow below when completed.

## Read-only performance results

Standalone real public-market probe on the same host; no app container restart, account credentials or database. Existing retry/timeout remain active. Bundle SHA256: `17a304e3bb7296f3cfb79424690d23a8bf8ba6875effe0a11d4e92dad1dbae0a`.

Three normal expired scans (36-second waits) returned background replacements in 2727.369 / 2734.806 / 2645.189 ms. Initial stale responses were 35.157 / 22.647 / 32.316 ms. Each refresh made 202 existing public requests; no new read path. Cold requests remained 465, identical to the prior 163 candidate.

Injected OKX 10-second abort + retry: scan total 4870.271 ms, raw wait 4002.686 ms, scoring 867.344 ms, 162 FRESH / 1 STALE / 0 UNAVAILABLE. Strict raw batch completed later with its retained retry. No additional request pool or Provider mutation.

**Do not omit the browser timing outlier:** its two ordinary background refreshes took 4642.951 and 2781.608 ms. The slow one consisted of raw 3166.565 ms and scoring 1476.429 ms, without a batch deadline expiry. It is not evidence of cadence failure, but it exceeds the specified approximately-3-second normal-expired maximum.

Across all five observed normal-expired refreshes: P50 **2734.806 ms**, P95/max **4642.951 ms** (nearest rank, small experimental sample). The standalone three-sample subset alone had P50 2727.369 and P95/max 2734.806; it must not be substituted for the complete observed maximum.

## Browser refresh cycles (30-second scan TTL)

Local Vite app connected via loopback SSH tunnel to the isolated read-only scanner. No manual refreshes. Initial cold response was 4686.192 ms; 25 rendered opportunity rows, 163 markets and 615 opportunities. Exact browser paint timing is not available from the restricted browser inspection API. One startup/visibility cache hit was excluded from periodic-cycle counting.

All times below are Asia/Shanghai on 2026-09-06. Source timestamps remain independent of cache scheduling.

| Cycle | Request | Cache generatedAt | Cache age | Cache state | Refresh triggered | UI response | Markets / opportunities |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 19:50:19.378 | 19:49:58.169 | 21209 ms | FRESH | no | FRESH | 163 / 615 |
| 2 | 19:50:44.459 | 19:49:58.169 | 46290 ms | EXPIRED | yes | STALE | 163 / 615 |
| 3 | 19:51:09.440 | 19:50:47.626 | 21814 ms | FRESH | no | FRESH | 163 / 615 |
| 4 | 19:51:34.375 | 19:50:47.626 | 46749 ms | EXPIRED | yes | STALE | 163 / 615 |

Cycle 2 refresh started at request processing and completed at 19:50:49.103; cycle 4 completed at 19:51:37.157. A fifth original-poll response at 19:51:59.425 was again FRESH (cache age 23124 ms).

STALE cycle rate: **2/4**, versus the previous 4/4. Rows remained visible; DOM observations verified 25 historical rows during stale display, then 0 historical rows, restored quality count and updated generatedAt when fresh data arrived. The added freshness-cache boundary check does not turn genuinely old fallback facts into fresh facts.

30s and 35s were compared with deterministic service cadence tests, not claimed as two separate live browser campaigns. Their cycle pattern and refresh count are identical at this polling interval; 30s is the smallest tested sufficient value. No UI polling interval change or additional follow-up request was introduced.

Evidence: `/tmp/stellax-equity-perf.mDC355/cadence.log`, `cadence-browser.log`, `cadence-run.mjs`; temporary loopback browser probe was stopped and its tab closed after acceptance.

## Final release decision

Cadence fix PASS; consumer isolation PASS; strict/raw untouched; bounded long-tail PASS; no new Provider reads/mutations or polling; tests/typecheck/build/diff PASS.

**RECOMMENDATION=KEEP_90** because the complete observed normal-expired maximum is 4.643 seconds, above the user's approximately-3-second release gate. Do not expand this task into scoring/worker optimization or silently relax that gate. All changes remain uncommitted and undeployed. The persistent-STALE blocker itself is resolved.
