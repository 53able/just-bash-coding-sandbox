# just-bash Execution Report

## Summary

- Task:
- Workflow ID:
- Plan version: `5`
- Runtime: `apple-container / local-macos-only`
- Overall status: `completed | partial | blocked | unverified`
- Intake present: `true | false`
- Assessment status: `assessed | legacy-unassessed (field-omission compatibility label; not authenticated history and not Phase-D assessed)`
- Caller profile: `text-only | standard | high-risk`
- Derived profile: `text-only | standard | high-risk | null (legacy-unassessed)`
- Effective profile: `text-only | standard | high-risk`
- Blocked / route: `false | true` / `none | container | external-microvm`
- Intake SHA-256 / canonical risk decision SHA-256 / reasons:
- External microVM required: `false | true (not implemented; blocked)`

## Plan and Candidate

- Plan SHA-256:
- Tier-A script SHA-256 planned/actual:
- Mutation IDs and types:
- Baseline `beforeSha256` checks:
- Candidate stage mutation IDs:
- Post-image candidate exports:
- Candidate schema-v2 validation path/SHA-256:
- Candidate tree SHA-256:
- Intake phase at promotion: `deliver | legacy-unassessed compatibility`
- Promotion eligible: `true | false`
- Semantic review: `approved | blocked | not run`

## Attempts and Strong Evidence

- Attempt ledger schema/path/SHA-256:
- Retry policy: `maxAttemptsPerOperation=2 | maxBatchRepairCycles=1 | blindRetry=false`

| roleKey | Operation ID | Attempt | Classification | Contract/source/preflight binding | startedAtUtc | endedAtUtc | elapsedMs | Status |
|---|---|---:|---|---|---|---|---:|---|
| TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | `passed | failed | reused | blocked` |

- Operation contract schema: `2`
- Runner bundle SHA-256 (when a strong operation ran):
- Optional intake risk decision/hash contract binding (absent for legacy no-intake):
- Operation status/receipt schema: `2 / 2`
- Immutable image/script/source hashes:
- Exact output kind/path/size/SHA-256:
- Producer handoff sidecar path/SHA-256 (location only):
- `artifactInput` operation/role/contract/source/image/receipt/evidence/tree binding:
- Private artifact snapshot tree SHA-256 and read-only mount check:
- Build-once consumer empty-source/network/consume-only policy:
- Browser preflight binding and viewport artifacts:
- Registry note: `package-install only; broad runtime egress, not domain allowlist | not used`
- Package provenance/review: `trusted-reviewed residual risk accepted | not used`
- Operation ID rename attempts did not reset role budget: `confirmed | violated`

## Review and Host Application

- Deterministic git review patch path/SHA-256:
- Baseline-bound application bundle path/SHA-256:
- `review-patch.mjs` result path/SHA-256 and routing findings (not semantic approval):
- Independent semantic/dependency/security approval:
- Explicit approval JSON path/SHA-256, approver, timestamp:
- Approval bindings (workflow/plan/candidate tree+validation/bundle/review/review-result):
- Host application schema-v2 receipt path/SHA-256:
- Preimage and post-application hash checks:
- Handled-failure rollback: `passed | failed | not exercised`

## Separated Workflow Status

| Dimension | Status | Evidence |
|---|---|---|
| Candidate | `passed | failed | unverified` | TODO |
| Container | `passed | failed | blocked | unverified | not-required` | TODO |
| Host application | `passed | failed | unverified | not-required` | TODO |
| Host runtime | `passed | failed | blocked | unverified | not-required` | TODO |
| Interactive | `passed | failed | blocked | unverified | not-required` | TODO |

- Workflow aggregation path/SHA-256:
- Consumer evidence reuse revalidated the producer handoff: `confirmed | violated | not-used`
- Container success was not promoted to host runtime or interactive success: `confirmed | violated`

## Optional Host Gate Report

- Gate plan path/SHA-256:
- Host-generated gate report path/SHA-256:
- Canonical graph SHA-256:
- Gate report status: `passed | failed | blocked | not-used`
- Deterministic observedThroughUtc and complete gate attempt timing arrays:
- Failed gate operator assessments bind attempt/gate/diagnostic manifest: `confirmed | violated | not-applicable`
- Global cost-order exceptions are gate-specific; dependency timing exceptions are edge-specific:
- Report-only boundary (not scheduler or artifact publication gate): `confirmed | violated`

## Timing and Residual Risks

- Workflow startedAtUtc / endedAtUtc / comparable monotonic elapsedMs:
- Reused evidence retained original elapsedMs:
- Apple Container readiness and script preflight occurred before attempt reservation:
- Blocked/unverified items:
- Same-user tamper, crash/power-loss transaction, and external trust-store limitations:
