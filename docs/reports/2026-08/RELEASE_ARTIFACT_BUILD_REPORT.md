# Release Artifact Build Report: `6efe18e`

- generated at: `2026-08-03T09:53:15Z`
- overall status: `ARTIFACT_VERIFIED_AWAITING_PRODUCTION_APPROVAL`
- workflow: existing standard Release Workflow
- build environment: historical production release Vultr Linux environment, manually confirmed for this and equivalent Release Workflow use

The build-environment confirmation is scope-limited. It does not establish permanent trust, automatic authorization, production approval, Provider access, real-funds authority, or trading authority.

## Release identity

- commit SHA: `6efe18eb943b8a57750eeeb06700f101bd676414`
- tree SHA: `4963acf254d3fa6f9483aa21646befef9ded83f3`
- parent commit: `df39e24df019f3905b906563a0b28a62e45d1362`
- source archive SHA-256: `0e7153e70d384c37bbd318ff59b093fdbfb291678e8588bc188f3bba821f974d`
- source archive embedded commit: `6efe18eb943b8a57750eeeb06700f101bd676414`
- candidate tree SHA-256: `4dcd9d4545f47e0e0f8a83f380ec3e78c2b6cc0b4bd64a4c2d2766d77ce8548a`
- build timestamp: `2026-08-03T09:51:35Z`

## Trusted build environment authentication

- human environment confirmation: `PASS`
- existing connection/build entry reused: `PASS`
- new connection method created: `NO`
- Linux platform: `PASS`
- controlled root identity: `PASS`
- existing verified-release marker: `PASS`
- historical canonical revision match: `PASS` (`1ad3579c8f7b1c0f9b9982701db14871ec9d672e`)
- Docker daemon and fixed binary boundary: `PASS`
- candidate path isolation: `PASS`
- minimum build-space preflight: `PASS`

No hostname, address, account, credential, key, token, or sensitive access detail is recorded in this report.

## Workflow results

### 1. Git revision — `PASS`

The clean detached source candidate and Git archive both bind to the requested full commit and tree. The dirty primary worktree was not used as build input.

### 2. Trusted Linux candidate — `PASS`

The existing candidate installer consumed the fixed incoming archive and created the revision-scoped candidate root.

- candidate receipt SHA-256: `f6b97b2d7cc28590ab6598fcd945ce9a5bf9d1e56fc29985a37ac3c8fb8f71a7`
- candidate receipt revision: `6efe18eb943b8a57750eeeb06700f101bd676414`
- receipt source archive SHA-256: `0e7153e70d384c37bbd318ff59b093fdbfb291678e8588bc188f3bba821f974d`
- receipt candidate tree SHA-256: `4dcd9d4545f47e0e0f8a83f380ec3e78c2b6cc0b4bd64a4c2d2766d77ce8548a`

### 3. Artifact build — `PASS`

The candidate's existing `trusted-operation-launcher.mjs release-build` entry invoked the existing `build-release-images.sh`. All images were built for `linux/amd64`; the integrated candidate verifier checked image digest, platform, OCI revision label, and embedded revision.

- `xingheng-api`: `sha256:02068e1ac06b730fd27cfc976fa92baff102b1851d1562bcd6f7eb02c6dd6c59`
- `xingheng-web`: `sha256:4c8b58d0e88ee2c585394ba7f9966bc6e589395fa6a81534174d75262ef01968`
- `xingheng-strategy-tools`: `sha256:1aa087aa274bfeb9dd82e6d498e88e4e4d07fba4ad1044e6acc0b79f49ff05f4`

### 4. Manifest generation — `PASS`

- manifest revision: `6efe18eb943b8a57750eeeb06700f101bd676414`
- manifest SHA-256: `ceab5314a0e37e4c7886433a2a91c0cb352bf79f956dc167345d5e5f498b142a`
- manifest schema: `PASS`
- manifest mode/boundary: `PASS` (`0444`, root-owned, regular single-link file)
- `RELEASE_SHA256SUMS` SHA-256: `3e5aa884f66e3322c93b339c11737ece0ced9b0d66e1736f2ae07a7b0ff78dac`

### 5. Release verify — `PASS`

Independent post-build read-only checks verified:

- `RELEASE_SHA256SUMS`: `PASS`
- trusted candidate receipt schema and live candidate tree identity: `PASS`
- `code.tar` identity: `PASS`
- `candidate-build-receipt.json` identity: `PASS`
- `release-manifest.json` schema/revision/digest binding: `PASS`
- artifact image revision/digest/platform verification: `PASS` in the trusted release-build boundary

Frozen checksums:

```text
0e7153e70d384c37bbd318ff59b093fdbfb291678e8588bc188f3bba821f974d  code.tar
f6b97b2d7cc28590ab6598fcd945ce9a5bf9d1e56fc29985a37ac3c8fb8f71a7  candidate-build-receipt.json
ceab5314a0e37e4c7886433a2a91c0cb352bf79f956dc167345d5e5f498b142a  release-manifest.json
```

## Formal artifact evidence

The four required evidence files exist in the trusted revision-scoped candidate root:

| Evidence | State | Mode | SHA-256 |
| --- | --- | --- | --- |
| `code.tar` | `VERIFIED` | `0400` | `0e7153e70d384c37bbd318ff59b093fdbfb291678e8588bc188f3bba821f974d` |
| `candidate-build-receipt.json` | `VERIFIED` | `0400` | `f6b97b2d7cc28590ab6598fcd945ce9a5bf9d1e56fc29985a37ac3c8fb8f71a7` |
| `release-manifest.json` | `VERIFIED` | `0444` | `ceab5314a0e37e4c7886433a2a91c0cb352bf79f956dc167345d5e5f498b142a` |
| `RELEASE_SHA256SUMS` | `VERIFIED` | `0444` | `3e5aa884f66e3322c93b339c11737ece0ced9b0d66e1736f2ae07a7b0ff78dac` |

The trusted candidate root is `/opt/xingheng-release/candidates/6efe18eb943b8a57750eeeb06700f101bd676414`. This path records artifact location only and contains no access information.

## Production status

- historical/current deployment revision: `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- candidate deployment revision: `NOT_DEPLOYED`
- production preflight: `NOT_RUN_PENDING_APPROVAL`
- canonical promotion: `NOT_RUN_PENDING_APPROVAL`
- trusted operations installation: `NOT_RUN_PENDING_APPROVAL`
- standard activation: `NOT_RUN_PENDING_APPROVAL`
- deployment verification: `NOT_RUN`
- lifecycle completion for `6efe18e`: `NOT_CREATED`

No candidate manifest was installed into the canonical production path. The current production revision remained unchanged after build and verification.

## Authorization boundary

- Provider Access: `NOT_AUTHORIZED`
- Real Funds: `NOT_AUTHORIZED`
- Execution: `BLOCKED_PENDING_AUTHORIZATION`
- real-funds Permit generated: `NO`
- Provider connection attempted: `NO`
- trade attempted: `NO`
- approval gate bypassed: `NO`

## Tests and security observations

- supplied Runtime Permit test evidence: `127/127 PASS`
- release check: `PASS`
- source archive identity: `PASS`
- trusted candidate installation: `PASS`
- production application build: `PASS`
- trusted candidate image verification: `PASS`
- post-build release evidence verification: `PASS`

The Docker build emitted existing dependency audit warnings:

- full build dependency install: `7 vulnerabilities` (`1 low`, `6 high`)
- runtime dependency install: `4 vulnerabilities` (`1 low`, `3 high`)

No dependency was upgraded or modified because that is outside this release task. These warnings must be included in the existing security/production approval review; this artifact report does not classify them as accepted production risk.

## Final audit summary

```text
Changed files:
- PROJECT_CONTEXT.md
- RELEASE_ARTIFACT_BUILD_REPORT.md
Commit SHA: 6efe18eb943b8a57750eeeb06700f101bd676414 (target source; report/context changes are uncommitted)
Tree SHA: 4963acf254d3fa6f9483aa21646befef9ded83f3 (target source; report/context changes are uncommitted)
Tests: release-check PASS; source archive PASS; trusted candidate PASS; artifact build PASS; manifest/checksums/release verify PASS; supplied Runtime Permit suite 127/127 PASS
Risk: npm audit warnings require existing security/production gate review; no Provider, funds, Permit issuance, trade, promotion, activation, or production runtime mutation occurred
Remaining blockers: production security/approval gate; production preflight; canonical promotion; trusted operations installation; standard activation; deployment verification; lifecycle completion
```
