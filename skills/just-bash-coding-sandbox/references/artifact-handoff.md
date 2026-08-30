# One-hop Artifact Handoff

Blocked risk decisions are rejected before producer binding emission, consumer validation, evidence reuse, or private snapshot creation; they can never yield a successful handoff. An intake change invalidates the operation-contract binding and requires downstream evidence/handoff regeneration.

Use this procedure only when one earlier strong operation publishes build artifacts and one later operation can validate those exact bytes without repository source. Phase-C v1 supports one producer, one-hop bindings, and the existing local macOS + Apple Container scope. It does not support chains, multi-input merges, cross-host transport, or hostile-script non-rebuild guarantees.

## Producer binding

1. Complete the producer operation and validate its schema-v2 evidence.
2. Emit the binding from current evidence rather than writing it by hand:

```sh
node scripts/validate-artifact-handoff.mjs emit-binding \
  --plan /absolute/plan.json --operation-id build \
  --source /absolute/build-source --evidence /absolute/build-evidence \
  --artifact /absolute/build-artifact
```

Copy only the returned `artifactInput` object into the later consumer operation. It binds schema version, producer operation/role, operation contract, source tree, immutable image, receipt bytes, evidence binding, mode-aware artifact tree, and `rebuildPolicy: forbidden`. Keep the producer operation earlier in the same v5 plan. A producer cannot itself have `artifactInput`.

## Consumer contract

The consumer must:

- use the empty source tree SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
- use network `disabled`;
- use `test`, `native-exec`, or `browser-smoke`;
- avoid build/install/compiler commands in both the operation description and reviewed script;
- read only the fixed `$STRONG_OPERATION_PRODUCER_ARTIFACT` path (`/producer-artifact`);
- declare no handoff chain or second producer.

`rebuildPolicy: forbidden` is a reviewed consume-only policy. It does not prove that a hostile script cannot synthesize different bytes.

## Location sidecar

Do not place host paths in the plan binding. Create a separate local sidecar:

```json
{
  "schemaVersion": 1,
  "source": "/absolute/producer-source",
  "evidence": "/absolute/producer-evidence",
  "artifact": "/absolute/producer-artifact",
  "preflightSource": null,
  "preflightEvidence": null,
  "preflightArtifact": null
}
```

The sidecar contains locations only. The helper stable-reads it, validates producer evidence, recomputes receipt/evidence/tree bindings, snapshots the artifact into a private bounded tree, and only then reserves the consumer attempt. It mounts only that snapshot read-only at `/producer-artifact`.

Validate before running:

```sh
node scripts/validate-artifact-handoff.mjs validate \
  --plan /absolute/plan.json --operation-id smoke \
  --producer-handoff /absolute/producer-handoff.json

scripts/run-strong-operation-apple-container.sh \
  --source /absolute/empty-source --script /absolute/smoke.sh \
  --plan /absolute/plan.json --operation-id smoke \
  --evidence-out /absolute/empty-evidence \
  --attempt-ledger /absolute/ledger.json \
  --producer-handoff /absolute/producer-handoff.json
```

Consumer evidence reuse, workflow role input, and gate input must pass a sidecar that resolves to the same bound producer state again. The consumer gate must directly depend on the producer gate. Any receipt, evidence binding, artifact tree/mode, source, contract, image, or role drift invalidates reuse. Location-only sidecar relocation may pass when every resolved byte and semantic binding is identical. The lower-level `validate-operation-evidence.mjs --emit-producer-binding true` switch exists for internal composition and is not the documented authoring front door.
