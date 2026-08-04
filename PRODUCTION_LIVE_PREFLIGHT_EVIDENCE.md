# Production Live Preflight Evidence: `6efe18e`

- collected at: `2026-08-04T02:33:16Z`
- evidence mode: `READ_ONLY`
- target revision: `6efe18eb943b8a57750eeeb06700f101bd676414`
- current production revision: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- approved rollback target: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- live preflight result: `PASS`

The evidence was collected through the existing controlled SSH entry on the trusted production
Linux host. The host address, account details and credential material are not recorded. No `.env`,
container environment, application log, Provider data, Permit data or funds data was read.

## Gate matrix

| Check | Result | Evidence |
| --- | --- | --- |
| Candidate manifest identity | `PASS` | Exact target revision, manifest SHA-256 and all three immutable image digests match the frozen trusted build evidence. |
| Current canonical manifest | `PASS` | Root-owned regular single-link `0444` file; SHA-256 matches the active lifecycle pointer. |
| Current production revision | `PASS` | Canonical manifest, lifecycle pointer, API and Web all bind exact revision `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`. |
| Runtime identity | `PASS` | Exactly one API and one Web container; image identities match the canonical manifest; both are running and healthy. |
| Rollback lifecycle pointer | `PASS` | Root-owned regular single-link `0600` pointer binds current manifest, images, environment snapshot and Docker daemon identity. |
| Rollback lifecycle receipt | `PASS` | Receipt operation IDs agree; journal is `active`; candidate identity in the receipt matches the current pointer. |
| Rollback environment snapshot | `PASS` | Root-owned regular single-link `0400` snapshot; size and SHA-256 match the pointer and receipt. |
| Production promotion approval | `APPROVED` | User approved replacing `1ad3579` with the exact immutable `6efe18e` artifacts and explicitly approved rollback to `1ad3579`. |

## Candidate manifest

Path:

`/opt/xingheng-release/candidates/6efe18eb943b8a57750eeeb06700f101bd676414/release-manifest.json`

File boundary:

- type: regular file, not a symlink
- mode: `0444`
- owner: controlled root identity
- link count: `1`
- size: `369` bytes
- SHA-256: `ceab5314a0e37e4c7886433a2a91c0cb352bf79f956dc167345d5e5f498b142a`
- revision: `6efe18eb943b8a57750eeeb06700f101bd676414`

Immutable images:

- API: `sha256:02068e1ac06b730fd27cfc976fa92baff102b1851d1562bcd6f7eb02c6dd6c59`
- Web: `sha256:4c8b58d0e88ee2c585394ba7f9966bc6e589395fa6a81534174d75262ef01968`
- Strategy Tools: `sha256:1aa087aa274bfeb9dd82e6d498e88e4e4d07fba4ad1044e6acc0b79f49ff05f4`

The manifest revision and SHA-256 exactly match the frozen trusted artifact report. No artifact was
modified, copied into the canonical path or rebuilt during this preflight.

## Current canonical manifest

Path:

`/opt/xingheng-release/code/deploy/release-manifest.json`

File boundary:

- type: regular file, not a symlink
- mode: `0444`
- owner: controlled root identity
- link count: `1`
- size: `369` bytes
- SHA-256: `a30d6f383fc93433533d7359d71c68df8bbb66a45c05415ce45a7e2c25210e13`
- revision: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- lifecycle pointer manifest match: `PASS`
- lifecycle pointer image match: `PASS`

Current immutable images:

- API: `sha256:aff6e2d0dc7499f30290b9e14f6e6256458baa70f4062f7ea392bd5f0ad73a0c`
- Web: `sha256:8815403a0ed8e648cef64e86a1b6a60f427e1ab873b4f24d45d186bde3f73beb`
- Strategy Tools: `sha256:00d9edf47792b86956ecf4018acb781e133da631a67b05ff2315f9f4d3ffa953`

The canonical path correctly remains on `1ad3579` before promotion. The candidate manifest remains
isolated in its revision-scoped candidate root.

## Runtime identity

Production host boundary:

- platform: `Linux 6.8.0-136-generic x86_64`
- controlled execution UID: `0`
- Compose project: `xingheng`

API:

- running container count: `1`
- image: `sha256:aff6e2d0dc7499f30290b9e14f6e6256458baa70f4062f7ea392bd5f0ad73a0c`
- OCI revision: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- embedded build revision: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- runtime user: `20001:20001`
- running: `true`
- health: `healthy`

Web:

- running container count: `1`
- image: `sha256:8815403a0ed8e648cef64e86a1b6a60f427e1ab873b4f24d45d186bde3f73beb`
- OCI revision: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- embedded build revision: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- running: `true`
- health: `healthy`

No container environment variables, logs, network traffic or application data were read.

## Rollback lifecycle pointer

Path:

`/var/lib/xingheng/release-lifecycle/current.json`

Pointer boundary and identity:

- schema: `1`
- type: regular file, not a symlink
- mode: `0600`
- owner: controlled root identity
- link count: `1`
- size: `985` bytes
- pointer SHA-256: `aa6644bdb253abe6008934b404d51d36ffdba836679f1b013f082798d6d6c35d`
- revision: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- manifest SHA-256: `a30d6f383fc93433533d7359d71c68df8bbb66a45c05415ce45a7e2c25210e13`
- environment SHA-256: `88d110495a7d9b105e3857fdfe7fc2facb4f64f3db6abb68ac8c38aee55205d0`
- established at: `2026-08-02T07:48:20.975Z`
- daemon identity SHA-256: `f5dbed2119fa82d970ceaccf18e851e9b8f219f4f12a274299f86dd1f07f90a4`
- operation ID: `1552cff8-fafd-4741-8535-d6c50ebf3f5d`

## Rollback lifecycle receipt

Receipt files:

| Receipt | Boundary | SHA-256 |
| --- | --- | --- |
| `intent.json` | root-owned, regular, single-link, `0400` | `ff00af38b4ed2ac34bbc995a955118d573b053675c581ae9f7a86ed1c3f78c9a` |
| `journal.json` | root-owned, regular, single-link, `0600` | `85d93a61d6bf81a2f49d26848623539eeef7c77047d3ec679cfeaaa45e82187e` |

Receipt verification:

- operation: `verified-release-upgrade`
- pointer/intent/journal operation ID match: `PASS`
- journal phase: `active`
- journal sequence: `1`
- receipt candidate revision: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- pointer/receipt candidate revision match: `PASS`
- pointer/receipt image identity match: `PASS`
- pointer/receipt manifest identity match: `PASS`
- pointer/receipt environment identity match: `PASS`
- pointer/receipt Docker daemon identity match: `PASS`

Environment snapshot:

- file: `environment-1ad3579c8f7b1c0f9b9982701db14871ec9d672e-88d110495a7d9b105e3857fdfe7fc2facb4f64f3db6abb68ac8c38aee55205d0.env`
- boundary: root-owned, regular, single-link, `0400`
- size match: `PASS`
- SHA-256 match: `PASS`
- content read or recorded: `NO`

The active pointer and receipt establish `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
as the verified rollback target for the approved `6efe18e` production replacement.

## Approval boundary

The user explicitly approved:

- replacement target: exact immutable artifacts for
  `6efe18eb943b8a57750eeeb06700f101bd676414`;
- current production version to replace:
  `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`;
- rollback target: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`;
- rollback approved: `YES`.

This approval does not authorize Provider access, Permit generation, kill-switch changes, trading,
position mutation or funds mutation.

## Decision

`PASS`

The missing live production evidence from `PRODUCTION_PROMOTION_PREFLIGHT_REPORT.md` is now closed.
The exact candidate manifest is frozen and verified; current production runtime identity is exact
and healthy; the rollback lifecycle pointer, receipt and environment snapshot are verified and
active. Production promotion/activation may proceed only through the existing trusted operations
path and only for the approved immutable identities above.

## External action ledger

- production read-only SSH session: `1`
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
