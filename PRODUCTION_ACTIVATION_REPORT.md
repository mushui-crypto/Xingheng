# Production Activation Report: 6efe18eb943b8a57750eeeb06700f101bd676414

## Result

- status: `PASS`
- completed at: `2026-08-04T03:15:01Z`
- deployment revision: `6efe18eb943b8a57750eeeb06700f101bd676414`
- Git tree: `4963acf254d3fa6f9483aa21646befef9ded83f3`
- replaced production revision: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- approved rollback revision: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- rollback executed: `NO`

Artifact Verify, Security Gate, Production Approval and the bounded live no-drift preflight were all
`PASS` for the same immutable revision before the transaction started. The deployment approval did
not grant Provider, Permit, kill-switch, trading, position or funds authority.

## Controlled execution path

The existing controlled SSH entry was recovered without printing its address, account or key. The
selected `user@host` token was required to match the approved SHA-256 fingerprint and the key
basename was restricted to the project allowlist. SSH used `BatchMode=yes`, `IdentitiesOnly=yes`
and `StrictHostKeyChecking=yes`.

The non-sensitive operation sequence was:

1. Copy the frozen candidate code from the revision-scoped candidate root into a root-owned staging
   directory and install the frozen `release-manifest.json` as `0444`.
2. Preserve the production environment while changing only its exact `XINGHENG_REVISION` binding;
   verify that `RWA_AUTOMATION_SERVER_KILL_SWITCH=true` remained unchanged.
3. Atomically replace the canonical release root while retaining the previous canonical code at the
   revision-scoped rollback path.
4. Run `node scripts/install-trusted-operations.mjs install` from the new canonical root.
5. Run `node scripts/trusted-operation-launcher.mjs production scripts/activate-release.sh
   deploy/release-manifest.json`.
6. Run the allowlisted production smoke entry and then cross-check the canonical manifest, immutable
   images, running containers and lifecycle receipts.

The dirty macOS checkout was not used as deployment input. No artifact was rebuilt or modified, and
the frozen candidate remains preserved.

## Canonical and trusted identities

- canonical manifest SHA-256:
  `ceab5314a0e37e4c7886433a2a91c0cb352bf79f956dc167345d5e5f498b142a`
- canonical environment SHA-256:
  `b680558b66498a0148fc37d997278d81af825faa0ff6433b8a31f284b4761b53`
- trusted operations receipt SHA-256:
  `43cd33a47a617a884636787e65e707e793866a8bab196a5c55f0d2b15fa00a70`
- trusted release tree SHA-256:
  `16db7674c0cb6e8cc27989be4d01858d14029dd42239732797459f2165e2c259`
- trusted release tree file count: `71`
- platform verification: all three images `linux/amd64`

| Component | Immutable digest | OCI revision | Embedded revision | Runtime revision | State |
| --- | --- | --- | --- | --- | --- |
| API | `sha256:02068e1ac06b730fd27cfc976fa92baff102b1851d1562bcd6f7eb02c6dd6c59` | `6efe18eb943b8a57750eeeb06700f101bd676414` | `6efe18eb943b8a57750eeeb06700f101bd676414` | `6efe18eb943b8a57750eeeb06700f101bd676414` | running, healthy |
| Web | `sha256:4c8b58d0e88ee2c585394ba7f9966bc6e589395fa6a81534174d75262ef01968` | `6efe18eb943b8a57750eeeb06700f101bd676414` | `6efe18eb943b8a57750eeeb06700f101bd676414` | `6efe18eb943b8a57750eeeb06700f101bd676414` | running, healthy |
| Strategy Tools | `sha256:1aa087aa274bfeb9dd82e6d498e88e4e4d07fba4ad1044e6acc0b79f49ff05f4` | `6efe18eb943b8a57750eeeb06700f101bd676414` | verified image identity | not a persistent service | immutable image verified |

## Lifecycle and rollback binding

- activation operation ID: `05e61a09-e4e1-4eb7-95cc-46dd31bd4bf9`
- lifecycle phase: `active`
- lifecycle pointer SHA-256:
  `11242695428d17da4a16b1b5558d8ae0a9ba9633b2de795319fdba4c95d74590`
- lifecycle intent SHA-256:
  `aa040c35a52c869832f9e345f0759bd2493298bce0a8a77a159e5cf16d4f92c3`
- lifecycle journal SHA-256:
  `f21bbfb0c34f4f2d8353487a0f72f80552ef0148f9181f5fc6c24d2d5a0b1fd3`
- current environment snapshot SHA-256:
  `b680558b66498a0148fc37d997278d81af825faa0ff6433b8a31f284b4761b53`
- rollback revision bound by the new intent:
  `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- rollback lifecycle operation retained by the new intent:
  `1552cff8-fafd-4741-8535-d6c50ebf3f5d`
- previous canonical code retained at:
  `/opt/xingheng-release/previous-1ad3579c8f7b1c0f9b9982701db14871ec9d672e-before-6efe18eb943b8a57750eeeb06700f101bd676414`

The previous manifest hash remains
`a30d6f383fc93433533d7359d71c68df8bbb66a45c05415ce45a7e2c25210e13`.
Its environment identity remains preserved by the immutable lifecycle snapshot rather than by an
extra credential-bearing copy in the previous code directory.

## Verification

- canonical manifest/revision/digest cross-check: `PASS`
- trusted operations installation: `PASS`
- standard activation entry: `PASS`
- API container identity and health: `PASS`
- Web container identity and health: `PASS`
- three-image OCI revision and `linux/amd64` identity: `PASS`
- allowlisted deployment smoke: `PASS`
- lifecycle pointer/intent/journal active binding: `PASS`
- rollback revision and previous identity preservation: `PASS`
- server/global kill switch: `ENABLED`

Two diagnostic issues occurred before the transaction and caused no production mutation: a compacted
history lookup initially selected a polluted diagnostic line, and a local command template had one
syntax error before SSH invocation. The approved target-token hash scan recovered the controlled
entry; the corrected transaction then ran once. A silent container-verifier diagnostic that did not
produce an auditable exit record was not treated as PASS and was not repeated after the bounded
manifest/Docker/lifecycle cross-check succeeded.

## External action ledger

- canonical production release root replacement: `1`
- trusted operations receipt installation: `1`
- API/Web Compose recreate through the trusted activation entry: `1`
- lifecycle activation completion: `1`
- allowlisted smoke verification: `1`
- rollback: `0`
- Provider connection initiated by this operation: `0`
- Permit generation or mutation: `0`
- order mutation: `0`
- position mutation: `0`
- funds mutation: `0`
- WIF/KMS/IAM mutation: `0`
- kill-switch mutation: `0`

The mutation-zero statements describe the executed command scope and operation ledger. No Provider,
Permit, order, position or funds endpoint was called or inspected.

## Risk and remaining blockers

The previously approved scoped dependency risk acceptance remains active and is not broadened by
this deployment. Compose reported that two pre-existing RWA automation volumes were not originally
created by Compose; their existing volume identities were retained and the warning did not fail the
trusted activation or lifecycle verification. No release blocker remains. This deployment is not
Provider, Mainnet, Permit, kill-switch release, real-capital or trading authorization.

Changed files:
- `PRODUCTION_ACTIVATION_REPORT.md` (local audit report only)
- production canonical release/lifecycle/trusted-operation state through the approved operation

Commit SHA: `6efe18eb943b8a57750eeeb06700f101bd676414`

Tree SHA: `4963acf254d3fa6f9483aa21646befef9ded83f3`

Tests: `PASS` - trusted activation, container identity/health, linux/amd64 image identity, smoke and lifecycle verification.

Risk: scoped dependency risk acceptance remains active; deployment authorization does not authorize Provider, Permit, capital or trading actions.

Remaining blockers: `NONE` for this production activation; all capital/provider/trading gates remain independently closed.
