# Execution Policy

## 目的

just-bashを強い隔離境界ではなく、OS shellへ渡すcapabilityを減らす第一防御層として使う。検索・読解・編集と、任意コード実行を必要とする工程を分離する。

## Phase-D Risk Intake and Effective Profile

authoring policyとして新規v5 planはtop-levelにstrict `intake` schema v1を持つ。exact fieldsは`phase`、`workloadProfile`、`interfaceMode`、`repository {trust, codeOrigin}`、`requirements {privilege, processLifetime, hostSockets, credentials, network}`であり、missing/extra field、bad type/enum、duplicate socketを拒否する。ただしvalidatorがno-intake互換経路を選ぶ条件は、認証されていないJSONでtop-level `intake` fieldが省略されていることだけである。履歴や作成時期のprovenanceを認証しないため、既存planに限定されず、新規作成planでもfield omissionにより`legacy-unassessed`経路へdowngradeできる。この経路は互換性のため検証可能だが、Phase-D assessedとは呼ばず、authenticated historical provenanceを意味しない。

risk minimumは`text-only < standard < high-risk`で導出し、caller profileとのmaxをeffective profileとする。engineering workload、strong operation、package registry、bounded ephemeral service、host/interactive deliveryはstandardである。`trusted-unreviewed`/unknown/untrusted/hostile trust、unreviewed/generated-unreviewed/unknown origin、none以外のprivilege、persistent/host/unknown process、任意host socket、none以外のcredential、origin-specific/broad/unknown network、caller high-risk、docker/unknown operationはhigh-riskであり、`external-microvm`へrouteしてblockedにする。`generated-reviewed`だけではhigh-riskにしない。さらにdeclared host command内の明示的なsudo/doas、docker/podman、`--privileged`、host root mount、Docker socket、kubectl、`terraform apply`、cloud credential環境変数、daemon managerをcontradiction signalとしてhigh-riskへ引き上げる。scannerは通常のabsolute path-qualified executableと`command` wrapperも照合し、attached volume optionやquoted root sourceも検出する。このscannerはriskを上げるだけで安全を証明せず、intakeはtrusted operator assertionである。通常のreview済みCLI/TUI host commandはこれらのsignalがなければ引き続き宣言できる。

`intake`ありplanではunderstated caller profileを書き直させずeffective profileでescalationを検証する。`--json` validatorはdeterministic key orderでexit 0=executable、2=invalid、3=valid-but-blockedを返す。strong operation contract schemaは2のまま、intake-bearing planだけcanonical risk decisionとそのSHA-256をoptional fieldとして含める。このためintake変更はattempt/evidence/artifact handoffをinvalidateし、no-intake contract/status/receipt bytesは変えない。

Network consistencyはrequirements network `none`なら全strong operationを`disabled`、`package-registry`なら1件以上の`package-install` operationを`registry`にし、他kindのstrong operationへ`registry`を禁止する。registryはorigin/domain allowlistではなくruntime egressはbroadである。trusted/reviewed package-installでもdependency substitution、install-time behavior、registry compromiseはresidual riskとして残る。blocked routeは実行しない。deliver phaseだけworkload-specific gateを適用する: web UIはbrowser pairかつterminal interactiveなし、CLIはtest/native/repository script、TUIはexact host interactive contract、backendはtestかつterminal interactiveなし、libraryはbuild/testかつhost/interactiveなし、infrastructureはoffline test/native/repository script・review required・host/interactiveなし、researchはtest/build/nativeかつhost/interactiveなし。change/validateはhost/interactive deliveryなし、inspectはhost/interactiveとstrong operationなしとする。change/validate/inspectはcandidateを生成・検査できるが`candidateStage.promotable`はfalseでなければならず、application bundle生成、host application、hostApplication successは`phase=deliver`だけに許可する。web-ui changeからpromoteする場合もdeliverとしてreplanし再検証する。既存のnonempty mutation contractは維持する。

## Risk Profiles

### text-only

次の条件をすべて満たす場合だけfast pathを使う。

- operationが`read`、`search`、`compare`、`text-edit`、`file-generate`、`json-transform`、`csv-transform`、`diff`、`patch-generate`のいずれか
- filesystemが`in-memory`、`read-only`、`overlay-cow`のいずれか
- network off
- JavaScript off
- Python off
- custom commandなし
- build、test、package install、native executable、repository scriptなし

fast pathでもdeliver phaseのpatch reviewとhost適用前の承認を省略しない。change/validate/inspect phaseではcandidate inspectionまでに留め、promotionはdeliverへのreplanを要求する。

### standard

safe operationと強いoperationを分ける。safe operationはjust-bash、build、test、package install、native executableはcontainer以上へ送る。

### high-risk

未知または敵対的なrepository、Docker daemon、privileged operation、高いexfiltration riskを含むtaskを`external-microvm`としてblockedにする。このskillはmicroVM backendを実装しない。just-bashは事前のread／searchに限定する。

## Change Classes and Lanes

patchを生成する前に変更対象を分類する。

- `source`: application source、test、documentation、style
- `dependency`: JavaScript、Python、Rust、Go、Ruby、JVM、.NET、PHPなどのpackage manifest／lockfile、package manager設定、Dockerfile／Containerfile
- `automation`: hook、CI／CD、release、deployment設定
- `credential-sensitive`: secret、credential、SSH、cloud設定への参照
- `binary`: executable、archive、binary、symlink
- `sandbox-infrastructure`: runner、validator、execution policy、sandbox script

`source`だけなら通常laneを使う。`dependency`を含む場合、package installとlockfile生成を最初からcontainer operationとしてplanへ入れ、`expectedReviewRequired: true`にする。`automation`、`credential-sensitive`、`binary`、`sandbox-infrastructure`を含む場合、final patchを別validatorまたは人間へ必ず送る。

予定済みのreview-required classは失敗ではなく、別reviewへのrouting条件である。そのclassが検出されたことだけを理由にcandidate全体を再生成しない。unexpected target、unsafe path、secret markerなど、plan外のfindingは修正または再計画する。

## Parallel Scheduling

実行前にjob dependency DAGを作り、`references/parallel-execution.md`に従う。独立したread-only preflight、review、image readiness、matrix validationを最大4 laneでfanoutする。同じcandidateへのwriter、重複output、manifestに依存するlock生成、buildに依存するbrowser smoke、approvalに依存するpatch適用は直列にする。

同じworkspace、toolchain、dependency cacheを共有し、前stepの成功が後stepの前提となるformat、test、lint、build、packageは1つのstrong quality operationへ融合する。並列containerで同じdependencyをcold installしない。review findingはlaneごとに修正せず、全laneを収集して1つのrepair stageへbatchする。

parallel orchestrationはsecurity boundaryではない。各strong childは既存helper、validated plan、exact script hash、source tree hash、固有のempty evidence/artifact directoryを必須にする。failed jobのdescendantだけをinvalidatedにし、current operation contract、source tree、status、receipt、output hashesが一致するindependent evidenceだけを再利用する。

retryは各operationにつきinitial attempt + 1回、batch repairは1 cycleだけ許可する。workflow共通のschema-v2 attempt ledgerをhelperへ渡し、`workflowId + roleKey`でbudgetを共有してoperation ID改名によるreset、operation contract + source tree + preflight evidence bindingが同じblind retry、3回目を機械的に拒否する。operator-assigned failure classificationと変更前後hashをretry前にledgerへ記録し、budget枯渇時はblockedまたはfailedにする。classificationは診断記録であり、自動的な原因証明ではない。attempt ledgerはcaller-ownedであり、malicious same-user改ざんへの認証ではない。

## Tier A: just-bash

対象operation:

- `read`
- `search`
- `compare`
- `text-edit`
- `file-generate`
- `json-transform`
- `csv-transform`
- `diff`
- `patch-generate`

既定capability:

- filesystem: `in-memory`、`read-only`、または`overlay-cow`
- network: off
- JavaScript: off
- Python: off
- custom command: none
- host write: none

## Tier B: container

対象operation:

- `build`
- `test`
- `package-install`
- `native-exec`
- repository固有script
- `browser-smoke`

private workspaceを渡し、host credential、host home directory、SSH agent、Docker socketを渡さない。helperは`/tmp` tmpfs内にcredentialを含まないephemeral `HOME=/tmp/home`と`XDG_CACHE_HOME=/tmp/cache`を作り、package managerがhost homeなしでcacheを作れるようにする。bounded operationは`scripts/run-strong-operation-apple-container.sh`だけで実行する。callerはattempt前に`scripts/ensure-apple-container-ready.sh --start`を明示実行する。helperはserviceを暗黙起動せず、attempt予約前に`scripts/ensure-apple-container-ready.sh`でreadinessを再確認する。helperはsnapshotted operation bytesへ`scripts/preflight-operation-script.mjs`を実行し、outer Bashと`# JBS_HEREDOC javascript-module|javascript-commonjs`で明示分類されたquoted payloadを確認する。未宣言heredocを拒否する。helperはsourceをprivate snapshotへcopyし、regular/non-symlink/non-hardlink file、mode、size、contentからdeterministic tree hashを計算し、selected operationのnon-null `sourceTreeSha256`と照合する。containerへはsnapshot、script、planをread-only mountし、private `/work`、`cap-drop ALL`、plan由来`resources {cpus,memory}`を使う。

各strong operationへunique IDとunique stable `roleKey`、immutable image、script hash、nullable source tree hash、PATH、tools、resources、network、effective timeout、oracles、exact outputsを宣言する。plan limitsへ`maxSourceEntries`と`maxSourceBytes`を含め、original sourceとsnapshotを両方hashして一致させる。host preparation時間をoperation全体のtimeoutから差し引く。`scripts/strong-operation-contract.mjs`はこれらとoutput limitsをversioned canonical contractへ射影し、unrelated plan operationをhash対象から除外する。unknown strong-operation fieldを拒否する。

trusted entrypointはstarted markerとoperation exit codeを持つcompletion recordをdedicated lifecycle stagingへ書き、hostはcontainer CLI exitとのexact一致を確認してschema-v2 container-exit attestationを生成し、plan、operation contract、source tree、preflight evidence、script、image、networkを記録する。untrusted workloadへstatus mountを渡さない。hostはprivate stagingでexact output set、regular file、size limitを検証し、status hashと全declared outputのkind/path/size/SHA-256、UTC timestamps、monotonic elapsedMsを持つschema-v2 `operation-receipt.json`を生成してからcaller outputへartifact-first/evidence-lastでpublishする。`operation-receipt.json`をlogical commit markerとし、receiptのないorphan artifactを成功・reuse扱いしない。signal時はpublished artifactをrollbackし、host crash時は新しいattempt output directoryを使う。missing、link、malformed、mismatch、timeout、unexpected/oversized outputで成功を合成しない。exact output validationが失敗した場合、存在するdeclared evidence regular filesだけをsize limit内でfailure directoryへbest-effort保存する。partial diagnosticにはreceiptを付けず、成功・reuse evidenceとして扱わない。

planのunrelated部分が変わった場合、`scripts/validate-operation-evidence.mjs`でcurrent operation contract、source tree、historical authoritative status、host receipt、published outputsを再計算する。`EVIDENCE_REUSABLE`の場合だけ再実行を省略する。receiptはaccidental tamper検出とprovenance用であり、caller-owned fileを自由に書き換えられるmalicious same-user processへの認証ではない。service readiness、operation-script snapshot、bootstrap runtime pathの再検証もaccidental driftと通常のsymlinkを対象とし、runtime parentやcaller-owned pathを同時に置換できるmalicious same-user processへの完全なrace defenseではない。必要ならtrusted store、署名、またはstronger host boundaryを使う。

browser-smokeはdeclared browser-preflight evidenceをhelperで再検証した後だけ開始する。networkは原則disabledであり、`registry`はpackage-installだけに許可する。registry runtime egressはbroadでorigin/domain allowlistではなく、trusted/reviewed package-installにもresidual supply-chain riskが残る。container成功はhost runtimeまたはPTY/TTY成功を意味しない。

## Tier C: external microVM (not implemented)

次の条件ではこのskillの実行を停止し、別途管理されたexternal microVMへroutingする。このskillはbackend、runner、成功evidenceを提供しない。

- `docker`
- 未知または敵対的なrepository
- kernel境界、daemon、privileged operation
- 強いexfiltration risk
- container escapeの影響をhostからさらに分離する必要がある処理

## Runner Bootstrap

限定shellを起動するtrusted runnerを先に用意する。runnerとjust-bash dependencyは信頼側の構成としてversionを固定する。

Apple Container構成では次を守る。

- immutable digestで固定したNode imageを使う
- 同梱review済み`assets/runtime-package-lock.json`のSHA-256をhost/container双方で確認し、`npm ci --ignore-scripts --no-audit --no-fund`を使う
- lockと一致しないversion overrideを拒否し、image、lock hash、just-bash version、npm tree hash、installed file tree hashをruntime receiptへ残す
- version 5 execution planだけを受理し、authoring policy上の新規planではstrict risk `intake` v1、workflowId、local Apple Container runtime scope、structured mutations、candidateStage、post-image candidateExports、delivery、completion、retryPolicy、`tierA.scriptSha256` contractを必須にする。実装上はunauthenticated field omissionだけで新規planもlegacy/unassessed互換経路へdowngradeでき、historical provenanceの証明ではない
- host launcherとbundled runnerがexact Tier-A script bytesのSHA-256を検証し、scriptを`set -e`/`set -eu`でfail-closedにする
- validated planをrunnerへmountし、command count、output、file read、memory、timeout limitをplanから設定する
- exit code 0でも最小stdout bytesまたは必須completion markerを満たさなければ失敗にする
- bundled just-bash runnerのnetworkを常にoffにする
- runtime専用directory以外をwrite mountしない
- repository、runner script、runtimeをread-onlyでmountする
- explicit `OverlayFs` runnerを使う
- callerが`scripts/ensure-apple-container-ready.sh --start`でservice startupを明示承認し、runnerはserviceを暗黙起動しない。smokeがpassするまでrepository taskを開始しない

bundled CLIとread-only mountの組み合わせで`EROFS`が発生した構成があるため、標準経路には`just-bash-runner.mjs`を使う。この観察を全version／全hostへ一般化しない。

## Decision Table

| 条件 | Profile | 実行先 |
|---|---|---|
| 読む・検索するだけ | text-only | just-bash / read-only |
| textを編集してpatchを作る | text-only | just-bash / overlay-cow |
| APIからdataを読む | standard | networkを制限したcontainer以上 |
| build・testする | standard | container以上 |
| packageをinstallする | standard | container以上 |
| native binaryを動かす | standard | container以上 |
| Docker daemonを使う | high-risk | blocked; external microVMへrouting |
| 分類できない | high-risk | blocked; external microVMへrouting |

## Trust Boundary

just-bashと同じNode.js processに残るものを信頼対象として扱う。

- Node.jsとV8
- OS kernel
- npm dependencies
- embedding application
- filesystem adapter
- fetch hook
- custom commandとplugin
- execution plan validatorとpatch validator
- host側のpatch適用機構

Node Workerだけをhostからの強い隔離として扱わない。interpreter limitとprocess memory、CPU、wall-clock timeoutなどの外側limitを併用する。

## Delivery Contract

Phase-D intakeはtrusted operator assertionであり、host command scannerやpath scannerは明示矛盾を見つけてriskを上げるだけで安全を証明しない。

v5 planは`delivery.hostRuntime {required, commands}`と`delivery.interactive {required, runner, command, terminalType, rows, columns, oracles}`を必須にする。required trueではcommand/oracle配列を非空、falseでは空にする。interactive falseはrunner none、空command/terminal、zero dimensionsとする。interactive trueはhost/container runner、非空command/terminal/oracles、positive dimensionsを要求し、host runnerはrequired host runtimeと完全一致するdeclared commandを必要とする。host commandはtrusted hostで別に実行して初めて`host-runnable`、PTY/TTY oracleを全て確認して初めて`interactive-verified`とする。

## Candidate and Patch Review

semantic defect、candidate purity、path/content lintを分離する。v5 planは`changeSet.mutations`へstable IDと`add | modify | delete | rename`を宣言する。addの`beforeSha256`はnull、modify／delete／renameはbaseline bytesのSHA-256とする。`candidateStage.mutationIds`はstageに含む変更を表し、promotable stageでは全mutationを含む。`candidateExports`はadd／modify pathとrename destinationだけを含み、delete／rename sourceのtombstoneを作らない。

`validate-candidate-tree.mjs`はbaseline、plan、candidateのexact post-image file set、regular/non-symlink/non-hardlink file、preimage hash、rename destination absenceを検証してschema-v2 resultを出す。blocked planはpass結果を出さず、non-deliver assessed planはpassしても`promotionEligible: false`に固定する。delete-onlyでは`--candidate-out`をTier Aへ渡さず、repository外に作った空candidate rootを検証する。`generate-candidate-patch.mjs`はcandidate validationを入力し、human-readableなdeterministic git review patchとbaseline-bound application bundleを別々に生成する。`review-patch.mjs`にはreview patchだけを渡し、結果JSONを保存する。semantic approvalとは分離する。

host適用前にhuman approval JSONを作り、workflow ID、plan hash、candidate validation/tree hash、application bundle hash、review patch hash、patch-review hash、approved decision、approver、timestampを全て拘束する。`apply-candidate-patch.mjs`はbare hashを受理せず、全artifactのstrict schema、exact mutation equality、parent component、duplicate/ancestor overlap、preimage/post-imageをwrite前に検証する。repository workflow lockを保持し、handled failureをrollbackし、rollback不完全ならreceiptを発行せずfail closedする。

lockfile、binary、大型candidate、final patchをjust-bashのheredocまたはstdoutで搬送しない。dependency、automation、binary、credential-sensitive、sandbox-infrastructureは別reviewへ送る。static path検査では全existing parent componentのdirectory/non-symlink性を要求する。receipt発行失敗を含むhandled application failureはrollbackするが、process crash、power loss、または検査後にfilesystemを変更できるmalicious concurrent same-user processへの完全なtransaction／authenticationではない。必要ならtrusted store、filesystem transaction、署名、またはstronger host boundaryを使う。

optional `artifactInput`は同一workflowのearlier producer 1件をcontract/source/image/receipt/evidence/mode-aware treeへ拘束する。location-only sidecarをattempt予約前にstable-readし、producer evidenceを再利用可能と確認してprivate snapshotだけを`/producer-artifact`へread-only mountする。consumerはempty source、network disabled、reviewed consume-only scriptを使う。`rebuildPolicy: forbidden`はhostile scriptへの非再build証明ではない。chain、multi-input、cross-host transferはv1対象外とする。

`aggregate-workflow-report.mjs`は各strong roleの明示的なsource/evidence/artifact/preflight inputとschema-v2 ledgerを要求し、`validate-operation-evidence.mjs`でoperation contract、current source、preflight、status、receipt、exact output hashを再検証する。finalized ledger attemptのrole、operation、attempt binding、elapsed timeと矛盾すれば停止する。candidate、approval、host applicationのmutation/hash bindingも再検証し、candidate、container、host application、host runtime、interactiveを分離する。status-only evidenceやcontainer statusだけからhost runtimeまたはinteractive successを生成しない。

optional gate reportは別sidecarとしてhost CLIだけが生成する。全strong roleをexactに覆い、passedはreusable evidence、failedはexact host failure status・failed ledger・bounded diagnostic manifest、skippedはdependency non-pass・attempt不在から導出する。operator classificationはattempt/gate/manifestへ束縛したassessmentでありverified root causeではない。reportは全attemptの順序とdeterministic observed-through timeを検査するだけで、operation scheduler、success receipt、artifact publication、approvalを代替しない。

## 根拠と適用範囲

- https://github.com/vercel-labs/just-bash
- https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/README.md
- https://github.com/vercel-labs/just-bash/blob/main/THREAT_MODEL.md
- https://github.com/vercel-labs/just-bash/blob/main/CLAUDE.md

提供記事の実測範囲はjust-bash 3.4.2、Node.js 24.13.0／24.19.0、Apple Container 1.2.2である。別version、別host、別filesystem adapterへ適用する前にsmokeとcapability probeを再実行する。symlink、hard link、TOCTOU、DNS rebinding、QuickJS、CPython WASMは追加試験なしに安全扱いしない。
