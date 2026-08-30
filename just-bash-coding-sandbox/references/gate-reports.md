# Host-generated Gate Reports

Blocked risk decisions are rejected before ledger/evidence consumption and cannot generate, validate, or inspect a successful gate report.

Use this sidecar when a workflow needs an auditable cheap-to-expensive summary. One gate binds one existing strong operation and stable role. The report detects observed ordering violations after execution; it does not schedule operations, prevent an expensive start, gate artifact publication, or replace Phase-C artifact handoff.

## Boundaries

- Preserve the v5 workflow plan, schema-v2 operation status/receipt, launcher CLI, operation contract, and runner bundle.
- Copy `assets/gate-plan.json`. Cover every current-workflow strong role exactly once and bind the exact workflow-plan SHA-256.
- Do not create a report from a template. Only `scripts/generate-gate-report.mjs generate` may exclusively create the host-derived report.
- Treat operator classifications as assessments bound to evidence, not verified root-cause attestations.

## Gate plan rules

Each gate has exact fields `id`, `operationId`, `roleKey`, `costClass`, `orderExceptionReason`, and `dependsOn`.

- Use `cheap`, `standard`, or `expensive` cost classes and normally declare them in nondecreasing order.
- Set `orderExceptionReason` only when a later-declared gate intentionally has a lower cost class than a prior gate.
- Declare each dependency before its consumer. Forward references and cycles are invalid. An operation with `artifactInput` must directly depend on its producer gate.
- Each edge is `{ "gateId": "...", "exceptionReason": null }`. Set its exception only when reviewed overlap or a consumer attempt after a dependency non-pass is intentional.
- The report checks every consumer attempt, including retries, against the dependency's terminal passing attempt.

## Gate inputs

Create one bounded regular JSON input per gate:

```json
{
  "gateId": "build",
  "state": "passed",
  "source": "/absolute/source/path",
  "evidence": "/absolute/evidence/path",
  "artifact": null,
  "preflightSource": null,
  "preflightEvidence": null,
  "preflightArtifact": null,
  "operatorAssessment": null
}
```

- `passed` requires `EVIDENCE_REUSABLE` and a matching final passed ledger attempt. Artifact consumers also require `"producerHandoff": "/absolute/location-sidecar.json"`; legacy gate inputs omit that field.
- `failed` requires current source/contract/preflight binding, exact schema-v2 host failure status, matching failed ledger timestamps, bounded diagnostic manifest, no artifact input, and a bound operator assessment. Failed artifact consumers must also provide the same producer handoff sidecar to `inspect-failure` and the gate input.
- `skipped` requires no attempt or evidence input and at least one non-passed dependency.

The ledger must contain no unknown current-workflow role, no running current attempt, and at most two contiguous attempts per role. The first attempt must be `initial`; a retry must follow a failure, use a recognized non-initial classification and changed binding, and start after the prior attempt ends.

Inspect failure evidence before writing the assessment:

```sh
node scripts/generate-gate-report.mjs inspect-failure \
  --plan /absolute/plan.json --ledger /absolute/attempt-ledger.json \
  --operation-id build --gate-id build \
  --source /absolute/source --evidence /absolute/build-evidence \
  --producer-handoff /absolute/location-sidecar.json
```

Bind its `failedAttemptId` and `diagnosticManifestSha256`:

```json
{
  "kind": "operator-assessment",
  "classification": "candidate",
  "reason": "Release compilation failed after readiness passed.",
  "failedAttemptId": "EXACT_FAILED_ATTEMPT_ID",
  "gateId": "build",
  "diagnosticManifestSha256": "EXACT_DIAGNOSTIC_MANIFEST_SHA256"
}
```

Allowed assessments are `environment`, `candidate`, `validator`, `oracle`, `output-contract`, and `unknown`.

## Generate and revalidate

```sh
node scripts/generate-gate-report.mjs generate \
  --plan /absolute/plan.json --gate-plan /absolute/gate-plan.json \
  --ledger /absolute/attempt-ledger.json \
  --gate-input /absolute/format-input.json \
  --gate-input /absolute/build-input.json \
  --out /absolute/absent-gate-report.json
```

The mode-0600 report contains every gate's complete attempt timing array, workload exit, evidence/diagnostic bindings, deterministic `observedThroughUtc`, graph SHA-256, and precedence `failed > blocked > passed`. Revalidate it with identical inputs by replacing `generate --out` with `validate --report`. Validation stably re-reads bounded no-follow inputs, re-derives exact bytes, and does not trust a report merely because it labels itself `host`.
