#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=""
GUEST_SCRIPT=""
COMMAND=""
PLAN=""
CANDIDATE_OUT=""
SMOKE=0
RUNTIME_DIR=${JUST_BASH_RUNTIME_DIR:-"$HOME/.cache/just-bash-coding-sandbox/3.4.2"}
IMAGE=${JUST_BASH_NODE_IMAGE:-"node@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df"}

usage() {
  echo "Usage: $0 --root <repository> ((--script <file> | --command <text>) --plan <plan.json> [--candidate-out <empty-dir>] | --smoke) [--runtime-dir <dir>]" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) [ "$#" -ge 2 ] || usage; ROOT=$2; shift 2 ;;
    --script) [ "$#" -ge 2 ] || usage; GUEST_SCRIPT=$2; shift 2 ;;
    --command) [ "$#" -ge 2 ] || usage; COMMAND=$2; shift 2 ;;
    --plan) [ "$#" -ge 2 ] || usage; PLAN=$2; shift 2 ;;
    --candidate-out) [ "$#" -ge 2 ] || usage; CANDIDATE_OUT=$2; shift 2 ;;
    --smoke) SMOKE=1; shift ;;
    --runtime-dir) [ "$#" -ge 2 ] || usage; RUNTIME_DIR=$2; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$ROOT" ] || usage
[ -d "$ROOT" ] || { echo "ERROR: repository root does not exist: $ROOT" >&2; exit 1; }
# Fail closed on invalid/blocked caller plans before inspecting or probing the runtime.
if [ "$SMOKE" -eq 0 ]; then
  [ -n "$PLAN" ] && [ -f "$PLAN" ] || usage
  command -v node >/dev/null 2>&1 || { echo "ERROR: trusted host Node.js is required to validate the execution plan." >&2; exit 1; }
  node "$SCRIPT_DIR/validate-execution-plan.mjs" "$PLAN" >/dev/null
fi
[ -d "$RUNTIME_DIR" ] || {
  echo "ERROR: just-bash runtime is missing at $RUNTIME_DIR. Run bootstrap-just-bash-apple-container.sh first." >&2
  exit 1
}
ROOT_ABS=$(CDPATH= cd -- "$ROOT" && pwd -P)
RUNTIME_ABS=$(CDPATH= cd -- "$RUNTIME_DIR" && pwd -P)
reject_mount_path() {
  case "$1" in *','*|*'
'*|*'
'*) echo "ERROR: Apple Container mount paths containing comma or newline are unsupported: $1" >&2; exit 1 ;; esac
}
reject_mount_path "$ROOT_ABS"
reject_mount_path "$RUNTIME_ABS"
case "$IMAGE" in *@sha256:????????????????????????????????????????????????????????????????) : ;; *) echo "ERROR: JUST_BASH_NODE_IMAGE must be an immutable @sha256 reference." >&2; exit 1 ;; esac
case "$RUNTIME_ABS/" in
  "$ROOT_ABS/"*) echo "ERROR: runtime directory must not equal or be inside the repository: $RUNTIME_ABS" >&2; exit 1 ;;
esac
case "$ROOT_ABS/" in
  "$RUNTIME_ABS/"*) echo "ERROR: repository must not be inside the runtime directory: $RUNTIME_ABS" >&2; exit 1 ;;
esac
[ -f "$RUNTIME_ABS/node_modules/just-bash/package.json" ] || {
  echo "ERROR: just-bash runtime is missing at $RUNTIME_ABS. Run bootstrap-just-bash-apple-container.sh first." >&2
  exit 1
}
RUNTIME_DIR=$RUNTIME_ABS

INPUT=""
INPUT_IS_TEMP=0
PLAN_IS_TEMP=0
PLAN_MOUNT_DIR=""
cleanup() {
  if [ "$INPUT_IS_TEMP" -eq 1 ] && [ -n "$INPUT" ]; then rm -f "$INPUT"; fi
  if [ "$PLAN_IS_TEMP" -eq 1 ] && [ -n "$PLAN" ]; then rm -f "$PLAN"; fi
  if [ -n "$PLAN_MOUNT_DIR" ]; then rm -rf "$PLAN_MOUNT_DIR"; fi
}
trap cleanup EXIT INT TERM

if [ "$SMOKE" -eq 1 ]; then
  [ -z "$GUEST_SCRIPT$COMMAND$PLAN$CANDIDATE_OUT" ] || usage
  INPUT=$(mktemp)
  INPUT_IS_TEMP=1
  printf '%s\n' 'set -e' 'printf "runner-smoke-ok\\n"' > "$INPUT"
  PLAN=$(mktemp)
  PLAN_IS_TEMP=1
  cat > "$PLAN" <<'JSON'
{
  "version": 5,
  "workflowId": "runner-smoke",
  "runtime": { "provider": "apple-container", "scope": "local-macos-only" },
  "profile": "text-only",
  "task": "Runner smoke test",
  "workspace": { "root": "repository", "mode": "read-only" },
  "changeSet": { "mutations": [{ "id": "sentinel", "type": "modify", "path": "SMOKE_SENTINEL", "beforeSha256": "0000000000000000000000000000000000000000000000000000000000000000" }], "classes": ["source"], "expectedReviewRequired": false },
  "candidateStage": { "name": "runner-smoke-read-only", "mutationIds": [], "promotable": false },
  "candidateExports": [],
  "capabilities": { "network": { "enabled": false, "allowedUrlPrefixes": [] }, "javascript": false, "python": false, "customCommands": [] },
  "limits": { "maxCommands": 5, "maxOutputBytes": 65536, "maxFileSizeBytes": 1048576, "maxSourceEntries": 1000, "maxSourceBytes": 10485760, "maxMemoryBytes": 67108864, "timeoutMs": 10000 },
  "retryPolicy": { "maxAttemptsPerOperation": 2, "maxBatchRepairCycles": 1, "blindRetry": false },
  "tierA": { "scriptSha256": "95f72faf032a5ae0580dd6434763d72977168fa66c6dc3be4cf1a2f52a962ad0" },
  "completion": { "minStdoutBytes": 16, "requiredStdoutMarkers": ["runner-smoke-ok"] },
  "operations": [{ "kind": "read", "command": "printf runner-smoke-ok", "output": "stdout" }],
  "delivery": { "hostRuntime": { "required": false, "commands": [] }, "interactive": { "required": false, "runner": "none", "command": "", "terminalType": "", "rows": 0, "columns": 0, "oracles": [] } },
  "escalation": { "required": false, "target": "none", "reason": "" }
}
JSON
elif [ -n "$COMMAND" ]; then
  [ -z "$GUEST_SCRIPT" ] && [ -n "$PLAN" ] || usage
  INPUT=$(mktemp)
  INPUT_IS_TEMP=1
  printf '%s\n' "$COMMAND" > "$INPUT"
elif [ -n "$GUEST_SCRIPT" ]; then
  [ -f "$GUEST_SCRIPT" ] || { echo "ERROR: guest script does not exist: $GUEST_SCRIPT" >&2; exit 1; }
  [ -n "$PLAN" ] || usage
  INPUT=$GUEST_SCRIPT
else
  usage
fi

[ -f "$PLAN" ] || { echo "ERROR: execution plan does not exist: $PLAN" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: trusted host Node.js is required to validate the execution plan." >&2; exit 1; }
PLAN_MOUNT_DIR=$(mktemp -d)
cp "$PLAN" "$PLAN_MOUNT_DIR/plan.json"
reject_mount_path "$PLAN_MOUNT_DIR"
node "$SCRIPT_DIR/validate-execution-plan.mjs" "$PLAN_MOUNT_DIR/plan.json" >/dev/null
ACTUAL_SCRIPT_SHA=$(shasum -a 256 "$INPUT" | awk '{print $1}')
PLANNED_SCRIPT_SHA=$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.tierA.scriptSha256)' "$PLAN_MOUNT_DIR/plan.json")
[ "$ACTUAL_SCRIPT_SHA" = "$PLANNED_SCRIPT_SHA" ] || { echo "ERROR: Tier-A script SHA-256 mismatch: plan=$PLANNED_SCRIPT_SHA actual=$ACTUAL_SCRIPT_SHA" >&2; exit 1; }
EXPORT_COUNT=$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.candidateExports.length))' "$PLAN_MOUNT_DIR/plan.json")
TIER_TIMEOUT_MS=$(node -e 'const p=require(process.argv[1]);process.stdout.write(String(p.limits.timeoutMs))' "$PLAN_MOUNT_DIR/plan.json")
TIER_CONTAINER_NAME="jbs-tier-a-$$-$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
if [ "$EXPORT_COUNT" -gt 0 ]; then
  [ -n "$CANDIDATE_OUT" ] || { echo "ERROR: --candidate-out is required because the plan declares candidateExports." >&2; exit 1; }
  [ -d "$CANDIDATE_OUT" ] || { echo "ERROR: candidate output directory does not exist: $CANDIDATE_OUT" >&2; exit 1; }
  CANDIDATE_OUT_ABS=$(CDPATH= cd -- "$CANDIDATE_OUT" && pwd -P)
  reject_mount_path "$CANDIDATE_OUT_ABS"
  case "$CANDIDATE_OUT_ABS/" in
    "$ROOT_ABS/"*|"$RUNTIME_ABS/"*) echo "ERROR: candidate output must be outside the repository and runtime: $CANDIDATE_OUT_ABS" >&2; exit 1 ;;
  esac
  case "$ROOT_ABS/" in "$CANDIDATE_OUT_ABS/"*) echo "ERROR: repository must not be inside candidate output: $CANDIDATE_OUT_ABS" >&2; exit 1 ;; esac
  case "$RUNTIME_ABS/" in "$CANDIDATE_OUT_ABS/"*) echo "ERROR: runtime must not be inside candidate output: $CANDIDATE_OUT_ABS" >&2; exit 1 ;; esac
  [ -z "$(find "$CANDIDATE_OUT_ABS" -mindepth 1 -print -quit)" ] || { echo "ERROR: candidate output directory must be empty: $CANDIDATE_OUT_ABS" >&2; exit 1; }
  "$SCRIPT_DIR/ensure-apple-container-ready.sh" >/dev/null
  node "$SCRIPT_DIR/run-with-timeout.mjs" "$TIER_TIMEOUT_MS" "$TIER_CONTAINER_NAME" -- container run --name "$TIER_CONTAINER_NAME" --rm -i --cpus 1 --memory 768M --cap-drop ALL --read-only --tmpfs /tmp --network none --no-dns \
    --mount "type=bind,source=$RUNTIME_DIR,target=/runtime,readonly" \
    --mount "type=bind,source=$SCRIPT_DIR,target=/skill-scripts,readonly" \
    --mount "type=bind,source=$ROOT_ABS,target=/repo,readonly" \
    --mount "type=bind,source=$PLAN_MOUNT_DIR,target=/execution-plan,readonly" \
    --mount "type=bind,source=$CANDIDATE_OUT_ABS,target=/candidate-output" \
    --workdir /tmp \
    -e JUST_BASH_ROOT=/repo \
    -e JUST_BASH_PACKAGE_ROOT=/runtime \
    -e JUST_BASH_PLAN=/execution-plan/plan.json \
    -e JUST_BASH_CANDIDATE_OUT=/candidate-output \
    "$IMAGE" node /skill-scripts/just-bash-runner.mjs < "$INPUT"
else
  [ -z "$CANDIDATE_OUT" ] || { echo "ERROR: --candidate-out was provided but candidateExports is empty." >&2; exit 1; }
  "$SCRIPT_DIR/ensure-apple-container-ready.sh" >/dev/null
  node "$SCRIPT_DIR/run-with-timeout.mjs" "$TIER_TIMEOUT_MS" "$TIER_CONTAINER_NAME" -- container run --name "$TIER_CONTAINER_NAME" --rm -i --cpus 1 --memory 768M --cap-drop ALL --read-only --tmpfs /tmp --network none --no-dns \
    --mount "type=bind,source=$RUNTIME_DIR,target=/runtime,readonly" \
    --mount "type=bind,source=$SCRIPT_DIR,target=/skill-scripts,readonly" \
    --mount "type=bind,source=$ROOT_ABS,target=/repo,readonly" \
    --mount "type=bind,source=$PLAN_MOUNT_DIR,target=/execution-plan,readonly" \
    --workdir /tmp \
    -e JUST_BASH_ROOT=/repo \
    -e JUST_BASH_PACKAGE_ROOT=/runtime \
    -e JUST_BASH_PLAN=/execution-plan/plan.json \
    "$IMAGE" node /skill-scripts/just-bash-runner.mjs < "$INPUT"
fi
