# Production Promotion Preflight Report: `6efe18e`

- checked at: `2026-08-04T02:26:36Z`
- scope: read-only production promotion preflight
- target revision: `6efe18eb943b8a57750eeeb06700f101bd676414`
- target tree: `4963acf254d3fa6f9483aa21646befef9ded83f3`
- overall result: `BLOCKED`

This preflight does not perform canonical promotion, trusted operations installation, activation,
deployment, Provider access, Permit generation, trading, position mutation, or funds mutation.

## Gate summary

| Gate | Result | Evidence |
| --- | --- | --- |
| Artifact build | `PASS` | Trusted build report binds the exact commit/tree, source archive, candidate receipt and three immutable image digests. |
| Release verify | `PASS` | Trusted build report records checksum, candidate tree, manifest schema/revision/digest and image verification as `PASS`. |
| Security Gate | `PASS` | `PRODUCTION_APPROVAL_DECISION.md` records an exact-artifact, time-bounded risk acceptance through `2026-08-18T15:59:59Z`. |
| Exact artifact identity in this preflight | `PASS_FROM_FROZEN_EVIDENCE` | Frozen identities are internally consistent, but the trusted candidate root is not present on the current host, so no new live candidate-host verification is claimed. |
| Canonical release manifest | `BLOCKED_LIVE_NOT_AVAILABLE` | Frozen candidate manifest identity is known; neither the candidate manifest nor the canonical production manifest is available on the current host for a fresh no-follow/mode/digest check. |
| Production current revision | `REPORTED_1ad3579_LIVE_NOT_VERIFIED` | Existing reports identify `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`; this desktop has no production runtime/lifecycle evidence, so the revision was not reclassified as a live `PASS`. |
| Verified rollback target | `BLOCKED` | No current production lifecycle pointer or receipt is available to bind the previous revision, image digests, environment identity and Docker daemon identity. |
| Lifecycle prerequisites | `BLOCKED` | The release lifecycle implementation/tests are present and fail closed, but the production current pointer, verified previous receipt and live preflight evidence are unavailable. |
| Production Approval | `BLOCKED` | Required live production and rollback evidence is incomplete. |

## Exact artifact identity

The frozen trusted build evidence records:

| Artifact | SHA-256 |
| --- | --- |
| `code.tar` | `0e7153e70d384c37bbd318ff59b093fdbfb291678e8588bc188f3bba821f974d` |
| `candidate-build-receipt.json` | `f6b97b2d7cc28590ab6598fcd945ce9a5bf9d1e56fc29985a37ac3c8fb8f71a7` |
| `release-manifest.json` | `ceab5314a0e37e4c7886433a2a91c0cb352bf79f956dc167345d5e5f498b142a` |
| `RELEASE_SHA256SUMS` | `3e5aa884f66e3322c93b339c11737ece0ced9b0d66e1736f2ae07a7b0ff78dac` |
| `xingheng-api` | `sha256:02068e1ac06b730fd27cfc976fa92baff102b1851d1562bcd6f7eb02c6dd6c59` |
| `xingheng-web` | `sha256:4c8b58d0e88ee2c585394ba7f9966bc6e589395fa6a81534174d75262ef01968` |
| `xingheng-strategy-tools` | `sha256:1aa087aa274bfeb9dd82e6d498e88e4e4d07fba4ad1044e6acc0b79f49ff05f4` |

Git object verification confirmed the exact commit, tree and parent:

- commit: `6efe18eb943b8a57750eeeb06700f101bd676414`
- tree: `4963acf254d3fa6f9483aa21646befef9ded83f3`
- parent: `df39e24df019f3905b906563a0b28a62e45d1362`

The target revision's trusted activation entry identities also match the prior activation report:

- `scripts/activate-release.sh`: `1cd7afc98df5efff8ee4c1cc8813b4004990243b7856608c31c83b11a1e178b3`
- `scripts/trusted-operation-launcher.mjs`: `ab3ad5ff86717e0eb9225335808e97f99b9950f24e4b35c62ef42ea307cfe419`

## Release manifest

The trusted build report records the candidate manifest as a root-owned, regular, single-link,
read-only file with mode `0444`, exact revision binding and SHA-256
`ceab5314a0e37e4c7886433a2a91c0cb352bf79f956dc167345d5e5f498b142a`.

Current-host checks found neither:

- `/opt/xingheng-release/candidates/6efe18eb943b8a57750eeeb06700f101bd676414/release-manifest.json`; nor
- `/opt/xingheng-release/code/deploy/release-manifest.json`.

The repository checkout also has no `deploy/release-manifest.json`. Consequently this preflight
cannot independently re-read the frozen bytes or prove that the candidate manifest has been
installed into the canonical production location. Canonical promotion remains prohibited.

## Production current revision

The latest existing production evidence reports revision
`1ad3579c8f7b1c0f9b9982701db14871ec9d672e`, healthy API/Web, enabled global/server kill switches,
and zero Provider/order/position/funds mutation. The artifact build report further records that no
candidate manifest was installed and `6efe18e` was not deployed.

This preflight ran on `Darwin arm64` as a non-root user, not inside the controlled Linux production
boundary. No production runtime, cloud identity, credential, Docker container or health endpoint
was accessed. Therefore `1ad3579` remains a reported current fact, not a fresh live verification.

## Rollback target

The expected previous revision is `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`, but it is not yet an
acceptable promotion rollback target. The current host has no
`/var/lib/xingheng/release-lifecycle/current.json` and no lifecycle receipt proving the immutable
previous image digests, environment snapshot, Docker daemon identity and completed lifecycle
state required by `scripts/rollback-release.sh`.

The accepted P2#2/RWA restore risks remain separately recorded as:

- P2#2 fresh RWA rollback readiness: `INCOMPLETE`
- STS restore verification: `BLOCKED`
- rollback evidence: `INCOMPLETE`

That risk acceptance affects capital-test preparation semantics only. It does not satisfy the
Release Workflow requirement for a verified release lifecycle rollback target.

## Lifecycle prerequisites

Static lifecycle checks completed successfully:

- target/current lifecycle implementation and test boundary: `IDENTICAL`
- deployment revision, topology and release lifecycle tests: `20/20 PASS`
- immutable manifest schema and digest validation: covered
- exact previous/candidate/environment/daemon binding: covered
- interrupted upgrade remains stopped until verified rollback: covered
- inode, content, mode, link and daemon drift fail closed: covered
- rollback runtime requires one healthy exact-revision API and Web: covered

Live prerequisites remain missing:

1. canonical candidate manifest on the controlled production host;
2. fresh read-only confirmation that current production is exact revision `1ad3579`;
3. current verified lifecycle pointer and immutable rollback receipt;
4. exact previous image digests and environment/daemon identity;
5. fresh production health and zero-mutation snapshot;
6. explicit human production promotion/activation approval after the evidence above passes.

## Decision

`BLOCKED`

Artifact and Security Gate evidence are sufficient to continue preparing the live production
preflight, but not to run canonical promotion. The next authorized action is a read-only preflight
inside the existing controlled Linux production boundary. It must return the canonical manifest
identity, current runtime revision, current lifecycle pointer/receipt, rollback target identity,
health and zero-mutation evidence. Any mismatch or missing evidence must remain fail-closed.

## Authorization boundary

- promotion executed: `NO`
- activation executed: `NO`
- deployment executed: `NO`
- Provider connection: `0`
- Permit generation: `0`
- order mutation: `0`
- position mutation: `0`
- funds mutation: `0`
- production configuration changes: `0`
- WIF/KMS/IAM changes: `0`
