# Strong Operation Authoring

## 目的

first-attemptで実行契約を満たし、tool/runtime/output/oracle起因の再実行を減らす。security boundaryは緩めず、既知の失敗をplanとscriptへ先回りして組み込む。

## 1. First-Attempt Readiness Gate

strong operationを開始する前に次を固定する。

1. `scripts/ensure-apple-container-ready.sh --start`でApple Container serviceをreadyにする。
2. immutable image内のtool versionとrequired toolをprobeする。
3. package manager、compiler、browserが使うcache/homeの要件を確認する。helperはcredentialを含まないephemeral `HOME=/tmp/home`と`XDG_CACHE_HOME=/tmp/cache`を作るため、host homeをmountしない。
4. strong scriptの各heredoc直前へ`# JBS_HEREDOC data`、`# JBS_HEREDOC javascript-module`、`# JBS_HEREDOC javascript-commonjs`のいずれかを宣言する。未宣言heredocを禁止する。`node scripts/preflight-operation-script.mjs --script <strong-script>`でouter BashとJavaScript宣言payloadを構文検証する。1行1heredoc、literal delimiter `[A-Za-z_][A-Za-z0-9_-]*`だけを使い、JavaScript delimiterをquoteする。targetのshell表現からpayload種別を推定しない。runnerはoperation scriptを一度snapshotし、その同一bytesをpreflight、hash、container実行へ使う。
5. source tree hash、script hash、operation contract、preflight evidence bindingを確定する。
6. success artifactの概算sizeとfailure diagnosticの最大sizeを見積もる。
7. oracle scriptをrepository非依存fixtureで実行してからapp artifactへ向ける。

readiness gateで不足を見つけた場合、attemptをreserveする前にplan/scriptを修正する。service startupとscript syntaxのfailureはstrong attemptとして予約しない。

## 2. Output Budget

`limits.maxOutputBytes`をstdoutの想定量だけで決めない。全evidenceと全artifactの非圧縮上限を合算し、20%または1 MiBの大きい方をheadroomとして加える。

```text
maxOutputBytes >= sum(max declared evidence/artifact bytes) + max(20%, 1 MiB)
maxFileSizeBytes >= largest declared file
```

frontend site archive、source map、WASM、coverage、browser screenshotを含む場合、templateの16 MiBを出発点にし、実際のbuild構成から縮小または拡大する。上限を不明のまま極端に増やさない。

## 3. Failure Diagnostics

operation scriptは最初に実行commandを対応logへ記録し、実行outputを追記する。

```bash
printf '%s\n' 'COMMAND: npm ci --ignore-scripts --no-audit --no-fund' > "$STRONG_OPERATION_EVIDENCE_OUT/install.log"
npm ci --ignore-scripts --no-audit --no-fund >> "$STRONG_OPERATION_EVIDENCE_OUT/install.log" 2>&1
```

helperはexact output validationが失敗した場合、存在するdeclared evidence regular filesだけをsize limit内でfailure evidence directoryへbest-effort保存する。partial diagnosticにreceiptは付かず、成功またはreuse evidenceとして扱わない。artifact placeholderを事前作成して成功artifactに見せかけない。

## 4. Package Operations

- reviewed lockfileがある場合は`npm ci`、`cargo --locked`、同等のfrozen installを使う。
- lock生成とlock利用を別operationに分ける場合、manifest hashをlock生成へ束縛する。
- install command自体をlogへ記録する。
- install scriptを無効化した場合、その選択と未実行のcode generation riskを報告する。
- production-only auditとbuild-tool dependency auditを区別する。

## 5. Browser Interaction Matrix

browser oracleを最初から次のinteraction classで設計する。

- keyboard: focus、single key、repeat key、pause中の無効化。
- pointer: single tap、long press、release後の余分なclick、cancel、lost capture。
- multi-pointer:同じcontrolへの同時pointer、片方だけのrelease、全release後のorphan timer不在。
- lifecycle: initial render、action後state、pause/resume、restart、game over。
- geometry: desktop、phone portrait/landscape、tablet portrait/landscape、44 px target、overlap、aspect ratio。
- diagnostics: page exception、console error、failed request、screenshot、state observable。

navigation直後のpoll expressionは`document.body?.dataset...`のように未生成DOMを安全に扱う。screenshotだけでaction成功を推定しない。browser shell scriptがJavaScriptを埋め込む場合、直前に`# JBS_HEREDOC javascript-module`または`javascript-commonjs`を宣言する。attempt前のscript preflightは宣言payload自体を`node --check`へ通す。HTML、JSON、設定などの非JavaScript heredocにも`# JBS_HEREDOC data`を宣言する。

## 6. Review Closure

各review laneへ「全blockerを一度に列挙し、最初のfindingで停止しない」と指示する。interaction stateはsingle/long/cancel/concurrentを同じlaneで確認する。全laneのfindingを集めてから1つのrepair stageを作り、repair後は元findingと隣接failure modeを同時に再確認する。

同じ種類のfindingがrepair後に追加で現れた場合、別operation IDでretry budgetを回避しない。review scope不足として`blocked`にし、planへ戻る。

## 7. Helper-Enforced Readiness

strong helperはattempt予約前に、source treeをdeclared limits内で再hashし、immutable imageを同じPATH、network、CPU、memory条件で起動して`requiredTools`をprobeする。readiness containerへsource、evidence、artifact、credentialをmountしない。失敗時はledger attempt、operation receipt、reusable evidenceを作らない。workload entrypointでも同じtool確認を残し、readiness後のdriftへfail closedする。

workloadがnonzero exitした場合、helperは存在するdeclared evidenceだけをfailure diagnosticsとして保存し、success artifactとoperation receiptを公開しない。nonzero failureへsuccess用exact output setを要求しない。

## 8. One-hop Artifact Consumer

build-once workflowでは`references/artifact-handoff.md`を読む。reusable producer evidenceからbindingをemitし、later operationへexact `artifactInput`を追加する。consumerはempty source、network disabled、consume-only kind/scriptを使い、location sidecarを`--producer-handoff`へ渡す。artifactは`$STRONG_OPERATION_PRODUCER_ARTIFACT`から読む。chainまたはmulti-inputを追加せず、`rebuildPolicy: forbidden`をhostile scriptへの非再build証明として扱わない。
