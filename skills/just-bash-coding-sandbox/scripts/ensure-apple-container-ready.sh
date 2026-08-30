#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
START=0
STATUS_TIMEOUT_MS=10000
START_TIMEOUT_MS=60000
READINESS_NAME="jbs-system-readiness-$$"
usage() { echo "Usage: scripts/ensure-apple-container-ready.sh [--start]" >&2; exit 2; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --start) START=1; shift ;;
    *) usage ;;
  esac
done
command -v node >/dev/null 2>&1 || { echo "ERROR: trusted host Node.js is required for bounded Apple Container readiness checks." >&2; exit 1; }
command -v container >/dev/null 2>&1 || { echo "ERROR: Apple Container CLI is unavailable." >&2; exit 1; }
run_container_bounded() {
  timeout_ms=$1; phase=$2; shift 2
  node "$SCRIPT_DIR/run-with-timeout.mjs" "$timeout_ms" "$READINESS_NAME-$phase" -- container "$@" >/dev/null 2>&1
}
set +e
run_container_bounded "$STATUS_TIMEOUT_MS" status system status
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "APPLE_CONTAINER_READY status=already-running"
  exit 0
fi
[ "$status" -ne 124 ] || { echo "ERROR: 'container system status' exceeded the hard ${STATUS_TIMEOUT_MS}ms wall-clock bound." >&2; exit 1; }
[ "$START" -eq 1 ] || {
  echo "ERROR: Apple Container service is not running. Explicitly run scripts/ensure-apple-container-ready.sh --start before execution." >&2
  exit 1
}
echo "PREFLIGHT: explicitly starting Apple Container service before execution-attempt reservation." >&2
set +e
run_container_bounded "$START_TIMEOUT_MS" start system start
start_status=$?
set -e
[ "$start_status" -ne 124 ] || { echo "ERROR: 'container system start' exceeded the hard ${START_TIMEOUT_MS}ms wall-clock bound." >&2; exit 1; }
[ "$start_status" -eq 0 ] || { echo "ERROR: 'container system start' failed with exit $start_status." >&2; exit 1; }
run_container_bounded "$STATUS_TIMEOUT_MS" verify system status || { echo "ERROR: Apple Container service did not become ready after explicit start." >&2; exit 1; }
echo "APPLE_CONTAINER_READY status=started"
