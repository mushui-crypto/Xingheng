# Production Approval Decision: `6efe18e`

- reviewed at: `2026-08-04T02:21:29Z`
- reviewer role: `Security DevOps Engineer`
- target commit: `6efe18eb943b8a57750eeeb06700f101bd676414`
- target tree: `4963acf254d3fa6f9483aa21646befef9ded83f3`
- parent commit: `df39e24df019f3905b906563a0b28a62e45d1362`
- current production revision: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- overall decision: `BLOCKED`

This decision separates the dependency Security Gate from Production Approval. A Security Gate
decision does not grant deployment, Provider access, Permit issuance, kill-switch changes, trading,
position mutation, or funds authority.

## Mandatory human-confirmation stop rule

When a blocker is classified as any of the following:

- `approval required`
- `human decision required`
- `owner confirmation required`

the current workflow must stop and request explicit human confirmation. No promotion, activation,
deployment, or other blocked action may continue until that confirmation is received. While waiting
for confirmation, generating additional reports of the same validation type is prohibited.

## Evidence boundary

- Artifact result supplied and recorded in
  `docs/reports/2026-08/RELEASE_ARTIFACT_BUILD_REPORT.md`: `PASS`.
- Release Verify result supplied and recorded in that report: `PASS`.
- Candidate artifact root recorded by the trusted build report:
  `/opt/xingheng-release/candidates/6efe18eb943b8a57750eeeb06700f101bd676414`.
- The current desktop is `Darwin arm64`, non-root, and does not contain that candidate root. This
  review therefore relies on the frozen build report for artifact identity and does not claim a new
  live candidate-host verification.
- Exact source dependency boundaries:
  - `package.json` blob: `53127a45521dba13ee306bdff36f612f040f2d3e`
  - `package-lock.json` blob: `7f817df29fcbc2d046914025bb5ab91a3aea70ed`
  - `Dockerfile` blob: `eaeef38450dc3acfb2c3d34b81d24282c9120d3e`
- These three files are unchanged between the target revision and the current checkout, so the
  2026-08-04 audit and reachability review apply to the frozen release dependency graph.

## Dependency findings

`npm audit --json` reports `1 low / 6 high`; `npm audit --omit=dev --json` reports
`1 low / 3 high`. No finding is recorded as fixed or absent.

| Finding | Installed path | Release/runtime assessment | Decision |
| --- | --- | --- | --- |
| `postcss@8.5.15` / `GHSA-r28c-9q8g-f849` | direct dev dependency used by the trusted frontend build | The issue requires processing attacker-controlled CSS with source-map auto-loading. This release builds only the frozen Git archive; production serves the resulting static files and exposes no CSS-processing service. | Scoped acceptance |
| `concurrently@10.0.3 -> shell-quote@1.8.4` / `GHSA-395f-4hp3-45gv` | development command runner | The issue requires passing attacker-influenced text to `shell-quote.parse()`. Production entrypoints do not invoke `concurrently`; no request-to-command-parser path was found. | Scoped acceptance |
| `react-router-dom@7.18.1 -> react-router@7.18.1` / `GHSA-qwww-vcr4-c8h2` | frontend production dependency | The advisory applies only to unstable RSC APIs. StellaX uses a Vite-built static SPA with `BrowserRouter`, `Routes`, and Caddy; no unstable RSC API or React Router server action path was found. | Not applicable to current execution mode; time-bounded acceptance retained because the affected package is present |
| `@google-cloud/kms -> google-gax/gaxios -> rimraf -> glob -> minimatch -> brace-expansion@2.1.2` / `GHSA-mh99-v99m-4gvg`, `GHSA-rgw5-rvv9-x895` | transitive production dependency | Exploitation requires attacker-controlled brace/glob patterns reaching `brace-expansion`. No project runtime call to `glob`, `minimatch`, or `brace-expansion` was found, and the installed `google-gax`/`gaxios` runtime build contains no such call. KMS inputs are not used as filesystem glob patterns. | Scoped acceptance |

Advisory trigger references:

- <https://github.com/advisories/GHSA-r28c-9q8g-f849>
- <https://github.com/advisories/GHSA-395f-4hp3-45gv>
- <https://github.com/advisories/GHSA-qwww-vcr4-c8h2>
- <https://github.com/advisories/GHSA-mh99-v99m-4gvg>
- <https://github.com/advisories/GHSA-rgw5-rvv9-x895>

## Scoped risk acceptance

- status: `ACTIVE`
- valid only for commit: `6efe18eb943b8a57750eeeb06700f101bd676414`
- valid only for the immutable artifact digests recorded in
  `docs/reports/2026-08/RELEASE_ARTIFACT_BUILD_REPORT.md`
- starts: `2026-08-04T02:21:29Z`
- expires: `2026-08-18T15:59:59Z` (`2026-08-18 23:59:59 Asia/Shanghai`)
- accepted impact: residual availability risk from dormant vulnerable packages and residual
  confidentiality/integrity risk if the documented non-reachable execution modes change
- compensating boundaries:
  - frozen exact source and immutable image identity;
  - static Caddy frontend with no RSC server-action mode;
  - no user-supplied CSS build path;
  - no request-controlled shell parser or filesystem glob path;
  - non-root API and strategy-tools runtime users;
  - global/server kill switches remain enabled;
  - Provider, Permit, order, position, and funds actions remain unauthorized.

The acceptance immediately becomes invalid if any source, lockfile, artifact digest, runtime
entrypoint, image role, routing mode, or trust boundary changes; if unstable RSC APIs are enabled;
if user-controlled CSS, shell text, or glob patterns reach the affected packages; if
strategy-tools is exposed as a network service; or if a new advisory changes applicability.

Remediation owner: `Backend Engineer / Security DevOps Engineer` through a separately reviewed
dependency-change release. Remediation or re-approval is required no later than the expiry above.
No dependency upgrade is authorized by this record.

## Security Gate

`PASS`

Rationale: all reported high-severity dependency findings were identified and assessed against
the exact source and Docker execution topology. No production-reachable trigger was established.
Residual risk is explicitly bounded to the exact revision and immutable artifacts, expires in 14
days, and fails closed on any applicability change. This `PASS` covers dependency security review
only.

## Production Approval

`BLOCKED`

Production Approval is not granted because required evidence remains incomplete:

1. live production preflight for `6efe18e` has not run;
2. `PROJECT_CONTEXT.md` records fresh RWA rollback readiness and rollback evidence as
   `INCOMPLETE`, with STS restore verification `BLOCKED`;
3. deployment revision, post-activation health, and lifecycle completion for `6efe18e` do not yet
   exist and must not be written as `PASS`;
4. current `AGENTS.md` states that an Agent may prepare a candidate and evidence but may not
   directly create, mark, or deploy a production release;
5. the Release Workflow governance/scripts currently present in the shared worktree are dirty
   draft material and cannot be treated as part of the frozen target release or used to bypass the
   existing trusted production launcher/lock boundary.

Minimum unblock requirements:

1. an authorized human gives exact production promotion/activation approval for the immutable
   artifact identities recorded above;
2. the existing trusted production channel returns a live preflight confirming current revision
   `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`, expected production identity, enabled kill switches,
   zero Provider/order/position/funds mutation, and a verified rollback target/lifecycle receipt;
3. execution remains limited to the existing trusted promotion/install/activation path and
   `./scripts/activate-release.sh deploy/release-manifest.json`;
4. post-activation revision, image digests, health, rollback point, and lifecycle completion are
   independently verified before any production release status is recorded.

Until all requirements are met, canonical promotion, trusted operations installation, activation,
and deployment verification are prohibited. Production remains on `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`.

## Authorization boundary

- deployment executed: `NO`
- canonical promotion executed: `NO`
- production activation executed: `NO`
- Provider connection: `0`
- Permit generation: `0`
- kill-switch changes: `0`
- order mutation: `0`
- position mutation: `0`
- funds mutation: `0`
- WIF/KMS/IAM changes: `0`
