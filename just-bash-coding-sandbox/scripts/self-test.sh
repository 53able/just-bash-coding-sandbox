#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TMP=$(mktemp -d);trap 'rm -rf "$TMP"' EXIT INT TERM
sha(){ shasum -a 256 "$1"|awk '{print $1}'; }
expect_fail(){ label=$1;shift;set +e;"$@" >"$TMP/$label.out" 2>"$TMP/$label.err";status=$?;set -e;[ "$status" -ne 0 ]||{ echo "ERROR: expected failure: $label" >&2;exit 1;}; }
for file in "$SCRIPT_DIR"/*.sh;do sh -n "$file";done
for file in "$SCRIPT_DIR"/*.mjs;do node --check "$file";done
# Phase-C compatibility pin: the public launcher bytes remain unchanged; schema-v2 external bytes are asserted below.
[ "$(sha "$SCRIPT_DIR/run-strong-operation-apple-container.sh")" = beff05ae650fc113ce292221825b46bc57fc429b04e373af782d4f51a37a0232 ]

GOOD="$TMP/good.sh";cat >"$GOOD" <<'SH'
set -Eeuo pipefail
# JBS_HEREDOC javascript-module
cat >/tmp/x.mjs <<'JS'
const ok={value:true};
JS
SH
node "$SCRIPT_DIR/preflight-operation-script.mjs" --script "$GOOD"|grep -q embeddedJavaScript=1
BAD="$TMP/bad.sh";cat >"$BAD" <<'SH'
set -Eeuo pipefail
cat >/tmp/x <<'DATA'
x
DATA
SH
expect_fail undeclared-heredoc node "$SCRIPT_DIR/preflight-operation-script.mjs" --script "$BAD"

BASE="$TMP/base";CAND="$TMP/candidate";HOST="$TMP/host";mkdir -p "$BASE/nested" "$CAND/nested" "$HOST"
printf old >"$BASE/nested/modify.txt";printf remove >"$BASE/nested/delete.txt";printf move >"$BASE/nested/old-name.txt"
cp -R "$BASE/." "$HOST/";printf new >"$CAND/nested/modify.txt";printf added >"$CAND/add.txt";printf move >"$CAND/nested/new-name.txt"
PLAN="$TMP/plan.json";TIER="$TMP/tier.sh";printf 'set -e\nprintf TASK_COMPLETE\\n\n' >"$TIER"
node - "$PLAN" "$(sha "$TIER")" "$(sha "$BASE/nested/modify.txt")" "$(sha "$BASE/nested/delete.txt")" "$(sha "$BASE/nested/old-name.txt")" <<'NODE'
const fs=require('fs');const [out,tier,mod,del,ren]=process.argv.slice(2);const p={version:5,workflowId:'self-test',runtime:{provider:'apple-container',scope:'local-macos-only'},profile:'text-only',task:'v5 mutation test',workspace:{root:'repository',mode:'overlay-cow'},changeSet:{mutations:[{id:'add',type:'add',path:'add.txt',beforeSha256:null},{id:'modify',type:'modify',path:'nested/modify.txt',beforeSha256:mod},{id:'delete',type:'delete',path:'nested/delete.txt',beforeSha256:del},{id:'rename',type:'rename',from:'nested/old-name.txt',to:'nested/new-name.txt',beforeSha256:ren}],classes:['source'],expectedReviewRequired:false},candidateStage:{name:'complete',mutationIds:['add','modify','delete','rename'],promotable:true},candidateExports:['add.txt','nested/modify.txt','nested/new-name.txt'],capabilities:{network:{enabled:false,allowedUrlPrefixes:[]},javascript:false,python:false,customCommands:[]},limits:{maxCommands:20,maxOutputBytes:1048576,maxFileSizeBytes:1048576,maxSourceEntries:100,maxSourceBytes:1048576,maxMemoryBytes:67108864,timeoutMs:10000},retryPolicy:{maxAttemptsPerOperation:2,maxBatchRepairCycles:1,blindRetry:false},tierA:{scriptSha256:tier},completion:{minStdoutBytes:4,requiredStdoutMarkers:['TASK_COMPLETE']},operations:[{kind:'text-edit',command:'write post images',output:'nested/modify.txt'}],delivery:{hostRuntime:{required:false,commands:[]},interactive:{required:false,runner:'none',command:'',terminalType:'',rows:0,columns:0,oracles:[]}},escalation:{required:false,target:'none',reason:''}};fs.writeFileSync(out,JSON.stringify(p));
NODE
node "$SCRIPT_DIR/validate-execution-plan.mjs" "$PLAN"|grep -q SAFE_FAST_PATH
# Phase-D strict intake, derived/effective risk, fail-closed triggers, and deterministic JSON exits.
ASSESSED="$TMP/assessed.json";BLOCKED="$TMP/blocked.json";INVALID_INTAKE="$TMP/invalid-intake.json";node - "$PLAN" "$ASSESSED" "$BLOCKED" "$INVALID_INTAKE" <<'NODE'
const fs=require('fs'),base=require(process.argv[2]);const intake={schemaVersion:1,phase:'change',workloadProfile:'library',interfaceMode:'none',repository:{trust:'trusted-reviewed',codeOrigin:'first-party'},requirements:{privilege:'none',processLifetime:'bounded-foreground',hostSockets:[],credentials:'none',network:'none'}};const assessed=structuredClone(base);assessed.intake=intake;assessed.candidateStage.promotable=false;const blocked=structuredClone(assessed);blocked.intake.repository.trust='unknown';blocked.escalation={required:true,target:'external-microvm',reason:'risk intake'};const invalid=structuredClone(assessed);delete invalid.intake.phase;fs.writeFileSync(process.argv[3],JSON.stringify(assessed));fs.writeFileSync(process.argv[4],JSON.stringify(blocked));fs.writeFileSync(process.argv[5],JSON.stringify(invalid));
NODE
node - "$SCRIPT_DIR/validate-execution-plan.mjs" "$ASSESSED" <<'NODE'
import(process.argv[2]).then(({validatePlan})=>{const fs=require('fs'),base=JSON.parse(fs.readFileSync(process.argv[3])),clone=()=>structuredClone(base),assert=(ok,message)=>{if(!ok)throw new Error(message)};let r=validatePlan(base);assert(!r.errors.length&&r.riskDecision.derivedProfile==='standard'&&r.riskDecision.effectiveProfile==='standard'&&!r.blocked,'engineering workload must override understated caller profile');const omitted=clone();delete omitted.intake;r=validatePlan(omitted);assert(!r.errors.length&&!('riskDecision' in r)&&!('blocked' in r),'field omission alone must select the downgrade-compatible unassessed path');for(const mutate of [p=>delete p.intake.phase,p=>p.intake.extra=true,p=>p.intake.schemaVersion='1',p=>p.intake.phase='write',p=>p.intake.workloadProfile='desktop',p=>p.intake.interfaceMode='terminal',p=>delete p.intake.repository.trust,p=>p.intake.repository.extra=true,p=>delete p.intake.requirements.network,p=>p.intake.requirements.extra=true,p=>p.intake.repository.trust='trusted',p=>p.intake.repository.codeOrigin='generated',p=>p.intake.requirements.privilege='root',p=>p.intake.requirements.processLifetime='forever',p=>p.intake.requirements.hostSockets='docker',p=>p.intake.requirements.hostSockets=['docker','docker'],p=>p.intake.requirements.credentials='ambient',p=>p.intake.requirements.network='internet']){const p=clone();mutate(p);assert(validatePlan(p).errors.length,'strict intake mutation was accepted')}for(const mutate of [p=>p.intake.repository.trust='unknown',p=>p.intake.repository.trust='untrusted',p=>p.intake.repository.trust='hostile',p=>p.intake.repository.codeOrigin='unreviewed-third-party',p=>p.intake.repository.codeOrigin='generated-unreviewed',p=>p.intake.repository.codeOrigin='unknown',p=>p.intake.requirements.privilege='guest-elevated',p=>p.intake.requirements.privilege='host-elevated',p=>p.intake.requirements.privilege='kernel',p=>p.intake.requirements.privilege='unknown',p=>p.intake.requirements.processLifetime='persistent-daemon',p=>p.intake.requirements.processLifetime='host-daemon',p=>p.intake.requirements.processLifetime='unknown',...[...['docker','container-runtime','ssh-agent','gpg-agent','system','custom','unknown']].map(socket=>p=>p.intake.requirements.hostSockets=[socket]),p=>p.intake.requirements.credentials='ephemeral-task-scoped',p=>p.intake.requirements.credentials='host-inherited',p=>p.intake.requirements.credentials='persistent',p=>p.intake.requirements.credentials='unknown',p=>p.intake.requirements.network='origin-specific',p=>p.intake.requirements.network='broad-egress',p=>p.intake.requirements.network='unknown',p=>p.profile='high-risk',p=>p.operations=[{kind:'docker'}],p=>p.operations=[{kind:'unknown'}]]){const p=clone();mutate(p);p.escalation={required:true,target:'external-microvm',reason:'risk'};r=validatePlan(p);assert(!r.errors.length&&r.blocked&&r.riskDecision.effectiveProfile==='high-risk'&&r.riskDecision.route==='external-microvm',`high trigger failed: ${JSON.stringify(r)}`)}{const p=clone();p.intake.repository.trust='trusted-unreviewed';p.escalation={required:true,target:'external-microvm',reason:'unreviewed trust'};r=validatePlan(p);assert(!r.errors.length&&r.blocked,'trusted-unreviewed must be high risk')}{const p=clone();p.intake.repository.codeOrigin='generated-reviewed';r=validatePlan(p);assert(!r.errors.length&&!r.blocked,'generated-reviewed alone became high risk')}const inspect=clone();inspect.intake.phase='inspect';assert(!validatePlan(inspect).errors.length,'inspect safe structure rejected');const validate=clone();validate.intake.phase='validate';assert(!validatePlan(validate).errors.length,'validate safe structure rejected');const promote=clone();promote.candidateStage.promotable=true;assert(validatePlan(promote).errors.some(e=>e.includes('promotion is delivery')),'non-deliver promotable stage accepted');const delivery=clone();delivery.intake.phase='validate';delivery.delivery.hostRuntime={required:true,commands:['echo ok']};assert(validatePlan(delivery).errors.some(e=>e.includes('disallows')),'validate delivery accepted');});
NODE
node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$ASSESSED" >"$TMP/intake-json-1";node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$ASSESSED" >"$TMP/intake-json-2";cmp "$TMP/intake-json-1" "$TMP/intake-json-2";node - "$TMP/intake-json-1" <<'NODE'
const fs=require('fs'),text=fs.readFileSync(process.argv[2],'utf8'),v=JSON.parse(text),keys=['schemaVersion','status','intakePresent','assessmentStatus','callerProfile','derivedProfile','effectiveProfile','blocked','route','intakeSha256','riskDecisionSha256','reasons','errors'];if(Object.keys(v).join()!==keys.join()||v.status!=='executable'||v.intakePresent!==true||v.assessmentStatus!=='assessed'||v.callerProfile!=='text-only'||v.effectiveProfile!=='standard'||v.blocked!==false||!/^([a-f0-9]{64})$/.test(v.intakeSha256)||!/^([a-f0-9]{64})$/.test(v.riskDecisionSha256)||!text.endsWith('\n'))process.exit(1);
NODE
set +e;node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$INVALID_INTAKE" >"$TMP/intake-invalid-json";intake_invalid_status=$?;node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$INVALID_INTAKE" >"$TMP/intake-invalid-json-2";intake_invalid_status_2=$?;node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$BLOCKED" >"$TMP/intake-blocked-json";intake_blocked_status=$?;node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$BLOCKED" >"$TMP/intake-blocked-json-2";intake_blocked_status_2=$?;set -e;[ "$intake_invalid_status" -eq 2 ];[ "$intake_invalid_status_2" -eq 2 ];[ "$intake_blocked_status" -eq 3 ];[ "$intake_blocked_status_2" -eq 3 ];cmp "$TMP/intake-invalid-json" "$TMP/intake-invalid-json-2";cmp "$TMP/intake-blocked-json" "$TMP/intake-blocked-json-2";set +e;node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$ASSESSED" >/dev/null 2>"$TMP/executable-json.err";executable_json_status=$?;node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$INVALID_INTAKE" >/dev/null 2>"$TMP/invalid-json.err";invalid_json_status=$?;node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$BLOCKED" >/dev/null 2>"$TMP/blocked-json.err";blocked_json_status=$?;set -e;[ "$executable_json_status" -eq 0 ];[ "$invalid_json_status" -eq 2 ];[ "$blocked_json_status" -eq 3 ];[ ! -s "$TMP/executable-json.err" ];[ ! -s "$TMP/invalid-json.err" ];[ ! -s "$TMP/blocked-json.err" ];grep -q '"status":"invalid"' "$TMP/intake-invalid-json";grep -q '"status":"blocked"' "$TMP/intake-blocked-json"
node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$PLAN" >"$TMP/legacy-json";node - "$TMP/legacy-json" <<'NODE'
const fs=require('fs'),v=JSON.parse(fs.readFileSync(process.argv[2])),keys=['schemaVersion','status','intakePresent','assessmentStatus','callerProfile','derivedProfile','effectiveProfile','blocked','route','intakeSha256','riskDecisionSha256','reasons','errors'];if(Object.keys(v).join()!==keys.join()||v.status!=='executable'||v.intakePresent!==false||v.assessmentStatus!=='legacy-unassessed'||v.derivedProfile!==null||v.intakeSha256!==null||v.riskDecisionSha256!==null)process.exit(1);
NODE
MALFORMED="$TMP/malformed.json";printf '{' >"$MALFORMED";set +e;node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$MALFORMED" >"$TMP/malformed-1.out" 2>"$TMP/malformed-1.err";malformed_status=$?;node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$MALFORMED" >"$TMP/malformed-2.out" 2>"$TMP/malformed-2.err";malformed_status_2=$?;set -e;[ "$malformed_status" -eq 2 ];[ "$malformed_status_2" -eq 2 ];cmp "$TMP/malformed-1.out" "$TMP/malformed-2.out";cmp "$TMP/malformed-1.err" "$TMP/malformed-2.err";[ ! -s "$TMP/malformed-1.err" ];node - "$TMP/malformed-1.out" <<'NODE'
const fs=require('fs'),v=JSON.parse(fs.readFileSync(process.argv[2])),keys=['schemaVersion','status','intakePresent','assessmentStatus','callerProfile','derivedProfile','effectiveProfile','blocked','route','intakeSha256','riskDecisionSha256','reasons','errors'];if(Object.keys(v).join()!==keys.join()||v.status!=='invalid'||v.assessmentStatus!=='unavailable'||v.errors.length!==1)process.exit(1);
NODE
expect_fail json-usage node "$SCRIPT_DIR/validate-execution-plan.mjs" --json;grep -q '^ERROR: Usage:' "$TMP/json-usage.err";[ ! -s "$TMP/json-usage.out" ]
SOCKET_A="$TMP/socket-a.json";SOCKET_B="$TMP/socket-b.json";node - "$ASSESSED" "$SOCKET_A" "$SOCKET_B" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]),a=structuredClone(p),b=structuredClone(p);for(const v of [a,b])v.escalation={required:true,target:'external-microvm',reason:'socket risk'};a.intake.requirements.hostSockets=['ssh-agent','docker'];b.intake.requirements.hostSockets=['docker','ssh-agent'];fs.writeFileSync(process.argv[3],JSON.stringify(a));fs.writeFileSync(process.argv[4],JSON.stringify(b));
NODE
set +e;node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$SOCKET_A" >"$TMP/socket-a.out";socket_a_status=$?;node "$SCRIPT_DIR/validate-execution-plan.mjs" --json "$SOCKET_B" >"$TMP/socket-b.out";socket_b_status=$?;set -e;[ "$socket_a_status" -eq 3 ];[ "$socket_b_status" -eq 3 ];cmp "$TMP/socket-a.out" "$TMP/socket-b.out"
for v in 1 2 3 4;do OLD="$TMP/v$v.json";node - "$PLAN" "$OLD" "$v" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.version=Number(process.argv[4]);fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
expect_fail "reject-v$v" node "$SCRIPT_DIR/validate-execution-plan.mjs" "$OLD";grep -q "version $v plans are rejected" "$TMP/reject-v$v.err";done
OVERLAP="$TMP/overlap.json";node - "$PLAN" "$OVERLAP" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.changeSet.mutations[0]={id:'add',type:'add',path:'nested',beforeSha256:null};p.candidateStage.mutationIds=['add','modify','delete','rename'];p.candidateExports=['nested','nested/modify.txt','nested/new-name.txt'];fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
expect_fail ancestor-overlap node "$SCRIPT_DIR/validate-execution-plan.mjs" "$OVERLAP";grep -q 'ancestor/descendant' "$TMP/ancestor-overlap.err"
HIGH="$TMP/high.json";node - "$PLAN" "$HIGH" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.profile='high-risk';p.escalation={required:true,target:'external-microvm',reason:'hostile'};fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
expect_fail external-microvm node "$SCRIPT_DIR/validate-execution-plan.mjs" "$HIGH";grep -q 'not implemented' "$TMP/external-microvm.err"
ZIG_PLAN="$TMP/zig-plan.json";node - "$PLAN" "$ZIG_PLAN" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.changeSet.mutations=[{id:'zig',type:'add',path:'build.zig',beforeSha256:null}];p.candidateStage={name:'zig',mutationIds:['zig'],promotable:true};p.candidateExports=['build.zig'];p.operations=[{kind:'file-generate',command:'write Zig build manifest',output:'build.zig'}];fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
expect_fail zig-build-routing node "$SCRIPT_DIR/validate-execution-plan.mjs" "$ZIG_PLAN";grep -q 'changeSet.classes must include dependency' "$TMP/zig-build-routing.err";grep -q 'changeSet.classes must include automation' "$TMP/zig-build-routing.err"
ZON_PLAN="$TMP/zig-zon-plan.json";node - "$PLAN" "$ZON_PLAN" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.changeSet.mutations=[{id:'zon',type:'add',path:'build.zig.zon',beforeSha256:null}];p.candidateStage={name:'zon',mutationIds:['zon'],promotable:true};p.candidateExports=['build.zig.zon'];p.operations=[{kind:'file-generate',command:'write Zig dependency manifest',output:'build.zig.zon'}];fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
expect_fail zig-zon-routing node "$SCRIPT_DIR/validate-execution-plan.mjs" "$ZON_PLAN";grep -q 'changeSet.classes must include dependency' "$TMP/zig-zon-routing.err"
ZIG_CMD="$TMP/zig-command.json";node - "$PLAN" "$ZIG_CMD" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.operations=[{kind:'read',command:'zig build',output:'stdout'}];fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
expect_fail zig-command-routing node "$SCRIPT_DIR/validate-execution-plan.mjs" "$ZIG_CMD";grep -q 'contains a runtime, package manager, shell, build tool, or native command' "$TMP/zig-command-routing.err"
ZIG_PATCH="$TMP/zig.patch";cat > "$ZIG_PATCH" <<'PATCH'
diff --git a/build.zig b/build.zig
new file mode 100644
--- /dev/null
+++ b/build.zig
@@ -0,0 +1 @@
+pub fn build() void {}
PATCH
set +e;node "$SCRIPT_DIR/review-patch.mjs" --patch "$ZIG_PATCH" --allow build.zig > "$TMP/zig-review.json";zig_review_status=$?;set -e;[ "$zig_review_status" -eq 2 ];grep -q '"dependency"' "$TMP/zig-review.json";grep -q '"automation"' "$TMP/zig-review.json"

# Gate-report infrastructure must route identically in plan validation and patch review.
for routing_spec in \
  gate-plan:assets/gate-plan.json \
  gate-reference:references/gate-reports.md \
  gate-cli:scripts/generate-gate-report.mjs \
  gate-contract:scripts/gate-report-contract.mjs \
  artifact-reference:references/artifact-handoff.md \
  efficiency-reference:references/workflow-efficiency.md \
  artifact-cli:scripts/validate-artifact-handoff.mjs \
  artifact-contract:scripts/artifact-handoff-contract.mjs
do
  routing_label=${routing_spec%%:*};routing_path=${routing_spec#*:};ROUTING_PLAN="$TMP/$routing_label-plan.json"
  node - "$PLAN" "$ROUTING_PLAN" "$routing_path" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]),out=process.argv[3],target=process.argv[4];p.changeSet={mutations:[{id:'gate-routing',type:'add',path:target,beforeSha256:null}],classes:['source'],expectedReviewRequired:false};p.candidateStage={name:'gate-routing',mutationIds:['gate-routing'],promotable:true};p.candidateExports=[target];p.operations=[{kind:'file-generate',command:'write gate-report infrastructure',output:target}];fs.writeFileSync(out,JSON.stringify(p));
NODE
  expect_fail "$routing_label-routing" node "$SCRIPT_DIR/validate-execution-plan.mjs" "$ROUTING_PLAN"
  grep -q 'changeSet.classes must include sandbox-infrastructure' "$TMP/$routing_label-routing.err"
  grep -q 'changeSet.expectedReviewRequired must be true for non-source target classes' "$TMP/$routing_label-routing.err"
  ROUTING_PATCH="$TMP/$routing_label.patch";ROUTING_REVIEW="$TMP/$routing_label-review.json"
  printf 'diff --git a/%s b/%s\nnew file mode 100644\n--- /dev/null\n+++ b/%s\n@@ -0,0 +1 @@\n+gate-report infrastructure\n' "$routing_path" "$routing_path" "$routing_path" > "$ROUTING_PATCH"
  set +e;node "$SCRIPT_DIR/review-patch.mjs" --patch "$ROUTING_PATCH" --allow "$routing_path" > "$ROUTING_REVIEW";routing_review_status=$?;set -e
  [ "$routing_review_status" -eq 2 ];grep -q '"status": "PATCH_REVIEW_REQUIRED"' "$ROUTING_REVIEW";grep -q '"sandbox-infrastructure"' "$ROUTING_REVIEW"
done

CVALID="$TMP/candidate-validation.json";node "$SCRIPT_DIR/validate-candidate-tree.mjs" --root "$CAND" --baseline "$BASE" --plan "$PLAN" >"$CVALID"
grep -q '"schemaVersion": 2' "$CVALID";grep -q '"type": "delete"' "$CVALID"
ASSESSED_CVALID="$TMP/assessed-candidate-validation.json";node "$SCRIPT_DIR/validate-candidate-tree.mjs" --root "$CAND" --baseline "$BASE" --plan "$ASSESSED" >"$ASSESSED_CVALID";grep -q '"promotionEligible": false' "$ASSESSED_CVALID"
expect_fail change-bundle-bypass node "$SCRIPT_DIR/generate-candidate-patch.mjs" --baseline "$BASE" --candidate "$CAND" --plan "$ASSESSED" --candidate-validation "$ASSESSED_CVALID" --out "$TMP/change-bundle" --review-out "$TMP/change-review";grep -q 'requires intake.phase=deliver' "$TMP/change-bundle-bypass.err";[ ! -e "$TMP/change-bundle" ];[ ! -e "$TMP/change-review" ]
BUNDLE="$TMP/application-bundle.json";REVIEW="$TMP/review.patch";node "$SCRIPT_DIR/generate-candidate-patch.mjs" --baseline "$BASE" --candidate "$CAND" --plan "$PLAN" --candidate-validation "$CVALID" --out "$BUNDLE" --review-out "$REVIEW" >"$TMP/generate.json"
BUNDLE2="$TMP/application-bundle-2.json";REVIEW2="$TMP/review-2.patch";node "$SCRIPT_DIR/generate-candidate-patch.mjs" --baseline "$BASE" --candidate "$CAND" --plan "$PLAN" --candidate-validation "$CVALID" --out "$BUNDLE2" --review-out "$REVIEW2" >/dev/null
cmp "$BUNDLE" "$BUNDLE2";cmp "$REVIEW" "$REVIEW2";grep -q '^diff --git ' "$REVIEW"
PATCH_REVIEW="$TMP/patch-review.json";node "$SCRIPT_DIR/review-patch.mjs" --patch "$REVIEW" --allow add.txt --allow nested/modify.txt --allow nested/delete.txt --allow nested/old-name.txt --allow nested/new-name.txt >"$PATCH_REVIEW";grep -q PATCH_PASS "$PATCH_REVIEW"
APPROVAL="$TMP/approval.json";node - "$PLAN" "$CVALID" "$BUNDLE" "$REVIEW" "$PATCH_REVIEW" "$APPROVAL" <<'NODE'
const fs=require('fs'),crypto=require('crypto');const [plan,candidate,bundle,review,patchReview,out]=process.argv.slice(2),hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),c=require(candidate),p=require(plan);fs.writeFileSync(out,JSON.stringify({schemaVersion:1,authority:'human',provenance:'explicit-candidate-promotion-approval',decision:'approved',workflowId:p.workflowId,planSha256:hash(plan),candidateValidationSha256:hash(candidate),candidateTreeSha256:c.candidateTreeSha256,applicationBundleSha256:hash(bundle),reviewPatchSha256:hash(review),patchReviewSha256:hash(patchReview),approver:'self-test-reviewer',approvedAtUtc:'2026-01-01T00:00:00.000Z'})+'\n');
NODE
RECEIPT="$TMP/application-receipt.json";node "$SCRIPT_DIR/apply-candidate-patch.mjs" --root "$HOST" --plan "$PLAN" --candidate-validation "$CVALID" --bundle "$BUNDLE" --review-patch "$REVIEW" --patch-review "$PATCH_REVIEW" --approval "$APPROVAL" --receipt "$RECEIPT"|grep -q HOST_APPLICATION_PASS
[ "$(cat "$HOST/nested/modify.txt")" = new ];[ "$(cat "$HOST/add.txt")" = added ];[ ! -e "$HOST/nested/delete.txt" ];[ ! -e "$HOST/nested/old-name.txt" ];[ "$(cat "$HOST/nested/new-name.txt")" = move ];grep -q approved-transactional-candidate-application "$RECEIPT"
expect_fail bare-hash-forbidden node "$SCRIPT_DIR/apply-candidate-patch.mjs" --root "$HOST" --patch "$BUNDLE" --approval-sha256 "$(sha "$BUNDLE")" --receipt "$TMP/no.json"
BAD_APPROVAL="$TMP/bad-approval.json";node - "$APPROVAL" "$BAD_APPROVAL" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.decision='rejected';fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
HOST_BAD="$TMP/host-bad";cp -R "$BASE" "$HOST_BAD";expect_fail fabricated-approval node "$SCRIPT_DIR/apply-candidate-patch.mjs" --root "$HOST_BAD" --plan "$PLAN" --candidate-validation "$CVALID" --bundle "$BUNDLE" --review-patch "$REVIEW" --patch-review "$PATCH_REVIEW" --approval "$BAD_APPROVAL" --receipt "$TMP/no-approval-receipt";[ "$(cat "$HOST_BAD/nested/modify.txt")" = old ]
PREEXIST="$TMP/preexisting-receipt";printf occupied >"$PREEXIST";expect_fail receipt-precheck node "$SCRIPT_DIR/apply-candidate-patch.mjs" --root "$HOST_BAD" --plan "$PLAN" --candidate-validation "$CVALID" --bundle "$BUNDLE" --review-patch "$REVIEW" --patch-review "$PATCH_REVIEW" --approval "$APPROVAL" --receipt "$PREEXIST";[ "$(cat "$HOST_BAD/nested/modify.txt")" = old ]
OUTSIDE="$TMP/outside";mkdir "$OUTSIDE";cp -R "$BASE/nested/." "$OUTSIDE/";HOST_LINK="$TMP/host-link";mkdir "$HOST_LINK";ln -s "$OUTSIDE" "$HOST_LINK/nested";expect_fail parent-symlink-apply node "$SCRIPT_DIR/apply-candidate-patch.mjs" --root "$HOST_LINK" --plan "$PLAN" --candidate-validation "$CVALID" --bundle "$BUNDLE" --review-patch "$REVIEW" --patch-review "$PATCH_REVIEW" --approval "$APPROVAL" --receipt "$TMP/link-receipt";grep -q 'non-symlink directory' "$TMP/parent-symlink-apply.err";[ "$(cat "$OUTSIDE/modify.txt")" = old ]
BASE_LINK="$TMP/base-link";mkdir "$BASE_LINK";ln -s "$BASE/nested" "$BASE_LINK/nested";printf absent >"$BASE_LINK/dummy";expect_fail parent-symlink-generate node "$SCRIPT_DIR/generate-candidate-patch.mjs" --baseline "$BASE_LINK" --candidate "$CAND" --plan "$PLAN" --candidate-validation "$CVALID" --out "$TMP/link-bundle" --review-out "$TMP/link-review";grep -q 'non-symlink directory' "$TMP/parent-symlink-generate.err"

LEDGER="$TMP/ledger.json";A=$(printf 'a%.0s' $(seq 1 64));B=$(printf 'b%.0s' $(seq 1 64));C=$(printf 'c%.0s' $(seq 1 64))
R1=$(node "$SCRIPT_DIR/attempt-ledger.mjs" reserve --ledger "$LEDGER" --workflow-id wf --role-key quality --operation-id old-id --binding-sha256 "$A");ID1=$(printf %s "$R1"|node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).attemptId))');node "$SCRIPT_DIR/attempt-ledger.mjs" finalize --ledger "$LEDGER" --workflow-id wf --role-key quality --operation-id old-id --attempt-id "$ID1" --status failed --elapsed-ms 1 >/dev/null
R2=$(node "$SCRIPT_DIR/attempt-ledger.mjs" reserve --ledger "$LEDGER" --workflow-id wf --role-key quality --operation-id renamed-id --binding-sha256 "$B" --failure-classification candidate);ID2=$(printf %s "$R2"|node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).attemptId))');node "$SCRIPT_DIR/attempt-ledger.mjs" finalize --ledger "$LEDGER" --workflow-id wf --role-key quality --operation-id renamed-id --attempt-id "$ID2" --status failed --elapsed-ms 1 >/dev/null
expect_fail role-rename-bypass node "$SCRIPT_DIR/attempt-ledger.mjs" reserve --ledger "$LEDGER" --workflow-id wf --role-key quality --operation-id third-id --binding-sha256 "$C" --failure-classification candidate;grep -q 'retry budget exhausted' "$TMP/role-rename-bypass.err"

REPORT="$TMP/report.json";node "$SCRIPT_DIR/aggregate-workflow-report.mjs" --plan "$PLAN" --candidate-validation "$CVALID" --application-receipt "$RECEIPT" --approval "$APPROVAL" --out "$REPORT" >/dev/null
node - "$REPORT" <<'NODE'
const r=require(process.argv[2]);if(r.candidate.status!=='passed'||r.hostApplication.status!=='passed'||r.container.status!=='not-required')process.exit(1);
NODE
MIXED="$TMP/mixed-candidate.json";node - "$CVALID" "$MIXED" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.mutations[0].afterSha256='f'.repeat(64);fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail mixed-candidate-application node "$SCRIPT_DIR/aggregate-workflow-report.mjs" --plan "$PLAN" --candidate-validation "$MIXED" --application-receipt "$RECEIPT" --approval "$APPROVAL" --out "$TMP/mixed-report"

STRONG="$TMP/strong.json";SOURCE="$TMP/source";EVID="$TMP/evidence";ART="$TMP/artifacts";mkdir "$SOURCE" "$EVID" "$ART";SOURCE_SHA=$(node "$SCRIPT_DIR/strong-operation-contract.mjs" hash-tree --root "$SOURCE"|node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).sourceTreeSha256))')
node - "$PLAN" "$STRONG" "$SOURCE_SHA" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.profile='standard';p.workspace.mode='read-only';p.candidateStage={name:'read',mutationIds:[],promotable:false};p.candidateExports=[];p.operations=[{id:'quality',roleKey:'quality',kind:'test',command:'quality',image:'node@sha256:'+'1'.repeat(64),scriptSha256:'2'.repeat(64),sourceTreeSha256:process.argv[4],path:['/usr/bin','/bin'],requiredTools:['sh'],resources:{cpus:1,memory:'256M'},network:'disabled',timeoutMs:1000,oracles:['zero exit'],outputs:[{kind:'evidence',path:'quality.log'}]}];p.escalation={required:true,target:'container',reason:'test'};fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
# Phase-D workload/phase/network gates and optional risk binding preserve legacy contract bytes.
node - "$SCRIPT_DIR/validate-execution-plan.mjs" "$SCRIPT_DIR/strong-operation-contract.mjs" "$STRONG" <<'NODE'
Promise.all([import(process.argv[2]),import(process.argv[3])]).then(([validator,contracts])=>{const fs=require('fs'),legacy=JSON.parse(fs.readFileSync(process.argv[4])),clone=()=>structuredClone(legacy),assert=(ok,message)=>{if(!ok)throw new Error(message)},intake=(workload='backend-api',mode='none')=>({schemaVersion:1,phase:'deliver',workloadProfile:workload,interfaceMode:mode,repository:{trust:'trusted-reviewed',codeOrigin:'first-party'},requirements:{privilege:'none',processLifetime:'bounded-foreground',hostSockets:[],credentials:'none',network:'none'}}),valid=p=>validator.validatePlan(p);const assessed=clone();assessed.intake=intake();let r=valid(assessed);assert(!r.errors.length&&!r.blocked,'backend delivery baseline must pass');const legacyContract=contracts.operationContract(legacy,'quality'),assessedContract=contracts.operationContract(assessed,'quality');assert(!('riskDecision' in legacyContract.contract)&&!('riskDecisionSha256' in legacyContract.contract),'no-intake contract bytes changed');assert('riskDecision' in assessedContract.contract&&'riskDecisionSha256' in assessedContract.contract&&legacyContract.operationContractSha256!==assessedContract.operationContractSha256,'intake risk binding missing');const changed=structuredClone(assessed);changed.intake.repository.codeOrigin='generated-reviewed';const changedContract=contracts.operationContract(changed,'quality');assert(changedContract.operationContractSha256!==assessedContract.operationContractSha256,'intake change did not invalidate contract');const noNet=structuredClone(assessed);noNet.operations[0].network='registry';assert(valid(noNet).errors.some(e=>e.includes('network none')),'network none accepted registry strong operation');const registry=structuredClone(assessed);registry.intake.requirements.network='package-registry';registry.operations.push({...registry.operations[0],id:'install',roleKey:'install',kind:'package-install',network:'registry'});assert(!valid(registry).errors.length,'package registry consistency rejected');const nonInstallRegistry=structuredClone(assessed);nonInstallRegistry.intake.requirements.network='package-registry';nonInstallRegistry.operations[0].network='registry';assert(valid(nonInstallRegistry).errors.some(e=>e.includes('only for package-install')),'registry on non-package-install accepted');const missingRegistry=structuredClone(assessed);missingRegistry.intake.requirements.network='package-registry';assert(valid(missingRegistry).errors.some(e=>e.includes('package-install registry')),'package registry without registry operation accepted');const inspected=structuredClone(assessed);inspected.intake.phase='inspect';assert(valid(inspected).errors.some(e=>e.includes('does not allow strong')),'inspect strong operation accepted');const cli=structuredClone(assessed);cli.intake=intake('cli-tui','cli');assert(!valid(cli).errors.length,'CLI test gate rejected');const tui=structuredClone(assessed);tui.intake=intake('cli-tui','tui');tui.delivery.hostRuntime={required:true,commands:['run tui']};tui.delivery.interactive={required:true,runner:'host',command:'run tui',terminalType:'xterm-256color',rows:24,columns:80,oracles:['screen visible']};assert(!valid(tui).errors.length,'exact host TUI gate rejected');const badTui=structuredClone(assessed);badTui.intake=intake('cli-tui','tui');assert(valid(badTui).errors.some(e=>e.includes('tui delivery')),'TUI without host interactive accepted');const library=structuredClone(assessed);library.intake=intake('library');assert(!valid(library).errors.length,'library test gate rejected');const infrastructure=structuredClone(assessed);infrastructure.intake=intake('infrastructure');infrastructure.changeSet.expectedReviewRequired=true;assert(!valid(infrastructure).errors.length,'infrastructure offline gate rejected');const badInfrastructure=structuredClone(infrastructure);badInfrastructure.operations.push({...badInfrastructure.operations[0],id:'install',roleKey:'install',kind:'package-install',network:'registry'});badInfrastructure.intake.requirements.network='package-registry';assert(valid(badInfrastructure).errors.some(e=>e.includes('must be offline')),'online infrastructure accepted');const research=structuredClone(assessed);research.intake=intake('research');assert(!valid(research).errors.length,'research test gate rejected');const noBackendTest=structuredClone(assessed);noBackendTest.operations[0].kind='build';assert(valid(noBackendTest).errors.some(e=>e.includes('backend-api delivery requires')),'backend without test accepted');const web=structuredClone(assessed);web.intake=intake('web-ui');const base=web.operations[0],viewports=[{id:'desktop',width:1280,height:800,mobile:false,pointer:'fine'},{id:'phone-portrait',width:390,height:844,mobile:true,pointer:'coarse'},{id:'phone-landscape',width:844,height:390,mobile:true,pointer:'coarse'},{id:'tablet-portrait',width:768,height:1024,mobile:true,pointer:'coarse'},{id:'tablet-landscape',width:1024,height:768,mobile:true,pointer:'coarse'}],outputs=[{kind:'evidence',path:'browser.log'},...viewports.map(v=>({kind:'artifact',path:`${v.id}.png`,viewportId:v.id}))];web.operations=[{...base,id:'browser-preflight',roleKey:'browser-preflight',kind:'browser-preflight',runner:'chromium',viewports,outputs},{...base,id:'browser-smoke',roleKey:'browser-smoke',kind:'browser-smoke',runner:'chromium',viewports,outputs,preflightOperationId:'browser-preflight'}];assert(!valid(web).errors.length,'web UI browser pair rejected');const noPair=structuredClone(assessed);noPair.intake=intake('web-ui');assert(valid(noPair).errors.some(e=>e.includes('browser-preflight and browser-smoke')),'web UI without browser pair accepted');const webChange=structuredClone(web);webChange.intake.phase='change';webChange.candidateStage.promotable=false;assert(!valid(webChange).errors.length,'web change candidate inspection rejected');webChange.candidateStage.promotable=true;assert(valid(webChange).errors.some(e=>e.includes('promotion is delivery')),'web change promotion bypass accepted');const badCli=structuredClone(assessed);badCli.intake=intake('cli-tui','cli');badCli.operations[0].kind='build';assert(valid(badCli).errors.some(e=>e.includes('cli delivery')),'CLI workload negative accepted');const badLibrary=structuredClone(assessed);badLibrary.intake=intake('library');badLibrary.operations[0].kind='native-exec';assert(valid(badLibrary).errors.some(e=>e.includes('library delivery')),'library workload negative accepted');const badReview=structuredClone(assessed);badReview.intake=intake('infrastructure');assert(valid(badReview).errors.some(e=>e.includes('expectedReviewRequired')),'infrastructure review negative accepted');const badResearch=structuredClone(assessed);badResearch.intake=intake('research');badResearch.operations[0].kind='repository-script';assert(valid(badResearch).errors.some(e=>e.includes('research delivery')),'research workload negative accepted');for(const phase of ['change','validate']){const p=structuredClone(assessed);p.intake.phase=phase;p.candidateStage.promotable=false;p.delivery.hostRuntime={required:true,commands:['run reviewed host check']};assert(valid(p).errors.some(e=>e.includes('disallows')),'non-deliver host delivery accepted: '+phase)}for(const [command,expectedHostReasons] of [['sudo true',['host-command:privilege-tool']],['doas true',['host-command:privilege-tool']],['/usr/bin/sudo true',['host-command:privilege-tool']],['command /usr/bin/doas true',['host-command:privilege-tool']],['docker run x',['host-command:container-runtime']],['/usr/local/bin/docker run x',['host-command:container-runtime']],['podman run --privileged x',['host-command:container-runtime','host-command:privileged-container']],['tool --privileged',['host-command:privileged-container']],['tool -v /:/host',['host-command:host-root-mount']],['tool -v/:/host',['host-command:host-root-mount']],['tool --mount type=bind,source="/",target=/host',['host-command:host-root-mount']],['tool /var/run/docker.sock',['host-command:docker-socket']],['kubectl get pods',['host-command:cluster-control']],['/opt/bin/kubectl get pods',['host-command:cluster-control']],['terraform apply plan',['host-command:terraform-apply']],['/usr/bin/terraform apply',['host-command:terraform-apply']],['AWS_ACCESS_KEY_ID=x tool',['host-command:cloud-credential-env']],['systemctl start x',['host-command:daemon-manager']],['/bin/systemctl start x',['host-command:daemon-manager']],['/opt/homebrew/bin/brew services start x',['host-command:daemon-manager']]]){const p=structuredClone(assessed);p.delivery.hostRuntime={required:true,commands:[command]};p.escalation={required:true,target:'external-microvm',reason:'host contradiction'};const out=valid(p),actualHostReasons=out.riskDecision?.reasons.filter(reason=>reason.startsWith('host-command:'));assert(!out.errors.length&&out.blocked&&out.riskDecision.effectiveProfile==='high-risk'&&out.riskDecision.route==='external-microvm'&&JSON.stringify(actualHostReasons)===JSON.stringify(expectedHostReasons),`host command risk signal failed: ${command}: ${JSON.stringify(out)}`)}const reviewed=structuredClone(assessed);reviewed.delivery.hostRuntime={required:true,commands:['/opt/app/bin/tetris']};const reviewedOut=valid(reviewed),reviewedHostReasons=reviewedOut.riskDecision?.reasons.filter(reason=>reason.startsWith('host-command:'));assert(!reviewedOut.errors.length&&!reviewedOut.blocked&&reviewedOut.riskDecision.route==='container'&&reviewedHostReasons.length===0,'reviewed path-qualified TUI command was incorrectly blocked');});
NODE
BLOCKED_STRONG="$TMP/blocked-strong.json";node - "$STRONG" "$BLOCKED_STRONG" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.intake={schemaVersion:1,phase:'validate',workloadProfile:'research',interfaceMode:'none',repository:{trust:'unknown',codeOrigin:'first-party'},requirements:{privilege:'none',processLifetime:'bounded-foreground',hostSockets:[],credentials:'none',network:'none'}};p.escalation={required:true,target:'external-microvm',reason:'blocked risk intake'};fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
BLOCKED_E="$TMP/blocked-strong-evidence";mkdir "$BLOCKED_E";expect_fail blocked-before-runtime "$SCRIPT_DIR/run-strong-operation-apple-container.sh" --source "$SOURCE" --script "$TIER" --plan "$BLOCKED_STRONG" --operation-id quality --evidence-out "$BLOCKED_E" --attempt-ledger "$TMP/blocked-strong-ledger";grep -q 'effective risk route is blocked' "$TMP/blocked-before-runtime.err";[ ! -e "$TMP/blocked-strong-ledger" ];[ -z "$(find "$BLOCKED_E" -mindepth 1 -print -quit)" ]
# Every plan-consuming boundary fails closed on blocked decisions before execution, promotion, reuse, report success, runtime probes, or host writes.
expect_fail blocked-tier-runner env JUST_BASH_PACKAGE_ROOT="$TMP/missing-package" JUST_BASH_ROOT="$SOURCE" JUST_BASH_PLAN="$BLOCKED_STRONG" node "$SCRIPT_DIR/just-bash-runner.mjs" <"$TIER";grep -q 'Tier-A execution is forbidden' "$TMP/blocked-tier-runner.err"
expect_fail blocked-tier-host "$SCRIPT_DIR/run-just-bash-apple-container.sh" --root "$SOURCE" --script "$TIER" --plan "$BLOCKED_STRONG" --runtime-dir "$TMP/definitely-missing-runtime";grep -q 'task is blocked' "$TMP/blocked-tier-host.err";! grep -q 'runtime is missing' "$TMP/blocked-tier-host.err"
expect_fail blocked-candidate node "$SCRIPT_DIR/validate-candidate-tree.mjs" --root "$SOURCE" --baseline "$SOURCE" --plan "$BLOCKED_STRONG";grep -q 'cannot produce a passing' "$TMP/blocked-candidate.err";! grep -q CANDIDATE_PASS "$TMP/blocked-candidate.out"
expect_fail blocked-bundle node "$SCRIPT_DIR/generate-candidate-patch.mjs" --baseline "$BASE" --candidate "$CAND" --plan "$BLOCKED_STRONG" --candidate-validation "$CVALID" --out "$TMP/blocked-bundle.json" --review-out "$TMP/blocked-review.patch";grep -q 'rejects blocked risk decision' "$TMP/blocked-bundle.err";[ ! -e "$TMP/blocked-bundle.json" ];[ ! -e "$TMP/blocked-review.patch" ]
BLOCKED_HOST="$TMP/blocked-host";cp -R "$BASE" "$BLOCKED_HOST";expect_fail blocked-apply node "$SCRIPT_DIR/apply-candidate-patch.mjs" --root "$BLOCKED_HOST" --plan "$BLOCKED_STRONG" --candidate-validation "$CVALID" --bundle "$BUNDLE" --review-patch "$REVIEW" --patch-review "$PATCH_REVIEW" --approval "$APPROVAL" --receipt "$TMP/blocked-application-receipt";grep -q 'rejects blocked risk decision' "$TMP/blocked-apply.err";[ "$(cat "$BLOCKED_HOST/nested/modify.txt")" = old ];[ ! -e "$TMP/blocked-application-receipt" ]
expect_fail blocked-evidence node "$SCRIPT_DIR/validate-operation-evidence.mjs" --plan "$BLOCKED_STRONG" --operation-id quality --source "$SOURCE" --evidence "$EVID";grep -q 'rejects blocked risk decision' "$TMP/blocked-evidence.err";! grep -q EVIDENCE_REUSABLE "$TMP/blocked-evidence.out"
expect_fail blocked-aggregate node "$SCRIPT_DIR/aggregate-workflow-report.mjs" --plan "$BLOCKED_STRONG" --out "$TMP/blocked-workflow-report";grep -q 'rejects blocked risk decision' "$TMP/blocked-aggregate.err";[ ! -e "$TMP/blocked-workflow-report" ]
expect_fail blocked-handoff node "$SCRIPT_DIR/validate-artifact-handoff.mjs" validate --plan "$BLOCKED_STRONG" --operation-id quality --producer-handoff "$TMP/missing-handoff";grep -q 'rejects blocked risk decision' "$TMP/blocked-handoff.err"
expect_fail blocked-gate node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$BLOCKED_STRONG" --gate-plan "$TMP/missing-gate-plan" --ledger "$TMP/missing-gate-ledger" --gate-input "$TMP/missing-gate-input" --out "$TMP/blocked-gate-report";grep -q 'rejects blocked risk decision' "$TMP/blocked-gate.err";[ ! -e "$TMP/blocked-gate-report" ]
node - "$SCRIPT_DIR/artifact-handoff-contract.mjs" "$BLOCKED_STRONG" <<'NODE'
import(process.argv[2]).then(m=>{const p=require(process.argv[3]);try{m.resolveArtifactHandoff({planPath:process.argv[3],plan:p,consumer:p.operations[0],handoffPath:'/missing'});process.exit(1)}catch(e){if(!/rejects blocked risk decision/.test(e.message))throw e}});
NODE
printf ok >"$EVID/quality.log";PLAN_SHA=$(sha "$STRONG");CONTRACT_SHA=$(node "$SCRIPT_DIR/strong-operation-contract.mjs" contract --plan "$STRONG" --operation-id quality|node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).operationContractSha256))');[ "$CONTRACT_SHA" = d88e93347d5576c671f8fb99bc067bb62a80d7360e515dcd4eeb841b3a286a37 ]
node - "$EVID" "$PLAN_SHA" "$CONTRACT_SHA" "$SOURCE_SHA" <<'NODE'
const fs=require('fs'),crypto=require('crypto'),dir=process.argv[2],plan=process.argv[3],contract=process.argv[4],source=process.argv[5],hash=b=>crypto.createHash('sha256').update(b).digest('hex');const status={schemaVersion:2,status:'succeeded',exitCode:0,authority:'host',provenance:'container-exit-attestation',operationId:'quality',workflowId:'self-test',roleKey:'quality',planSha256:plan,operationContractSchemaVersion:2,operationContractSha256:contract,sourceTreeSha256:source,preflightEvidenceSha256:'0'.repeat(64),scriptSha256:'2'.repeat(64),image:'node@sha256:'+'1'.repeat(64),network:'disabled'},sb=Buffer.from(JSON.stringify(status)+'\n');fs.writeFileSync(dir+'/operation-status.json',sb);const out=fs.readFileSync(dir+'/quality.log');fs.writeFileSync(dir+'/operation-receipt.json',JSON.stringify({schemaVersion:2,authority:'host',provenance:'post-execution-output-validation',operationId:'quality',workflowId:'self-test',roleKey:'quality',historicalPlanSha256:plan,operationContractSchemaVersion:2,operationContractSha256:contract,sourceTreeSha256:source,statusSha256:hash(sb),startedAtUtc:'2026-01-01T00:00:00.000Z',endedAtUtc:'2026-01-01T00:00:00.007Z',elapsedMs:7,resources:{cpus:1,memory:'256M'},outputs:[{kind:'evidence',path:'quality.log',sizeBytes:out.length,sha256:hash(out)}]})+'\n');
NODE
INTAKE_STRONG="$TMP/intake-strong.json";node - "$STRONG" "$INTAKE_STRONG" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.intake={schemaVersion:1,phase:'deliver',workloadProfile:'backend-api',interfaceMode:'none',repository:{trust:'trusted-reviewed',codeOrigin:'first-party'},requirements:{privilege:'none',processLifetime:'bounded-foreground',hostSockets:[],credentials:'none',network:'none'}};fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
expect_fail intake-stale-evidence node "$SCRIPT_DIR/validate-operation-evidence.mjs" --plan "$INTAKE_STRONG" --operation-id quality --source "$SOURCE" --evidence "$EVID";grep -Eq 'contract|binding mismatch' "$TMP/intake-stale-evidence.err"
ROLE_INPUT="$TMP/role-input.json";node - "$ROLE_INPUT" "$SOURCE" "$EVID" "$ART" <<'NODE'
const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({operationId:'quality',source:process.argv[3],evidence:process.argv[4],artifact:process.argv[5],preflightSource:null,preflightEvidence:null,preflightArtifact:null}));
NODE
STATUS_ONLY="$TMP/status-only";mkdir "$STATUS_ONLY";cp "$EVID/operation-status.json" "$STATUS_ONLY/";STATUS_INPUT="$TMP/status-input.json";node - "$STATUS_INPUT" "$SOURCE" "$STATUS_ONLY" "$ART" <<'NODE'
const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({operationId:'quality',source:process.argv[3],evidence:process.argv[4],artifact:process.argv[5],preflightSource:null,preflightEvidence:null,preflightArtifact:null}));
NODE
expect_fail fabricated-status-only node "$SCRIPT_DIR/aggregate-workflow-report.mjs" --plan "$STRONG" --ledger "$TMP/missing-ledger" --role-input "$STATUS_INPUT" --out "$TMP/status-report";grep -q 'strong evidence validation failed' "$TMP/fabricated-status-only.err"
CONTRADICT="$TMP/contradict-ledger.json";cat >"$CONTRADICT" <<JSON
{"schemaVersion":2,"attempts":[{"attemptId":"attempt","workflowId":"self-test","roleKey":"quality","operationId":"quality","bindingSha256":"$A","failureClassification":"initial","attemptNumber":1,"status":"passed","startedAtUtc":"2026-01-01T00:00:00.000Z","endedAtUtc":"2026-01-01T00:00:00.008Z","elapsedMs":8}]}
JSON
expect_fail ledger-contradiction node "$SCRIPT_DIR/aggregate-workflow-report.mjs" --plan "$STRONG" --ledger "$CONTRADICT" --role-input "$ROLE_INPUT" --out "$TMP/contradict-report";grep -q 'contradiction' "$TMP/ledger-contradiction.err"
HOST_PLAN="$TMP/host-plan.json";node - "$PLAN" "$HOST_PLAN" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.workflowId='host-receipt';p.delivery.hostRuntime={required:true,commands:['npm test']};fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
FAKE_HOST_RECEIPT="$TMP/fake-host-receipt.json";cat >"$FAKE_HOST_RECEIPT" <<'JSON'
{"schemaVersion":1,"status":"passed","authority":"host","provenance":"declared-host-runtime-validation","workflowId":"host-receipt"}
JSON
expect_fail fabricated-host-runtime-receipt node "$SCRIPT_DIR/aggregate-workflow-report.mjs" --plan "$HOST_PLAN" --host-runtime-receipt "$FAKE_HOST_RECEIPT" --out "$TMP/fake-host-report";grep -q 'schema fields are not exact' "$TMP/fabricated-host-runtime-receipt.err"
SINGLE_BROWSER="$TMP/single-browser.json";node - "$STRONG" "$SINGLE_BROWSER" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]),base=p.operations[0],viewports=[{id:'desktop',width:1280,height:800,mobile:false,pointer:'fine'}],outputs=[{kind:'evidence',path:'browser.log'},{kind:'artifact',path:'desktop.png',viewportId:'desktop'}];p.operations=[{...base,id:'preflight',roleKey:'browser-preflight',kind:'browser-preflight',runner:'chromium',viewports,outputs},{...base,id:'smoke',roleKey:'browser-smoke',kind:'browser-smoke',runner:'chromium',viewports,outputs,preflightOperationId:'preflight'}];fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
expect_fail incomplete-browser-matrix node "$SCRIPT_DIR/validate-execution-plan.mjs" "$SINGLE_BROWSER";grep -q 'requires the standard viewport: phone-landscape' "$TMP/incomplete-browser-matrix.err"

# Phase-E split browser roles isolate interaction and each viewport while legacy combined plans remain valid.
SPLIT_BROWSER="$TMP/split-browser.json";node - "$STRONG" "$SPLIT_BROWSER" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]),base=p.operations[0],viewports=[{id:'desktop',width:1280,height:800,mobile:false,pointer:'fine'},{id:'phone-portrait',width:390,height:844,mobile:true,pointer:'coarse'},{id:'phone-landscape',width:844,height:390,mobile:true,pointer:'coarse'},{id:'tablet-portrait',width:768,height:1024,mobile:true,pointer:'coarse'},{id:'tablet-landscape',width:1024,height:768,mobile:true,pointer:'coarse'}],outputs=v=>[{kind:'evidence',path:'browser.log'},{kind:'artifact',path:`${v.id}.png`,viewportId:v.id}],common={...base,kind:'browser-smoke',runner:'chromium',preflightOperationId:'browser-preflight'};p.operations=[{...base,id:'browser-preflight',roleKey:'browser-preflight',kind:'browser-preflight',runner:'chromium',viewports:[viewports[0]],outputs:outputs(viewports[0])},{...common,id:'browser-interaction',roleKey:'browser-interaction',browserRole:'interaction',viewports:[viewports[0]],outputs:outputs(viewports[0])},...viewports.map(v=>({...common,id:`browser-viewport-${v.id}`,roleKey:`browser-viewport.${v.id}`,browserRole:'viewport-validation',viewports:[v],outputs:outputs(v)}))];fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
node "$SCRIPT_DIR/validate-execution-plan.mjs" "$SPLIT_BROWSER" >/dev/null
node - "$SCRIPT_DIR/strong-operation-contract.mjs" "$SPLIT_BROWSER" <<'NODE'
import(process.argv[2]).then(({operationContract})=>{const p=require(process.argv[3]),split=operationContract(p,'browser-interaction');if(split.contract.browserRole!=='interaction')throw new Error('split browserRole is not contract-bound');const legacy=structuredClone(p);delete legacy.operations[1].browserRole;const noField=operationContract(legacy,'browser-interaction');if('browserRole' in noField.contract||split.operationContractSha256===noField.operationContractSha256)throw new Error('legacy omission or split hash binding failed')});
NODE
for mutation in missing-interaction missing-viewport duplicate-viewport multi-viewport wrong-role mixed-mode different-preflight source-drift;do BAD_SPLIT="$TMP/$mutation.json";node - "$SPLIT_BROWSER" "$BAD_SPLIT" "$mutation" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]),kind=process.argv[4],smokes=()=>p.operations.filter(v=>v.kind==='browser-smoke');if(kind==='missing-interaction')p.operations=p.operations.filter(v=>v.browserRole!=='interaction');if(kind==='missing-viewport')p.operations=p.operations.filter(v=>v.roleKey!=='browser-viewport.tablet-landscape');if(kind==='duplicate-viewport'){const op=p.operations.find(v=>v.roleKey==='browser-viewport.tablet-landscape');op.viewports=[structuredClone(p.operations.find(v=>v.roleKey==='browser-viewport.desktop').viewports[0])];op.outputs=[{kind:'evidence',path:'browser.log'},{kind:'artifact',path:'desktop.png',viewportId:'desktop'}];op.roleKey='browser-viewport.desktop-duplicate'}if(kind==='multi-viewport')p.operations.find(v=>v.browserRole==='interaction').viewports.push(structuredClone(p.operations.find(v=>v.roleKey==='browser-viewport.phone-portrait').viewports[0]));if(kind==='wrong-role')p.operations.find(v=>v.roleKey==='browser-viewport.phone-portrait').roleKey='renamed-viewport';if(kind==='mixed-mode'){const legacy=structuredClone(p.operations.find(v=>v.browserRole==='interaction'));delete legacy.browserRole;legacy.id='legacy-browser-smoke';legacy.roleKey='legacy-browser-smoke';legacy.viewports=smokes().filter(v=>v.browserRole==='viewport-validation').map(v=>structuredClone(v.viewports[0]));legacy.outputs=[{kind:'evidence',path:'browser.log'},...legacy.viewports.map(v=>({kind:'artifact',path:`legacy-${v.id}.png`,viewportId:v.id}))];p.operations.push(legacy)}if(kind==='different-preflight'){const second=structuredClone(p.operations.find(v=>v.kind==='browser-preflight'));second.id='browser-preflight-second';second.roleKey='browser-preflight-second';p.operations.push(second);p.operations.find(v=>v.roleKey==='browser-viewport.desktop').preflightOperationId=second.id}if(kind==='source-drift')p.operations.find(v=>v.roleKey==='browser-viewport.desktop').sourceTreeSha256='f'.repeat(64);fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
  expect_fail "split-$mutation" node "$SCRIPT_DIR/validate-execution-plan.mjs" "$BAD_SPLIT"
done
node - "$SCRIPT_DIR/strong-operation-status.mjs" "$SCRIPT_DIR/strong-operation-controller.mjs" "$SPLIT_BROWSER" "$TMP/split-contract" <<'NODE'
Promise.all([import(process.argv[2]),import(process.argv[3])]).then(([status,controller])=>{const fs=require('fs'),path=require('path'),root=process.argv[5];fs.mkdirSync(root);const m=status.prepareContract({planPath:process.argv[4],operationId:'browser-viewport-phone-portrait',contractPath:path.join(root,'contract'),metadataDirectory:path.join(root,'metadata'),toolsPath:path.join(root,'tools'),pathPath:path.join(root,'path'),outputsPath:path.join(root,'outputs')});controller.assertBrowserSplitMetadata(m);for(const bad of [{...m,viewportIds:['desktop','phone-portrait']},{...m,roleKey:'wrong'},{...m,browserRole:'typo-role'}]){let failed=false;try{controller.assertBrowserSplitMetadata(bad)}catch{failed=true}if(!failed)throw new Error('controller accepted invalid split browser metadata')}});
NODE

RUNTIME="$TMP/runtime";mkdir -p "$RUNTIME/node_modules/just-bash/dist/bundle";cat >"$RUNTIME/node_modules/just-bash/package.json" <<'JSON'
{"type":"module"}
JSON
cat >"$RUNTIME/node_modules/just-bash/dist/bundle/index.js" <<'JS'
import {readFile} from 'node:fs/promises';import{resolve}from'node:path';export class OverlayFs{constructor({root}){this.root=root;this.generated=new Map()}getMountPoint(){return this.root}resolvePath(_cwd,p){return p}async readFileBuffer(p){return this.generated.get(p)??readFile(resolve(this.root,p))}}export class InMemoryFs{}export class Bash{constructor({fs}){this.fs=fs}async exec(script){if(script.includes('mv old.txt new.txt'))this.fs.generated.set('new.txt',await readFile(resolve(this.fs.root,'old.txt')));return{exitCode:0,stdout:'TASK_COMPLETE\n'}}}
JS
DELROOT="$TMP/delete-root";mkdir "$DELROOT";printf gone >"$DELROOT/gone.txt";DELSCRIPT="$TMP/delete.sh";printf 'set -e\nprintf TASK_COMPLETE\\n\nrm gone.txt\n' >"$DELSCRIPT";DELPLAN="$TMP/delete-plan.json";node - "$PLAN" "$DELPLAN" "$(sha "$DELSCRIPT")" "$(sha "$DELROOT/gone.txt")" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.workflowId='delete-only';p.tierA.scriptSha256=process.argv[4];p.changeSet.mutations=[{id:'delete',type:'delete',path:'gone.txt',beforeSha256:process.argv[5]}];p.candidateStage={name:'delete',mutationIds:['delete'],promotable:true};p.candidateExports=[];p.operations=[{kind:'read',command:'delete post-image has no export',output:'stdout'}];fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
env JUST_BASH_PACKAGE_ROOT="$RUNTIME" JUST_BASH_ROOT="$DELROOT" JUST_BASH_PLAN="$DELPLAN" node "$SCRIPT_DIR/just-bash-runner.mjs" <"$DELSCRIPT"|grep -q TASK_COMPLETE
EMPTY_CAND="$TMP/delete-candidate";mkdir "$EMPTY_CAND";node "$SCRIPT_DIR/validate-candidate-tree.mjs" --root "$EMPTY_CAND" --baseline "$DELROOT" --plan "$DELPLAN"|grep -q CANDIDATE_PASS
RENROOT="$TMP/rename-root";RENOUT="$TMP/rename-out";mkdir "$RENROOT" "$RENOUT";printf moved >"$RENROOT/old.txt";RENSCRIPT="$TMP/rename.sh";printf 'set -e\nprintf TASK_COMPLETE\\n\nmv old.txt new.txt\n' >"$RENSCRIPT";RENPLAN="$TMP/rename-plan.json";node - "$PLAN" "$RENPLAN" "$(sha "$RENSCRIPT")" "$(sha "$RENROOT/old.txt")" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.workflowId='rename-export';p.tierA.scriptSha256=process.argv[4];p.changeSet.mutations=[{id:'rename',type:'rename',from:'old.txt',to:'new.txt',beforeSha256:process.argv[5]}];p.candidateStage={name:'rename',mutationIds:['rename'],promotable:true};p.candidateExports=['new.txt'];p.operations=[{kind:'text-edit',command:'rename file',output:'new.txt'}];fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
env JUST_BASH_PACKAGE_ROOT="$RUNTIME" JUST_BASH_ROOT="$RENROOT" JUST_BASH_PLAN="$RENPLAN" JUST_BASH_CANDIDATE_OUT="$RENOUT" node "$SCRIPT_DIR/just-bash-runner.mjs" <"$RENSCRIPT"|grep -q TASK_COMPLETE;[ "$(cat "$RENOUT/new.txt")" = moved ]

# Node-controller refactor: exact status bytes and commit-boundary ordering.
node - "$SCRIPT_DIR/strong-operation-status.mjs" "$PLAN_SHA" "$CONTRACT_SHA" "$SOURCE_SHA" "$TMP/status-v2.json" <<'NODE'
import(process.argv[2]).then(m=>{const [plan,contract,source,out]=process.argv.slice(3),z='0'.repeat(64),one='1'.repeat(64),two='2'.repeat(64);m.writeOperationStatus(out,{kind:'attestation',exitCode:0,operationId:'quality',workflowId:'self-test',roleKey:'quality',planSha256:plan,operationContractSha256:contract,sourceTreeSha256:source,preflightEvidenceSha256:z,scriptSha256:two,image:`node@sha256:${one}`,network:'disabled'});});
NODE
node - "$TMP/status-v2.json" "$PLAN_SHA" "$CONTRACT_SHA" "$SOURCE_SHA" <<'NODE'
const fs=require('fs'),[file,plan,contract,source]=process.argv.slice(2),z='0'.repeat(64),one='1'.repeat(64),two='2'.repeat(64),expected={schemaVersion:2,status:'succeeded',exitCode:0,authority:'host',provenance:'container-exit-attestation',operationId:'quality',workflowId:'self-test',roleKey:'quality',planSha256:plan,operationContractSchemaVersion:2,operationContractSha256:contract,sourceTreeSha256:source,preflightEvidenceSha256:z,scriptSha256:two,image:`node@sha256:${one}`,network:'disabled'};if(fs.readFileSync(file,'utf8')!==JSON.stringify(expected)+'\n')process.exit(1);
NODE
node - "$SCRIPT_DIR/strong-operation-controller.mjs" <<'NODE'
import(process.argv[2]).then(async({commitResult})=>{for(const verifiedFailure of [false,true])for(const point of ['afterArtifactPublish','afterEvidencePublish','beforeFinalizer','afterFinalizer']){const state={committing:false,pendingSignal:null,committed:false},events=[],hooks={[point]:(s)=>{s.pendingSignal=143;events.push(point)}};const result=await commitResult({state,verifiedFailure,publishArtifact:()=>events.push('artifact'),publishEvidence:()=>events.push('evidence'),finalize:status=>events.push(`finalize:${status}`),hooks});const final=verifiedFailure?'finalize:failed':'finalize:passed';if(result.exitCode!==(verifiedFailure?1:0)||!state.committed||events.indexOf('evidence')>events.indexOf(final)||result.pendingSignal!==143)process.exit(1);}});
NODE
[ "$(wc -l < "$SCRIPT_DIR/run-strong-operation-apple-container.sh" | tr -d ' ')" -le 5 ];grep -q '^exec node .*strong-operation-controller.mjs' "$SCRIPT_DIR/run-strong-operation-apple-container.sh"
BUNDLE="$TMP/bundle";node - "$SCRIPT_DIR/strong-operation-files.mjs" "$SCRIPT_DIR" "$BUNDLE" <<'NODE'
import(process.argv[2]).then(m=>{const hash=m.snapshotBundle(process.argv[3],process.argv[4],'3');if(!/^[a-f0-9]{64}$/.test(hash))process.exit(1);});
NODE
MIXED="$TMP/mixed-bundle";cp -R "$SCRIPT_DIR" "$MIXED";sed 's/RUNNER_BUNDLE_VERSION = "3"/RUNNER_BUNDLE_VERSION = "9"/' "$SCRIPT_DIR/verify-strong-operation-output.mjs" > "$MIXED/verify-strong-operation-output.mjs";expect_fail mixed-bundle node - "$MIXED/strong-operation-files.mjs" "$MIXED" "$TMP/no-bundle" <<'NODE'
import(process.argv[2]).then(m=>m.snapshotBundle(process.argv[3],process.argv[4],'3'));
NODE
grep -q 'mixed runner bundle versions' "$TMP/mixed-bundle.err"

# Mocked full launcher success preserves the public CLI and emits reusable schema-v2 evidence.
MOCK_BIN="$TMP/mock-bin";mkdir "$MOCK_BIN";cat > "$MOCK_BIN/container" <<'SH'
#!/bin/sh
case "${1:-}" in
  --version) echo mock-container ;;
  system) echo running ;;
  stop|rm) exit 0 ;;
  run)
    lifecycle= evidence= artifacts= guest= declared_path=
    while [ "$#" -gt 0 ];do
      if [ "$1" = -e ] && [ "$#" -ge 2 ];then case "$2" in PATH=*) declared_path=${2#PATH=};;esac;shift 2;continue;fi
      if [ "$1" = --mount ] && [ "$#" -ge 2 ];then case "$2" in
        *target=/lifecycle*) lifecycle=$(printf %s "$2"|sed 's/^.*source=\([^,]*\),target=\/lifecycle.*$/\1/') ;;
        *target=/evidence*) evidence=$(printf %s "$2"|sed 's/^.*source=\([^,]*\),target=\/evidence.*$/\1/') ;;
        *target=/artifacts*) artifacts=$(printf %s "$2"|sed 's/^.*source=\([^,]*\),target=\/artifacts.*$/\1/') ;;
        *target=/guest*) guest=$(printf %s "$2"|sed 's/^.*source=\([^,]*\),target=\/guest.*$/\1/') ;;
      esac;shift 2;continue;fi;shift
    done
    if [ -z "$lifecycle" ];then [ "$declared_path" = /usr/bin:/bin ]||exit 126;while IFS= read -r tool;do [ -z "$tool" ]&&continue;[ "$tool" = sh ]||exit 127;done < "$guest/required-tools.txt";exit 0;fi
    printf started > "$lifecycle/started";printf ok > "$evidence/quality.log";printf artifact > "$artifacts/result.bin";printf '0\n' > "$lifecycle/completed" ;;
  *) exit 0 ;;
esac
SH
chmod +x "$MOCK_BIN/container"
MOCK_SCRIPT="$TMP/mock.sh";printf 'set -Eeuo pipefail\nprintf ok > "$STRONG_OPERATION_EVIDENCE_OUT/quality.log"\nprintf artifact > "$STRONG_OPERATION_ARTIFACT_OUT/result.bin"\n' > "$MOCK_SCRIPT"
MOCK_PLAN="$TMP/mock-plan.json";node - "$STRONG" "$MOCK_PLAN" "$(sha "$MOCK_SCRIPT")" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.operations[0].scriptSha256=process.argv[4];p.operations[0].timeoutMs=10000;p.operations[0].outputs=[{kind:'evidence',path:'quality.log'},{kind:'artifact',path:'result.bin'}];fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
ME="$TMP/mock-e";MA="$TMP/mock-a";mkdir "$ME" "$MA";env PATH="$MOCK_BIN:$PATH" "$SCRIPT_DIR/run-strong-operation-apple-container.sh" --source "$SOURCE" --script "$MOCK_SCRIPT" --plan "$MOCK_PLAN" --operation-id quality --evidence-out "$ME" --artifact-out "$MA" --attempt-ledger "$TMP/mock-ledger" > "$TMP/mock.out"
grep -q STRONG_OPERATION_PASS "$TMP/mock.out";grep -q '"status":"succeeded"' "$ME/operation-status.json";[ "$(cat "$MA/result.bin")" = artifact ];node "$SCRIPT_DIR/validate-operation-evidence.mjs" --plan "$MOCK_PLAN" --operation-id quality --source "$SOURCE" --evidence "$ME" --artifact "$MA" | grep -q EVIDENCE_REUSABLE
# No-handoff schema-v2 receipt remains an exact ordered key contract; status has a byte-for-byte golden above.
node - "$ME/operation-receipt.json" <<'NODE'
const r=require(process.argv[2]),keys=['schemaVersion','authority','provenance','operationId','workflowId','roleKey','historicalPlanSha256','operationContractSchemaVersion','operationContractSha256','sourceTreeSha256','statusSha256','startedAtUtc','endedAtUtc','elapsedMs','resources','outputs'],resourceKeys=['cpus','memory'],outputKeys=['kind','path','sizeBytes','sha256'];if(r.schemaVersion!==2||Object.keys(r).join()!==keys.join()||Object.keys(r.resources).join()!==resourceKeys.join()||r.outputs.some(o=>Object.keys(o).join()!==outputKeys.join())||'artifactInput' in r||'producerHandoff' in r)process.exit(1);
NODE
MOCK_ROLE="$TMP/mock-role.json";node - "$MOCK_ROLE" "$SOURCE" "$ME" "$MA" <<'NODE'
const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({operationId:'quality',source:process.argv[3],evidence:process.argv[4],artifact:process.argv[5],preflightSource:null,preflightEvidence:null,preflightArtifact:null}));
NODE
node "$SCRIPT_DIR/aggregate-workflow-report.mjs" --plan "$MOCK_PLAN" --ledger "$TMP/mock-ledger" --role-input "$MOCK_ROLE" --out "$TMP/mock-workflow-report.json" >/dev/null
node - "$TMP/mock-workflow-report.json" <<'NODE'
const r=require(process.argv[2]);if(r.container.status!=='passed')process.exit(1);
NODE

# One-hop artifact handoff: bind reusable producer evidence and validate the read-only mount.
PRODUCER_BINDING="$TMP/producer-binding.json";INTERNAL_BINDING="$TMP/producer-binding-internal.json";node "$SCRIPT_DIR/validate-artifact-handoff.mjs" emit-binding --plan "$MOCK_PLAN" --operation-id quality --source "$SOURCE" --evidence "$ME" --artifact "$MA" > "$PRODUCER_BINDING";node "$SCRIPT_DIR/validate-operation-evidence.mjs" --plan "$MOCK_PLAN" --operation-id quality --source "$SOURCE" --evidence "$ME" --artifact "$MA" --emit-producer-binding true > "$INTERNAL_BINDING";node - "$PRODUCER_BINDING" "$INTERNAL_BINDING" <<'NODE'
const a=require(process.argv[2]).artifactInput,b=require(process.argv[3]).artifactInput;if(JSON.stringify(a)!==JSON.stringify(b))process.exit(1);
NODE
CONSUMER_SCRIPT="$TMP/consumer.sh";cat > "$CONSUMER_SCRIPT" <<'SH'
set -Eeuo pipefail
test "$(cat "$STRONG_OPERATION_PRODUCER_ARTIFACT/result.bin")" = artifact
printf consumed > "$STRONG_OPERATION_EVIDENCE_OUT/consume.log"
SH
CONSUMER_PLAN="$TMP/consumer-plan.json";node - "$MOCK_PLAN" "$CONSUMER_PLAN" "$PRODUCER_BINDING" "$(sha "$CONSUMER_SCRIPT")" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]),binding=require(process.argv[4]).artifactInput;p.operations.push({...p.operations[0],id:'consume',roleKey:'consume',kind:'native-exec',command:'read the published artifact without rebuilding',scriptSha256:process.argv[5],sourceTreeSha256:p.operations[0].sourceTreeSha256,network:'disabled',outputs:[{kind:'evidence',path:'consume.log'}],artifactInput:binding});fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
node "$SCRIPT_DIR/validate-execution-plan.mjs" "$CONSUMER_PLAN" >/dev/null
STALE_HANDOFF_PLAN="$TMP/stale-handoff-plan.json";node - "$CONSUMER_PLAN" "$STALE_HANDOFF_PLAN" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.intake={schemaVersion:1,phase:'deliver',workloadProfile:'backend-api',interfaceMode:'none',repository:{trust:'trusted-reviewed',codeOrigin:'first-party'},requirements:{privilege:'none',processLifetime:'bounded-foreground',hostSockets:[],credentials:'none',network:'none'}};fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
expect_fail intake-stale-handoff node "$SCRIPT_DIR/validate-artifact-handoff.mjs" validate --plan "$STALE_HANDOFF_PLAN" --operation-id consume --producer-handoff "$TMP/not-yet-needed";grep -q 'contract binding mismatch' "$TMP/intake-stale-handoff.err"
HANDOFF="$TMP/producer-handoff.json";node - "$HANDOFF" "$SOURCE" "$ME" "$MA" <<'NODE'
const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({schemaVersion:1,source:process.argv[3],evidence:process.argv[4],artifact:process.argv[5],preflightSource:null,preflightEvidence:null,preflightArtifact:null}));
NODE
node "$SCRIPT_DIR/validate-artifact-handoff.mjs" validate --plan "$CONSUMER_PLAN" --operation-id consume --producer-handoff "$HANDOFF" | grep -q ARTIFACT_HANDOFF_VALID
# Direct-call-only callback deterministically mutates the producer between validation and private snapshot.
node - "$SCRIPT_DIR/artifact-handoff-contract.mjs" "$CONSUMER_PLAN" "$HANDOFF" "$TMP/mutation-snapshot" "$MA/result.bin" <<'NODE'
const fs=require('fs');import(process.argv[2]).then(m=>{const plan=require(process.argv[3]),consumer=plan.operations.find(o=>o.id==='consume'),file=process.argv[6],original=fs.readFileSync(file);try{m.resolveArtifactHandoff({planPath:process.argv[3],plan,consumer,handoffPath:process.argv[4],snapshotDestination:process.argv[5],beforeSnapshot:()=>fs.writeFileSync(file,'mutated')});process.exitCode=1}catch(error){if(!/private producer artifact snapshot hash mismatch/.test(error.message))throw error}finally{fs.writeFileSync(file,original)}});
NODE
node "$SCRIPT_DIR/validate-artifact-handoff.mjs" validate --plan "$CONSUMER_PLAN" --operation-id consume --producer-handoff "$HANDOFF" | grep -q ARTIFACT_HANDOFF_VALID
HANDOFF_BIN="$TMP/handoff-bin";mkdir "$HANDOFF_BIN";cat > "$HANDOFF_BIN/container" <<'SH'
#!/bin/sh
case "${1:-}" in
--version) echo mock-container;;system) echo running;;stop|rm) exit 0;;run)
 lifecycle= evidence= producer= producer_spec= producer_env=
 while [ "$#" -gt 0 ];do
  if [ "$1" = -e ]&&[ "$#" -ge 2 ];then case "$2" in STRONG_OPERATION_PRODUCER_ARTIFACT=*) producer_env=${2#*=};;esac;shift 2;continue;fi
  if [ "$1" = --mount ]&&[ "$#" -ge 2 ];then case "$2" in
   *target=/lifecycle*) lifecycle=$(printf %s "$2"|sed 's/^.*source=\([^,]*\),target=\/lifecycle.*$/\1/');;
   *target=/evidence*) evidence=$(printf %s "$2"|sed 's/^.*source=\([^,]*\),target=\/evidence.*$/\1/');;
   *target=/producer-artifact*) producer=$(printf %s "$2"|sed 's/^.*source=\([^,]*\),target=\/producer-artifact.*$/\1/');producer_spec=$2;;esac;shift 2;continue;fi;shift;done
 [ -z "$lifecycle" ]&&exit 0
 [ "$producer_env" = /producer-artifact ]||exit 120;case "$producer_spec" in *,readonly) :;;*) exit 121;;esac
 [ "$(cat "$producer/result.bin")" = artifact ]||exit 122
 printf started > "$lifecycle/started";printf consumed > "$evidence/consume.log";printf '0\n' > "$lifecycle/completed";;*) exit 0;;esac
SH
chmod +x "$HANDOFF_BIN/container"
# A hashed reviewed script that contains a recognized rebuild command is rejected by the controller before reservation/output.
REBUILD_SCRIPT="$TMP/rebuild-consumer.sh";printf 'set -Eeuo pipefail\ncargo build\n' > "$REBUILD_SCRIPT";REBUILD_SCRIPT_PLAN="$TMP/rebuild-script-plan.json";node - "$CONSUMER_PLAN" "$REBUILD_SCRIPT_PLAN" "$(sha "$REBUILD_SCRIPT")" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.operations[1].scriptSha256=process.argv[4];p.operations[1].command='consume exact producer artifact';fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
RSE="$TMP/rebuild-script-e";mkdir "$RSE";expect_fail rebuild-script-runtime env PATH="$HANDOFF_BIN:$PATH" "$SCRIPT_DIR/run-strong-operation-apple-container.sh" --source "$SOURCE" --script "$REBUILD_SCRIPT" --plan "$REBUILD_SCRIPT_PLAN" --operation-id consume --evidence-out "$RSE" --attempt-ledger "$TMP/rebuild-script-ledger" --producer-handoff "$HANDOFF";grep -q 'undeclared rebuild command' "$TMP/rebuild-script-runtime.err";[ ! -e "$TMP/rebuild-script-ledger" ];[ -z "$(find "$RSE" -mindepth 1 -print -quit)" ]
CE="$TMP/consumer-e";mkdir "$CE";env PATH="$HANDOFF_BIN:$PATH" "$SCRIPT_DIR/run-strong-operation-apple-container.sh" --source "$SOURCE" --script "$CONSUMER_SCRIPT" --plan "$CONSUMER_PLAN" --operation-id consume --evidence-out "$CE" --attempt-ledger "$TMP/mock-ledger" --producer-handoff "$HANDOFF" > "$TMP/consumer.out"
grep -q STRONG_OPERATION_PASS "$TMP/consumer.out";[ "$(cat "$CE/consume.log")" = consumed ];node "$SCRIPT_DIR/validate-operation-evidence.mjs" --plan "$CONSUMER_PLAN" --operation-id consume --source "$SOURCE" --evidence "$CE" --producer-handoff "$HANDOFF" | grep -q EVIDENCE_REUSABLE
CONSUMER_ROLE="$TMP/consumer-role.json";node - "$CONSUMER_ROLE" "$SOURCE" "$CE" "$HANDOFF" <<'NODE'
const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({operationId:'consume',source:process.argv[3],evidence:process.argv[4],artifact:null,preflightSource:null,preflightEvidence:null,preflightArtifact:null,producerHandoff:process.argv[5]}));
NODE
node "$SCRIPT_DIR/aggregate-workflow-report.mjs" --plan "$CONSUMER_PLAN" --ledger "$TMP/mock-ledger" --role-input "$MOCK_ROLE" --role-input "$CONSUMER_ROLE" --out "$TMP/consumer-workflow-report.json" >/dev/null
# Gate reporting requires a direct producer dependency and reuses the same handoff binding.
HANDOFF_GATE_PLAN="$TMP/handoff-gate-plan.json";HANDOFF_GATE_PRODUCER="$TMP/handoff-gate-producer.json";HANDOFF_GATE_CONSUMER="$TMP/handoff-gate-consumer.json";node - "$CONSUMER_PLAN" "$HANDOFF_GATE_PLAN" "$HANDOFF_GATE_PRODUCER" "$HANDOFF_GATE_CONSUMER" "$SOURCE" "$ME" "$MA" "$CE" "$HANDOFF" <<'NODE'
const fs=require('fs'),c=require('crypto'),[planPath,gatePath,producerInput,consumerInput,source,producerEvidence,artifact,consumerEvidence,handoff]=process.argv.slice(2),plan=require(planPath),planSha=c.createHash('sha256').update(fs.readFileSync(planPath)).digest('hex');fs.writeFileSync(gatePath,JSON.stringify({schemaVersion:1,workflowId:plan.workflowId,planSha256:planSha,gates:[{id:'quality',operationId:'quality',roleKey:'quality',costClass:'standard',orderExceptionReason:null,dependsOn:[]},{id:'consume',operationId:'consume',roleKey:'consume',costClass:'expensive',orderExceptionReason:null,dependsOn:[{gateId:'quality',exceptionReason:null}]}]}));fs.writeFileSync(producerInput,JSON.stringify({gateId:'quality',state:'passed',source,evidence:producerEvidence,artifact,preflightSource:null,preflightEvidence:null,preflightArtifact:null,operatorAssessment:null}));fs.writeFileSync(consumerInput,JSON.stringify({gateId:'consume',state:'passed',source,evidence:consumerEvidence,artifact:null,preflightSource:null,preflightEvidence:null,preflightArtifact:null,operatorAssessment:null,producerHandoff:handoff}));
NODE
node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$CONSUMER_PLAN" --gate-plan "$HANDOFF_GATE_PLAN" --ledger "$TMP/mock-ledger" --gate-input "$HANDOFF_GATE_PRODUCER" --gate-input "$HANDOFF_GATE_CONSUMER" --out "$TMP/handoff-gate-report.json" >/dev/null
NO_DIRECT_GATE="$TMP/no-direct-gate.json";node - "$HANDOFF_GATE_PLAN" "$NO_DIRECT_GATE" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.gates[1].dependsOn=[];fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
expect_fail handoff-gate-direct node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$CONSUMER_PLAN" --gate-plan "$NO_DIRECT_GATE" --ledger "$TMP/mock-ledger" --gate-input "$HANDOFF_GATE_PRODUCER" --gate-input "$HANDOFF_GATE_CONSUMER" --out "$TMP/no-direct-report.json"
# Missing/mismatched handoffs stop before ledger reservation.
E="$TMP/missing-handoff-e";mkdir "$E";expect_fail missing-handoff env PATH="$HANDOFF_BIN:$PATH" "$SCRIPT_DIR/run-strong-operation-apple-container.sh" --source "$SOURCE" --script "$CONSUMER_SCRIPT" --plan "$CONSUMER_PLAN" --operation-id consume --evidence-out "$E" --attempt-ledger "$TMP/missing-handoff-ledger";grep -q 'artifactInput and --producer-handoff must be supplied together' "$TMP/missing-handoff.err";[ ! -e "$TMP/missing-handoff-ledger" ]
BAD_HANDOFF="$TMP/bad-handoff.json";node - "$HANDOFF" "$BAD_HANDOFF" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.artifact='/definitely/missing';fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
E="$TMP/wrong-handoff-e";mkdir "$E";expect_fail wrong-handoff env PATH="$HANDOFF_BIN:$PATH" "$SCRIPT_DIR/run-strong-operation-apple-container.sh" --source "$SOURCE" --script "$CONSUMER_SCRIPT" --plan "$CONSUMER_PLAN" --operation-id consume --evidence-out "$E" --attempt-ledger "$TMP/wrong-handoff-ledger" --producer-handoff "$BAD_HANDOFF";grep -Eq 'ENOENT|no such file' "$TMP/wrong-handoff.err";[ ! -e "$TMP/wrong-handoff-ledger" ]
# Mode-only artifact drift changes the tree binding.
TAMPER_ARTIFACT="$TMP/tamper-artifact";cp -R "$MA" "$TAMPER_ARTIFACT";chmod 600 "$TAMPER_ARTIFACT/result.bin";TAMPER_HANDOFF="$TMP/tamper-handoff.json";node - "$HANDOFF" "$TAMPER_HANDOFF" "$TAMPER_ARTIFACT" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.artifact=process.argv[4];fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail handoff-mode-tamper node "$SCRIPT_DIR/validate-artifact-handoff.mjs" validate --plan "$CONSUMER_PLAN" --operation-id consume --producer-handoff "$TAMPER_HANDOFF";grep -q 'binding does not match' "$TMP/handoff-mode-tamper.err"
expect_fail consumer-reuse-drift node "$SCRIPT_DIR/validate-operation-evidence.mjs" --plan "$CONSUMER_PLAN" --operation-id consume --source "$SOURCE" --evidence "$CE" --producer-handoff "$TAMPER_HANDOFF";grep -q 'binding does not match' "$TMP/consumer-reuse-drift.err"
STALE_SOURCE="$TMP/stale-source";mkdir "$STALE_SOURCE";printf stale > "$STALE_SOURCE/x";STALE_HANDOFF="$TMP/stale-handoff.json";node - "$HANDOFF" "$STALE_HANDOFF" "$STALE_SOURCE" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.source=process.argv[4];fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail handoff-stale-source node "$SCRIPT_DIR/validate-artifact-handoff.mjs" validate --plan "$CONSUMER_PLAN" --operation-id consume --producer-handoff "$STALE_HANDOFF";grep -qi 'source tree.*mismatch' "$TMP/handoff-stale-source.err"
TAMPER_EVIDENCE="$TMP/tamper-evidence";cp -R "$ME" "$TAMPER_EVIDENCE";printf x >> "$TAMPER_EVIDENCE/operation-receipt.json";RECEIPT_HANDOFF="$TMP/receipt-handoff.json";node - "$HANDOFF" "$RECEIPT_HANDOFF" "$TAMPER_EVIDENCE" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.evidence=process.argv[4];fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail handoff-receipt-tamper node "$SCRIPT_DIR/validate-artifact-handoff.mjs" validate --plan "$CONSUMER_PLAN" --operation-id consume --producer-handoff "$RECEIPT_HANDOFF";grep -Eq 'receipt|reusable' "$TMP/handoff-receipt-tamper.err"
# Artifact trees reject symlink, hardlink, special file, and oversize input with class-specific diagnostics.
A="$TMP/artifact-symlink";mkdir "$A";ln -s "$MA/result.bin" "$A/x";expect_fail artifact-symlink node "$SCRIPT_DIR/validate-artifact-handoff.mjs" hash-tree --artifact "$A" --max-entries 4 --max-bytes 8 --max-file-size 8;grep -q 'symlink' "$TMP/artifact-symlink.err"
A="$TMP/artifact-hardlink";mkdir "$A";printf artifact > "$A/original";ln "$A/original" "$A/x";expect_fail artifact-hardlink node "$SCRIPT_DIR/validate-artifact-handoff.mjs" hash-tree --artifact "$A" --max-entries 4 --max-bytes 64 --max-file-size 64;grep -q 'hard-linked' "$TMP/artifact-hardlink.err"
A="$TMP/artifact-oversize";mkdir "$A";printf xx > "$A/x";expect_fail artifact-oversize node "$SCRIPT_DIR/validate-artifact-handoff.mjs" hash-tree --artifact "$A" --max-entries 4 --max-bytes 1 --max-file-size 1;grep -Eq 'maxFileSizeBytes|maxOutputBytes' "$TMP/artifact-oversize.err"
if command -v mkfifo >/dev/null 2>&1;then A="$TMP/artifact-special";mkdir "$A";mkfifo "$A/x";expect_fail artifact-special node "$SCRIPT_DIR/validate-artifact-handoff.mjs" hash-tree --artifact "$A" --max-entries 4 --max-bytes 4 --max-file-size 4;fi
# Static consumer source/network/kind/identity/rebuild/chain policies.
for field in source network kind chain contract role image;do BAD="$TMP/consumer-$field.json";node - "$CONSUMER_PLAN" "$BAD" "$field" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]),f=process.argv[4],c=p.operations[1],b=c.artifactInput;if(f==='source')c.sourceTreeSha256='f'.repeat(64);else if(f==='network')c.network='registry';else if(f==='kind')c.kind='build';else if(f==='chain')p.operations[0].artifactInput={...b};else if(f==='role')b.roleKey='wrong';else if(f==='image')b.image='node@sha256:'+'f'.repeat(64);else if(f==='contract')b.operationContractSha256='f'.repeat(64);fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
expect_fail "consumer-$field" node "$SCRIPT_DIR/validate-execution-plan.mjs" "$BAD";grep -Eq 'artifactInput|producer|source|network|consume-only|contract|role|image' "$TMP/consumer-$field.err";done
for field in artifactTreeSha256 receiptSha256 evidenceBindingSha256;do BAD="$TMP/consumer-$field.json";node - "$CONSUMER_PLAN" "$BAD" "$field" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.operations[1].artifactInput[process.argv[4]]='f'.repeat(64);fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
expect_fail "consumer-$field" node "$SCRIPT_DIR/validate-artifact-handoff.mjs" validate --plan "$BAD" --operation-id consume --producer-handoff "$HANDOFF";grep -Eq 'binding|artifact|receipt|evidence' "$TMP/consumer-$field.err";done
REBUILD_PLAN="$TMP/rebuild-plan.json";node - "$CONSUMER_PLAN" "$REBUILD_PLAN" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.operations[1].command='cargo build';fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
expect_fail consumer-rebuild-command node "$SCRIPT_DIR/validate-execution-plan.mjs" "$REBUILD_PLAN"

BAD_SOURCE_PLAN="$TMP/bad-source-plan.json";node - "$MOCK_PLAN" "$BAD_SOURCE_PLAN" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.operations[0].sourceTreeSha256='f'.repeat(64);fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
BSE="$TMP/bad-source-e";BSA="$TMP/bad-source-a";mkdir "$BSE" "$BSA";expect_fail source-readiness-no-reserve env PATH="$MOCK_BIN:$PATH" "$SCRIPT_DIR/run-strong-operation-apple-container.sh" --source "$SOURCE" --script "$MOCK_SCRIPT" --plan "$BAD_SOURCE_PLAN" --operation-id quality --evidence-out "$BSE" --artifact-out "$BSA" --attempt-ledger "$TMP/bad-source-ledger";[ ! -e "$TMP/bad-source-ledger" ];[ -z "$(find "$BSE" "$BSA" -mindepth 1 -print -quit)" ]
MISSING_TOOL_PLAN="$TMP/missing-tool-plan.json";node - "$MOCK_PLAN" "$MISSING_TOOL_PLAN" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]);p.operations[0].requiredTools=['jbs-definitely-missing-tool'];fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
MTE="$TMP/missing-tool-e";MTA="$TMP/missing-tool-a";mkdir "$MTE" "$MTA";expect_fail tool-readiness-no-reserve env PATH="$MOCK_BIN:$PATH" "$SCRIPT_DIR/run-strong-operation-apple-container.sh" --source "$SOURCE" --script "$MOCK_SCRIPT" --plan "$MISSING_TOOL_PLAN" --operation-id quality --evidence-out "$MTE" --artifact-out "$MTA" --attempt-ledger "$TMP/missing-tool-ledger";[ ! -e "$TMP/missing-tool-ledger" ];[ -z "$(find "$MTE" "$MTA" -mindepth 1 -print -quit)" ]
NONZERO_BIN="$TMP/nonzero-bin";mkdir "$NONZERO_BIN";cat > "$NONZERO_BIN/container" <<'SH'
#!/bin/sh
case "${1:-}" in
  --version) echo mock-container ;;
  system) echo running ;;
  stop|rm) exit 0 ;;
  run)
    lifecycle= evidence= artifacts=
    while [ "$#" -gt 0 ];do if [ "$1" = --mount ]&&[ "$#" -ge 2 ];then case "$2" in *target=/lifecycle*) lifecycle=$(printf %s "$2"|sed 's/^.*source=\([^,]*\),target=\/lifecycle.*$/\1/');;*target=/evidence*) evidence=$(printf %s "$2"|sed 's/^.*source=\([^,]*\),target=\/evidence.*$/\1/');;*target=/artifacts*) artifacts=$(printf %s "$2"|sed 's/^.*source=\([^,]*\),target=\/artifacts.*$/\1/');;esac;shift 2;continue;fi;shift;done
    [ -z "$lifecycle" ]&&exit 0
    printf started > "$lifecycle/started";printf diagnostic > "$evidence/quality.log";printf unsafe > "$artifacts/result.bin";printf '7\n' > "$lifecycle/completed";exit 7 ;;
  *) exit 0 ;;
esac
SH
chmod +x "$NONZERO_BIN/container";NZE="$TMP/nonzero-e";NZA="$TMP/nonzero-a";mkdir "$NZE" "$NZA";expect_fail nonzero-failure-only env PATH="$NONZERO_BIN:$PATH" "$SCRIPT_DIR/run-strong-operation-apple-container.sh" --source "$SOURCE" --script "$MOCK_SCRIPT" --plan "$MOCK_PLAN" --operation-id quality --evidence-out "$NZE" --artifact-out "$NZA" --attempt-ledger "$TMP/nonzero-ledger";grep -q '"rawContainerExit":7' "$NZE/operation-status.json";[ ! -e "$NZE/operation-receipt.json" ];[ -z "$(find "$NZA" -mindepth 1 -print -quit)" ];grep -q '"status": "failed"' "$TMP/nonzero-ledger"
# Failed artifact consumers remain inspectable/reportable only with their producer handoff.
FAIL_PLAN="$TMP/fail-consumer-plan.json";node - "$CONSUMER_PLAN" "$FAIL_PLAN" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]),c={...p.operations[1],id:'consume-fail',roleKey:'consume-fail'};p.operations=[p.operations[0],c];fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
FAIL_LEDGER="$TMP/fail-consumer-ledger.json";FAIL_E="$TMP/fail-consumer-e";mkdir "$FAIL_E";expect_fail artifact-consumer-nonzero env PATH="$NONZERO_BIN:$PATH" "$SCRIPT_DIR/run-strong-operation-apple-container.sh" --source "$SOURCE" --script "$CONSUMER_SCRIPT" --plan "$FAIL_PLAN" --operation-id consume-fail --evidence-out "$FAIL_E" --attempt-ledger "$FAIL_LEDGER" --producer-handoff "$HANDOFF";grep -q '"rawContainerExit":7' "$FAIL_E/operation-status.json"
node - "$TMP/mock-ledger" "$FAIL_LEDGER" <<'NODE'
const fs=require('fs'),producer=JSON.parse(fs.readFileSync(process.argv[2])).attempts.filter(a=>a.roleKey==='quality'),consumer=JSON.parse(fs.readFileSync(process.argv[3])).attempts;fs.writeFileSync(process.argv[3],JSON.stringify({schemaVersion:2,attempts:[...producer,...consumer]},null,2)+'\n');fs.chmodSync(process.argv[3],0o600);
NODE
# Controller and ledger now share the reservation start and authoritative terminal instant exactly.
expect_fail artifact-failure-inspect-omission node "$SCRIPT_DIR/generate-gate-report.mjs" inspect-failure --plan "$FAIL_PLAN" --ledger "$FAIL_LEDGER" --operation-id consume-fail --gate-id consume-fail --source "$SOURCE" --evidence "$FAIL_E";grep -q 'required iff' "$TMP/artifact-failure-inspect-omission.err"
FAIL_INSPECT="$TMP/fail-inspect.json";node "$SCRIPT_DIR/generate-gate-report.mjs" inspect-failure --plan "$FAIL_PLAN" --ledger "$FAIL_LEDGER" --operation-id consume-fail --gate-id consume-fail --source "$SOURCE" --evidence "$FAIL_E" --producer-handoff "$HANDOFF" > "$FAIL_INSPECT";grep -q FAILURE_DIAGNOSTICS_INSPECTED "$FAIL_INSPECT"
expect_fail artifact-failure-inspect-tamper node "$SCRIPT_DIR/generate-gate-report.mjs" inspect-failure --plan "$FAIL_PLAN" --ledger "$FAIL_LEDGER" --operation-id consume-fail --gate-id consume-fail --source "$SOURCE" --evidence "$FAIL_E" --producer-handoff "$TAMPER_HANDOFF";grep -q 'binding does not match' "$TMP/artifact-failure-inspect-tamper.err"
FAIL_GATE_PLAN="$TMP/fail-gate-plan.json";FAIL_PRODUCER_INPUT="$TMP/fail-producer-input.json";FAIL_CONSUMER_INPUT="$TMP/fail-consumer-input.json";node - "$FAIL_PLAN" "$FAIL_GATE_PLAN" "$FAIL_PRODUCER_INPUT" "$FAIL_CONSUMER_INPUT" "$SOURCE" "$ME" "$MA" "$FAIL_E" "$HANDOFF" "$FAIL_INSPECT" <<'NODE'
const fs=require('fs'),c=require('crypto'),[planPath,gatePath,producerInput,consumerInput,source,producerEvidence,artifact,consumerEvidence,handoff,inspectionPath]=process.argv.slice(2),plan=require(planPath),inspection=require(inspectionPath),planSha=c.createHash('sha256').update(fs.readFileSync(planPath)).digest('hex');fs.writeFileSync(gatePath,JSON.stringify({schemaVersion:1,workflowId:plan.workflowId,planSha256:planSha,gates:[{id:'quality',operationId:'quality',roleKey:'quality',costClass:'standard',orderExceptionReason:null,dependsOn:[]},{id:'consume-fail',operationId:'consume-fail',roleKey:'consume-fail',costClass:'expensive',orderExceptionReason:null,dependsOn:[{gateId:'quality',exceptionReason:null}]}]}));fs.writeFileSync(producerInput,JSON.stringify({gateId:'quality',state:'passed',source,evidence:producerEvidence,artifact,preflightSource:null,preflightEvidence:null,preflightArtifact:null,operatorAssessment:null}));fs.writeFileSync(consumerInput,JSON.stringify({gateId:'consume-fail',state:'failed',source,evidence:consumerEvidence,artifact:null,preflightSource:null,preflightEvidence:null,preflightArtifact:null,producerHandoff:handoff,operatorAssessment:{kind:'operator-assessment',classification:'candidate',reason:'bounded consumer returned exit 7',failedAttemptId:inspection.failedAttemptId,gateId:'consume-fail',diagnosticManifestSha256:inspection.diagnosticManifestSha256}}));
NODE
node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$FAIL_PLAN" --gate-plan "$FAIL_GATE_PLAN" --ledger "$FAIL_LEDGER" --gate-input "$FAIL_PRODUCER_INPUT" --gate-input "$FAIL_CONSUMER_INPUT" --out "$TMP/fail-gate-report.json" >/dev/null;grep -q '"overallStatus": "failed"' "$TMP/fail-gate-report.json"
FAIL_INPUT_OMIT="$TMP/fail-input-omit.json";node - "$FAIL_CONSUMER_INPUT" "$FAIL_INPUT_OMIT" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);delete v.producerHandoff;fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail artifact-failure-report-omission node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$FAIL_PLAN" --gate-plan "$FAIL_GATE_PLAN" --ledger "$FAIL_LEDGER" --gate-input "$FAIL_PRODUCER_INPUT" --gate-input "$FAIL_INPUT_OMIT" --out "$TMP/fail-gate-omit.json";grep -Eq 'schema fields|producerHandoff' "$TMP/artifact-failure-report-omission.err"
FAIL_INPUT_TAMPER="$TMP/fail-input-tamper.json";node - "$FAIL_CONSUMER_INPUT" "$FAIL_INPUT_TAMPER" "$TAMPER_HANDOFF" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.producerHandoff=process.argv[4];fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail artifact-failure-report-tamper node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$FAIL_PLAN" --gate-plan "$FAIL_GATE_PLAN" --ledger "$FAIL_LEDGER" --gate-input "$FAIL_PRODUCER_INPUT" --gate-input "$FAIL_INPUT_TAMPER" --out "$TMP/fail-gate-tamper.json";grep -q 'binding does not match' "$TMP/artifact-failure-report-tamper.err"
# Real SIGINT/SIGTERM while the bounded child is active must remain 130/143 in process, ledger, and failure evidence.
SIGNAL_BIN="$TMP/signal-bin";mkdir "$SIGNAL_BIN";cat > "$SIGNAL_BIN/container" <<'JS'
#!/usr/bin/env node
const command=process.argv[2];
if(command==='--version'||command==='stop'||command==='rm'||command==='system')process.exit(0);
if(command==='run'){
  const workload=process.argv.some(value=>value.includes('target=/lifecycle'));
  if(!workload)process.exit(0);
  setInterval(()=>{},1000);
}else process.exit(0);
JS
chmod +x "$SIGNAL_BIN/container"
cat > "$TMP/signal-driver.mjs" <<'NODE'
import{spawn}from'node:child_process';import{existsSync,readFileSync}from'node:fs';const [signal,expected,launcher,source,script,plan,evidence,artifact,ledger]=process.argv.slice(2),child=spawn(launcher,['--source',source,'--script',script,'--plan',plan,'--operation-id','quality','--evidence-out',evidence,'--artifact-out',artifact,'--attempt-ledger',ledger],{env:process.env,stdio:'ignore'});const timer=setInterval(()=>{if(existsSync(ledger)&&readFileSync(ledger,'utf8').includes('"status": "running"')){clearInterval(timer);setTimeout(()=>child.kill(signal),50)}},10);const guard=setTimeout(()=>{child.kill('SIGKILL');process.exit(1)},5000);child.on('exit',code=>{clearInterval(timer);clearTimeout(guard);if(code!==Number(expected))process.exit(1)});
NODE
for spec in SIGINT:130 SIGTERM:143;do signal=${spec%:*};expected=${spec#*:};SE="$TMP/signal-$signal-e";SA="$TMP/signal-$signal-a";mkdir "$SE" "$SA";env PATH="$SIGNAL_BIN:$PATH" node "$TMP/signal-driver.mjs" "$signal" "$expected" "$SCRIPT_DIR/run-strong-operation-apple-container.sh" "$SOURCE" "$MOCK_SCRIPT" "$MOCK_PLAN" "$SE" "$SA" "$TMP/signal-$signal-ledger";grep -q '"exitCode":'$expected "$SE/operation-status.json";grep -q '"rawContainerExit":'$expected "$SE/operation-status.json";grep -q '"status": "failed"' "$TMP/signal-$signal-ledger";[ -z "$(find "$SA" -mindepth 1 -print -quit)" ];done
[ -z "$(find "$TMP" -name '.jbs-*' -print -quit)" ] || { echo 'ERROR: strong-operation staging directory leaked from mocked lifecycle test.' >&2; exit 1; }

# Host-generated workflow gate report derives pass/fail/skip from trusted host evidence and ledger state.
GATE_WORKFLOW="$TMP/gate-workflow.json";GATE_SOURCE="$TMP/gate-source";mkdir "$GATE_SOURCE";GATE_SOURCE_SHA=$(node "$SCRIPT_DIR/strong-operation-contract.mjs" hash-tree --root "$GATE_SOURCE"|node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).sourceTreeSha256))')
node - "$PLAN" "$GATE_WORKFLOW" "$GATE_SOURCE_SHA" <<'NODE'
const fs=require('fs'),p=require(process.argv[2]),source=process.argv[4],one='1'.repeat(64);p.workflowId='gate-self-test';p.profile='standard';p.workspace.mode='read-only';p.candidateStage={name:'read',mutationIds:[],promotable:false};p.candidateExports=[];const op=(id,role,n)=>({id,roleKey:role,kind:'test',command:id,image:`node@sha256:${one}`,scriptSha256:String(n).repeat(64),sourceTreeSha256:source,path:['/usr/bin','/bin'],requiredTools:['sh'],resources:{cpus:1,memory:'256M'},network:'disabled',timeoutMs:1000,oracles:[`${id} oracle`],outputs:[{kind:'evidence',path:`${id}.log`}]});p.operations=[op('format','format',3),op('build','build',4),op('pty','pty',5)];p.escalation={required:true,target:'container',reason:'gate report self-test'};fs.writeFileSync(process.argv[3],JSON.stringify(p));
NODE
node "$SCRIPT_DIR/validate-execution-plan.mjs" "$GATE_WORKFLOW" >/dev/null
GATE_PLAN_SHA=$(sha "$GATE_WORKFLOW");FORMAT_CONTRACT=$(node "$SCRIPT_DIR/strong-operation-contract.mjs" contract --plan "$GATE_WORKFLOW" --operation-id format|node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).operationContractSha256))');BUILD_CONTRACT=$(node "$SCRIPT_DIR/strong-operation-contract.mjs" contract --plan "$GATE_WORKFLOW" --operation-id build|node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).operationContractSha256))')
FORMAT_BINDING=$(node -e "const c=require('crypto'),h=c.createHash('sha256');for(const v of process.argv.slice(1))h.update(v).update('\\0');console.log(h.digest('hex'))" "$FORMAT_CONTRACT" "$GATE_SOURCE_SHA" "$(printf '0%.0s' $(seq 1 64))");BUILD_BINDING=$(node -e "const c=require('crypto'),h=c.createHash('sha256');for(const v of process.argv.slice(1))h.update(v).update('\\0');console.log(h.digest('hex'))" "$BUILD_CONTRACT" "$GATE_SOURCE_SHA" "$(printf '0%.0s' $(seq 1 64))")
FORMAT_E="$TMP/gate-format-e";BUILD_E="$TMP/gate-build-e";mkdir "$FORMAT_E" "$BUILD_E";printf format-ok >"$FORMAT_E/format.log";printf build-failed >"$BUILD_E/build.log"
node - "$FORMAT_E" "$GATE_PLAN_SHA" "$FORMAT_CONTRACT" "$GATE_SOURCE_SHA" <<'NODE'
const fs=require('fs'),crypto=require('crypto'),[dir,plan,contract,source]=process.argv.slice(2),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),z='0'.repeat(64),one='1'.repeat(64),status={schemaVersion:2,status:'succeeded',exitCode:0,authority:'host',provenance:'container-exit-attestation',operationId:'format',workflowId:'gate-self-test',roleKey:'format',planSha256:plan,operationContractSchemaVersion:2,operationContractSha256:contract,sourceTreeSha256:source,preflightEvidenceSha256:z,scriptSha256:'3'.repeat(64),image:`node@sha256:${one}`,network:'disabled'},sb=Buffer.from(JSON.stringify(status)+'\n'),out=fs.readFileSync(`${dir}/format.log`);fs.writeFileSync(`${dir}/operation-status.json`,sb);fs.writeFileSync(`${dir}/operation-receipt.json`,JSON.stringify({schemaVersion:2,authority:'host',provenance:'post-execution-output-validation',operationId:'format',workflowId:'gate-self-test',roleKey:'format',historicalPlanSha256:plan,operationContractSchemaVersion:2,operationContractSha256:contract,sourceTreeSha256:source,statusSha256:hash(sb),startedAtUtc:'2026-01-01T00:00:00.000Z',endedAtUtc:'2026-01-01T00:00:00.010Z',elapsedMs:10,resources:{cpus:1,memory:'256M'},outputs:[{kind:'evidence',path:'format.log',sizeBytes:out.length,sha256:hash(out)}]})+'\n');
NODE
node - "$BUILD_E" "$GATE_PLAN_SHA" "$BUILD_CONTRACT" "$GATE_SOURCE_SHA" <<'NODE'
const fs=require('fs'),[dir,plan,contract,source]=process.argv.slice(2),z='0'.repeat(64),one='1'.repeat(64);fs.writeFileSync(`${dir}/operation-status.json`,JSON.stringify({schemaVersion:2,status:'failed',exitCode:7,authority:'host',provenance:'host-failure-assessment',reason:'operation exited nonzero: 7',rawContainerExit:7,operationId:'build',workflowId:'gate-self-test',roleKey:'build',planSha256:plan,operationContractSchemaVersion:2,operationContractSha256:contract,sourceTreeSha256:source,preflightEvidenceSha256:z,scriptSha256:'4'.repeat(64),image:`node@sha256:${one}`,network:'disabled',startedAtUtc:'2026-01-01T00:00:00.011Z',endedAtUtc:'2026-01-01T00:00:00.018Z',elapsedMs:7})+'\n');
NODE
GATE_LEDGER="$TMP/gate-ledger.json";cat >"$GATE_LEDGER" <<JSON
{"schemaVersion":2,"attempts":[{"attemptId":"format-attempt","workflowId":"gate-self-test","roleKey":"format","operationId":"format","bindingSha256":"$FORMAT_BINDING","failureClassification":"initial","attemptNumber":1,"status":"passed","startedAtUtc":"2026-01-01T00:00:00.000Z","endedAtUtc":"2026-01-01T00:00:00.010Z","elapsedMs":10},{"attemptId":"build-attempt","workflowId":"gate-self-test","roleKey":"build","operationId":"build","bindingSha256":"$BUILD_BINDING","failureClassification":"initial","attemptNumber":1,"status":"failed","startedAtUtc":"2026-01-01T00:00:00.011Z","endedAtUtc":"2026-01-01T00:00:00.018Z","elapsedMs":7}]}
JSON
GATE_PLAN="$TMP/gate-plan.json";node - "$GATE_PLAN" "$GATE_PLAN_SHA" <<'NODE'
const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({schemaVersion:1,workflowId:'gate-self-test',planSha256:process.argv[3],gates:[{id:'format',operationId:'format',roleKey:'format',costClass:'cheap',orderExceptionReason:null,dependsOn:[]},{id:'build',operationId:'build',roleKey:'build',costClass:'standard',orderExceptionReason:null,dependsOn:[{gateId:'format',exceptionReason:null}]},{id:'pty',operationId:'pty',roleKey:'pty',costClass:'expensive',orderExceptionReason:null,dependsOn:[{gateId:'build',exceptionReason:null}]}]}));
NODE
INSPECT="$TMP/gate-inspect.json";node "$SCRIPT_DIR/generate-gate-report.mjs" inspect-failure --plan "$GATE_WORKFLOW" --ledger "$GATE_LEDGER" --operation-id build --gate-id build --source "$GATE_SOURCE" --evidence "$BUILD_E" >"$INSPECT";grep -q FAILURE_DIAGNOSTICS_INSPECTED "$INSPECT"
FORMAT_INPUT="$TMP/gate-format-input.json";BUILD_INPUT="$TMP/gate-build-input.json";PTY_INPUT="$TMP/gate-pty-input.json";node - "$FORMAT_INPUT" "$GATE_SOURCE" "$FORMAT_E" <<'NODE'
const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({gateId:'format',state:'passed',source:process.argv[3],evidence:process.argv[4],artifact:null,preflightSource:null,preflightEvidence:null,preflightArtifact:null,operatorAssessment:null}));
NODE
node - "$BUILD_INPUT" "$GATE_SOURCE" "$BUILD_E" "$INSPECT" <<'NODE'
const fs=require('fs'),i=require(process.argv[5]);fs.writeFileSync(process.argv[2],JSON.stringify({gateId:'build',state:'failed',source:process.argv[3],evidence:process.argv[4],artifact:null,preflightSource:null,preflightEvidence:null,preflightArtifact:null,operatorAssessment:{kind:'operator-assessment',classification:'candidate',reason:'reviewed compilation failure',failedAttemptId:i.failedAttemptId,gateId:'build',diagnosticManifestSha256:i.diagnosticManifestSha256}}));
NODE
cat >"$PTY_INPUT" <<'JSON'
{"gateId":"pty","state":"skipped","source":null,"evidence":null,"artifact":null,"preflightSource":null,"preflightEvidence":null,"preflightArtifact":null,"operatorAssessment":null}
JSON
GATE_ARGS="--plan $GATE_WORKFLOW --gate-plan $GATE_PLAN --ledger $GATE_LEDGER --gate-input $FORMAT_INPUT --gate-input $BUILD_INPUT --gate-input $PTY_INPUT"
GATE_REPORT="$TMP/gate-report.json";node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$GATE_REPORT" >"$TMP/gate-generate.out"
node - "$GATE_REPORT" <<'NODE'
const r=require(process.argv[2]);if(r.authority!=='host'||r.provenance!=='host-derived-workflow-gate-report'||r.overallStatus!=='failed'||r.observedThroughUtc!=='2026-01-01T00:00:00.018Z'||r.gates.map(g=>g.status).join(',')!=='passed,failed,skipped'||r.gates[0].attempts.length!==1||r.gates[1].attempts[0].startedAtUtc!=='2026-01-01T00:00:00.011Z'||r.gates[2].blockedByGateIds[0]!=='build'||Object.hasOwn(r,'generatedAtUtc'))process.exit(1);
NODE
if stat -c %a "$GATE_REPORT" >/dev/null 2>&1;then GATE_REPORT_MODE=$(stat -c %a "$GATE_REPORT");else GATE_REPORT_MODE=$(stat -f %Lp "$GATE_REPORT");fi
[ "$GATE_REPORT_MODE" = 600 ]
node "$SCRIPT_DIR/generate-gate-report.mjs" validate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --report "$GATE_REPORT" | grep -q GATE_REPORT_VALID
TAMPERED_REPORT="$TMP/gate-tampered-report.json";node - "$GATE_REPORT" "$TAMPERED_REPORT" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.authority='guest';fs.writeFileSync(process.argv[3],JSON.stringify(v,null,2)+'\n');
NODE
expect_fail guest-report-authority node "$SCRIPT_DIR/generate-gate-report.mjs" validate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --report "$TAMPERED_REPORT";grep -Eq 'authority/provenance|do not match' "$TMP/guest-report-authority.err"
TIMESTAMP_REPORT="$TMP/gate-timestamp-report.json";node - "$GATE_REPORT" "$TIMESTAMP_REPORT" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.generatedAtUtc='2026-01-01T00:00:00.000Z';fs.writeFileSync(process.argv[3],JSON.stringify(v,null,2)+'\n');
NODE
expect_fail fabricated-report-timestamp node "$SCRIPT_DIR/generate-gate-report.mjs" validate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --report "$TIMESTAMP_REPORT";grep -q 'schema fields are not exact' "$TMP/fabricated-report-timestamp.err"
OMITTED_REPORT="$TMP/gate-omitted-report.json";node - "$GATE_REPORT" "$OMITTED_REPORT" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);delete v.gates;fs.writeFileSync(process.argv[3],JSON.stringify(v,null,2)+'\n');
NODE
expect_fail omitted-report-field node "$SCRIPT_DIR/generate-gate-report.mjs" validate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --report "$OMITTED_REPORT";grep -q 'schema fields are not exact' "$TMP/omitted-report-field.err"
expect_fail guest-report-preexists node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$GATE_REPORT";grep -q 'exclusively create' "$TMP/guest-report-preexists.err"
OMITTED_GATE="$TMP/gate-omitted-role.json";node - "$GATE_PLAN" "$OMITTED_GATE" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.gates.pop();fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail gate-role-coverage node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$OMITTED_GATE" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --out "$TMP/gate-coverage-report";grep -q 'cover every' "$TMP/gate-role-coverage.err"
BAD_ROLE_GATE="$TMP/gate-bad-role.json";node - "$GATE_PLAN" "$BAD_ROLE_GATE" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.gates[0].roleKey='build';fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail gate-wrong-role node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$BAD_ROLE_GATE" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-wrong-role-report";grep -q 'unique strong operation and role' "$TMP/gate-wrong-role.err"
UNKNOWN_LEDGER="$TMP/gate-unknown-ledger.json";node - "$GATE_LEDGER" "$UNKNOWN_LEDGER" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.attempts.push({attemptId:'unknown-attempt',workflowId:'gate-self-test',roleKey:'unknown',operationId:'unknown',bindingSha256:'a'.repeat(64),failureClassification:'initial',attemptNumber:1,status:'failed',startedAtUtc:'2026-01-01T00:00:00.019Z',endedAtUtc:'2026-01-01T00:00:00.020Z',elapsedMs:1});fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail gate-unknown-role node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$UNKNOWN_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-unknown-report";grep -q 'unknown current-workflow role' "$TMP/gate-unknown-role.err"
CYCLE_GATE="$TMP/gate-cycle.json";node - "$GATE_PLAN" "$CYCLE_GATE" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.gates[0].dependsOn=[{gateId:'pty',exceptionReason:null}];fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail gate-cycle node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$CYCLE_GATE" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-cycle-report";grep -q 'declared earlier' "$TMP/gate-cycle.err"
COST_GATE="$TMP/gate-cost.json";node - "$GATE_PLAN" "$COST_GATE" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.gates[0].costClass='expensive';fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail gate-cost-order node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$COST_GATE" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-cost-report";grep -q 'orderExceptionReason' "$TMP/gate-cost-order.err"
COST_EXCEPTION="$TMP/gate-cost-exception.json";node - "$COST_GATE" "$COST_EXCEPTION" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.gates[1].orderExceptionReason='reviewed lower-cost gate follows platform preflight';fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$COST_EXCEPTION" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-cost-exception-report" >/dev/null
STALE_SOURCE="$TMP/gate-stale-source";mkdir "$STALE_SOURCE";printf stale >"$STALE_SOURCE/file";STALE_INPUT="$TMP/gate-stale-input.json";node - "$BUILD_INPUT" "$STALE_INPUT" "$STALE_SOURCE" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.source=process.argv[4];fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail gate-stale-source node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$STALE_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-stale-report";grep -q 'source tree is stale' "$TMP/gate-stale-source.err"
printf tamper >>"$BUILD_E/build.log";expect_fail gate-diagnostic-tamper node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-tamper-report";grep -q 'operator assessment binding' "$TMP/gate-diagnostic-tamper.err";printf build-failed >"$BUILD_E/build.log"
SKIP_LEDGER="$TMP/gate-skip-ledger.json";node - "$GATE_LEDGER" "$SKIP_LEDGER" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.attempts.push({attemptId:'pty-attempt',workflowId:'gate-self-test',roleKey:'pty',operationId:'pty',bindingSha256:'f'.repeat(64),failureClassification:'initial',attemptNumber:1,status:'failed',startedAtUtc:'2026-01-01T00:00:00.019Z',endedAtUtc:'2026-01-01T00:00:00.020Z',elapsedMs:1});fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail gate-invalid-skip node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$SKIP_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-skip-report";grep -q 'must have no attempt' "$TMP/gate-invalid-skip.err"
THIRD_LEDGER="$TMP/gate-third-ledger.json";node - "$GATE_LEDGER" "$THIRD_LEDGER" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]),base=v.attempts[1];v.attempts.push({...base,attemptId:'build-retry',bindingSha256:'a'.repeat(64),failureClassification:'candidate',attemptNumber:2,startedAtUtc:'2026-01-01T00:00:00.019Z',endedAtUtc:'2026-01-01T00:00:00.020Z',elapsedMs:1},{...base,attemptId:'build-third',bindingSha256:'b'.repeat(64),failureClassification:'oracle',attemptNumber:3,startedAtUtc:'2026-01-01T00:00:00.021Z',endedAtUtc:'2026-01-01T00:00:00.022Z',elapsedMs:1});fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail gate-third-attempt node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$THIRD_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-third-report";grep -q 'two-attempt budget' "$TMP/gate-third-attempt.err"
POST_PASS_LEDGER="$TMP/gate-post-pass-ledger.json";node - "$GATE_LEDGER" "$POST_PASS_LEDGER" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]),base=v.attempts[0];v.attempts.push({...base,attemptId:'format-after-pass',bindingSha256:'b'.repeat(64),failureClassification:'candidate',attemptNumber:2,status:'failed',startedAtUtc:'2026-01-01T00:00:00.019Z',endedAtUtc:'2026-01-01T00:00:00.020Z',elapsedMs:1});fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail gate-post-pass node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$POST_PASS_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-post-pass-report";grep -q 'after a pass' "$TMP/gate-post-pass.err"
OVERLAP_LEDGER="$TMP/gate-overlap-ledger.json";node - "$GATE_LEDGER" "$OVERLAP_LEDGER" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]),base=v.attempts[1];v.attempts[1]={...base,attemptId:'build-first',bindingSha256:'a'.repeat(64),startedAtUtc:'2026-01-01T00:00:00.005Z',endedAtUtc:'2026-01-01T00:00:00.006Z',elapsedMs:1};v.attempts.push({...base,attemptId:'build-attempt',failureClassification:'candidate',attemptNumber:2});fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail gate-every-attempt-order node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$OVERLAP_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-overlap-report";grep -q 'one or more attempts' "$TMP/gate-every-attempt-order.err"
EXCEPTION_GATE="$TMP/gate-exception.json";node - "$GATE_PLAN" "$EXCEPTION_GATE" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.gates[1].dependsOn[0].exceptionReason='independent immutable inputs permit reviewed overlap';fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$EXCEPTION_GATE" --ledger "$OVERLAP_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-exception-report" >/dev/null
EARLY_RETRY="$TMP/gate-early-retry.json";node - "$OVERLAP_LEDGER" "$EARLY_RETRY" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.attempts[2].startedAtUtc='2026-01-01T00:00:00.005Z';fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail gate-early-retry node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$EXCEPTION_GATE" --ledger "$EARLY_RETRY" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-early-retry-report";grep -q 'retry starts before' "$TMP/gate-early-retry.err"
BAD_TIMESTAMP_E="$TMP/gate-bad-timestamp-e";cp -R "$BUILD_E" "$BAD_TIMESTAMP_E";node - "$BAD_TIMESTAMP_E/operation-status.json" <<'NODE'
const fs=require('fs'),p=process.argv[2],v=require(p);v.startedAtUtc='2026-01-01T00:00:00.012Z';fs.writeFileSync(p,JSON.stringify(v)+'\n');
NODE
BAD_TIMESTAMP_INPUT="$TMP/gate-bad-timestamp-input.json";node - "$BUILD_INPUT" "$BAD_TIMESTAMP_INPUT" "$BAD_TIMESTAMP_E" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.evidence=process.argv[4];fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail gate-status-timestamp node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BAD_TIMESTAMP_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-status-time-report";grep -q 'status/timestamp binding' "$TMP/gate-status-timestamp.err"
OVERSIZED_INPUT="$TMP/gate-oversized-input.json";dd if=/dev/zero bs=1048577 count=1 2>/dev/null | tr '\000' x >"$OVERSIZED_INPUT";expect_fail gate-oversized-input node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$OVERSIZED_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-oversized-report";grep -q 'bounded regular' "$TMP/gate-oversized-input.err"
LINK_INPUT="$TMP/gate-link-input.json";ln -s "$BUILD_INPUT" "$LINK_INPUT";expect_fail gate-link-input node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$GATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$LINK_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-link-report";grep -q 'unavailable' "$TMP/gate-link-input.err"
DUPLICATE_LEDGER="$TMP/gate-duplicate-ledger.json";node - "$GATE_LEDGER" "$DUPLICATE_LEDGER" <<'NODE'
const fs=require('fs'),v=require(process.argv[2]);v.attempts[1].attemptId=v.attempts[0].attemptId;fs.writeFileSync(process.argv[3],JSON.stringify(v));
NODE
expect_fail gate-duplicate-attempt node "$SCRIPT_DIR/generate-gate-report.mjs" generate --plan "$GATE_WORKFLOW" --gate-plan "$GATE_PLAN" --ledger "$DUPLICATE_LEDGER" --gate-input "$FORMAT_INPUT" --gate-input "$BUILD_INPUT" --gate-input "$PTY_INPUT" --out "$TMP/gate-duplicate-report";grep -q 'duplicate attemptId' "$TMP/gate-duplicate-attempt.err"

node - "$SKILL_DIR/assets/strong-operation.json" <<'NODE'
const v=require(process.argv[2]),a=v.browserSmokeOperation,ids=a.viewports.map(v=>v.id),want=['desktop','phone-portrait','phone-landscape','tablet-portrait','tablet-landscape'];if(JSON.stringify(ids)!==JSON.stringify(want)||!want.every(id=>a.outputs.some(o=>o.viewportId===id))||v.artifactConsumerOperation.artifactInput.rebuildPolicy!=='forbidden')process.exit(1);
NODE
[ "$(grep -c -- '--network none' "$SCRIPT_DIR/run-just-bash-apple-container.sh")" -eq 2 ];grep -q '"--no-dns"' "$SCRIPT_DIR/strong-operation-controller.mjs";grep -q '"--read-only"' "$SCRIPT_DIR/strong-operation-controller.mjs";grep -q 'O_NOFOLLOW' "$SCRIPT_DIR/strong-operation-files.mjs"
cat >"$TMP/manifest" <<'FILES'
SKILL.md
assets/execution-plan.json
assets/execution-report.md
assets/gate-plan.json
assets/runtime-package-lock.json
assets/strong-operation.json
references/artifact-handoff.md
references/browser-validation.md
references/execution-policy.md
references/gate-reports.md
references/interactive-validation.md
references/parallel-execution.md
references/strong-operation-authoring.md
references/v4-migration.md
references/workflow-efficiency.md
scripts/aggregate-workflow-report.mjs
scripts/apply-candidate-patch.mjs
scripts/artifact-handoff-contract.mjs
scripts/attempt-ledger.mjs
scripts/bootstrap-just-bash-apple-container.sh
scripts/ensure-apple-container-ready.sh
scripts/gate-report-contract.mjs
scripts/generate-candidate-patch.mjs
scripts/generate-gate-report.mjs
scripts/just-bash-runner.mjs
scripts/preflight-operation-script.mjs
scripts/review-patch.mjs
scripts/risk-intake.mjs
scripts/run-just-bash-apple-container.sh
scripts/run-strong-operation-apple-container.sh
scripts/run-with-timeout.mjs
scripts/self-test.sh
scripts/strong-operation-contract.mjs
scripts/strong-operation-controller.mjs
scripts/strong-operation-entrypoint.sh
scripts/strong-operation-files.mjs
scripts/strong-operation-process.mjs
scripts/strong-operation-status.mjs
scripts/validate-artifact-handoff.mjs
scripts/validate-candidate-tree.mjs
scripts/validate-execution-plan.mjs
scripts/validate-operation-evidence.mjs
scripts/verify-strong-operation-output.mjs
FILES
(cd "$SKILL_DIR"&&find . -type f|sed 's#^./##'|LC_ALL=C sort)>"$TMP/actual";diff -u "$TMP/manifest" "$TMP/actual";[ -z "$(find "$SKILL_DIR" -mindepth 3 -type f -print -quit)" ]
# Exact filesystem entry/type/mode contract: three flat directories plus only the listed regular files.
printf '%s\n' assets references scripts >"$TMP/expected-dirs";(cd "$SKILL_DIR"&&find . -mindepth 1 -maxdepth 1 -type d|sed 's#^./##'|LC_ALL=C sort)>"$TMP/actual-dirs";diff -u "$TMP/expected-dirs" "$TMP/actual-dirs"
[ "$(find "$SKILL_DIR" -mindepth 1 | wc -l | tr -d ' ')" -eq "$(( $(wc -l < "$TMP/manifest" | tr -d ' ') + 3 ))" ];[ -z "$(find "$SKILL_DIR" \( -type l -o \( ! -type d ! -type f \) \) -print -quit)" ]
cat >"$TMP/executable-files" <<'FILES'
scripts/aggregate-workflow-report.mjs
scripts/apply-candidate-patch.mjs
scripts/attempt-ledger.mjs
scripts/bootstrap-just-bash-apple-container.sh
scripts/ensure-apple-container-ready.sh
scripts/generate-candidate-patch.mjs
scripts/just-bash-runner.mjs
scripts/preflight-operation-script.mjs
scripts/review-patch.mjs
scripts/run-just-bash-apple-container.sh
scripts/run-strong-operation-apple-container.sh
scripts/run-with-timeout.mjs
scripts/self-test.sh
scripts/strong-operation-contract.mjs
scripts/validate-candidate-tree.mjs
scripts/validate-execution-plan.mjs
scripts/validate-operation-evidence.mjs
FILES
stat_mode(){ if stat -c %a "$1" >/dev/null 2>&1;then stat -c %a "$1";else stat -f %Lp "$1";fi; }
while IFS= read -r file;do expected=644;grep -Fxq "$file" "$TMP/executable-files"&&expected=755;[ "$(stat_mode "$SKILL_DIR/$file")" -eq "$expected" ];[ -f "$SKILL_DIR/$file" ]&&[ ! -L "$SKILL_DIR/$file" ];done <"$TMP/manifest"
for directory in assets references scripts;do [ "$(stat_mode "$SKILL_DIR/$directory")" -eq 755 ];done
# Import policy: production modules may import only node:* builtins or local files.
node - "$SCRIPT_DIR" <<'NODE'
const fs=require('fs'),path=require('path'),root=process.argv[2];for(const name of fs.readdirSync(root).filter(v=>v.endsWith('.mjs'))){const text=fs.readFileSync(path.join(root,name),'utf8'),specs=[...text.matchAll(/(?:^|\n)\s*import\s+(?:[^'"\n]*?\sfrom\s*)?(["'])([^"']+)\1/g),...text.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g)].map(m=>m[2]);for(const spec of specs)if(!spec.startsWith('node:')&&!spec.startsWith('.'))throw new Error(`disallowed import ${spec} in ${name}`)}
NODE
printf '%s\n' 'SELF_TEST_PASS: Phase-D strict intake/risk derivation/workload-network gates/JSON exits/contract invalidation, blocked-before-runtime enforcement, legacy launcher/status/receipt compatibility, pre-reservation readiness, artifact handoff, host-derived gate reports, v5 structured mutations, deterministic review/application artifacts, legacy/split browser viewport contracts, parser/isolation controls, and exact manifest passed.'
