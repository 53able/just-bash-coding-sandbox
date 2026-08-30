#!/bin/bash
set -u
RUNNER_BUNDLE_VERSION=3
if [[ ${STRONG_OPERATION_RUNNER_BUNDLE_VERSION:-} != "$RUNNER_BUNDLE_VERSION" ]]; then
  printf 'ERROR: runner bundle version mismatch: entrypoint=%s launcher=%s\n' "$RUNNER_BUNDLE_VERSION" "${STRONG_OPERATION_RUNNER_BUNDLE_VERSION:-missing}" >&2
  exit 125
fi
code=0
/bin/printf 'started\n' > /lifecycle/started || exit 124
while IFS= read -r tool; do [[ -z "$tool" ]] && continue; command -v -- "$tool" >/dev/null 2>&1 || { printf 'ERROR: required tool unavailable: %s\n' "$tool" >&2; code=127; break; }; done < /guest/required-tools.txt
if [[ $code -eq 0 ]]; then /bin/mkdir -p /tmp/home /tmp/cache || code=$?; fi
if [[ $code -eq 0 ]]; then /bin/chmod 700 /tmp/home /tmp/cache || code=$?; fi
if [[ $code -eq 0 ]]; then /bin/cp -a /source/. /work/ || code=$?; fi
if [[ $code -eq 0 ]]; then cd /work || code=$?; if [[ $code -eq 0 ]]; then export STRONG_OPERATION_WORKSPACE=/work STRONG_OPERATION_EVIDENCE_OUT=/evidence STRONG_OPERATION_ARTIFACT_OUT=/artifacts; /bin/bash -Eeuo pipefail /guest/operation.sh; code=$?; fi; fi
/bin/printf '%d\n' "$code" > /lifecycle/completed.tmp || exit 124
/bin/mv -f /lifecycle/completed.tmp /lifecycle/completed || exit 124
exit "$code"
