# Browser Validation

frontend変更では、text生成の検査と実ブラウザ挙動を分離する。browser codeはnative実行に当たるため、Apple Containerへ昇格する。high-riskの場合はexternal microVMが必要としてblockedにする。

## 最小オラクル

1. HTML／JavaScriptの構文errorがない。
2. 初期画面が描画される。
3. 主要actionを1回ずつ実行できる。
4. action後に期待するstateまたはDOM／canvas変化がある。
5. console errorがない。
6. desktopとmobile viewportで主要controlが画面内にある。

## Browser Oracle Preflight

browser strong scriptの全heredoc直前へ`# JBS_HEREDOC data|javascript-module|javascript-commonjs`を宣言する。JavaScript targetや`node` commandをshell wordから推定しない。`node scripts/preflight-operation-script.mjs --script <browser-script>`を実行し、outer BashとJavaScript宣言payloadが構文検証を通るまでattemptを予約しない。runnerは同一snapshot bytesを検証・hash・実行へ使う。

app browser smokeより先にrepository非依存fixtureを`browser-preflight` strong operationとして実行する。次をすべて満たす場合だけpreflightを`passed`にする。

1. immutable browser image、runner、browser executableのprobeが成功する。
2. preflightとsmokeのimmutable image、runner、network、PATH、requiredTools、resourcesが完全一致し、各operationのstructured `viewports [{id,width,height,mobile,pointer}]`とartifact output contractが明示される。
3. 固定fixtureでlaunch、1 action、DOM/canvas observable、console collection、screenshot保存が成功する。
4. task固有oracleごとにoracle ID、action、expected observable、evidence pathを宣言する。
5. 各declared viewportへ`viewportId`付きscreenshot/artifact outputを少なくとも1つ宣言する。
6. pointer controlがある場合、single tap、long press、release後click、pointercancel、lost capture、同一controlのconcurrent pointer、全release後のorphan timer不在を最初のoracle contractへ含める。
7. navigation待機式は未生成DOMを安全に扱い、oracle自身のnull dereferenceをapp failureにしない。
8. statusは`passed | failed | blocked | not required`のいずれかで報告する。

`browser-smoke`へ`preflightOperationId`を宣言し、helperへ`--preflight-source`、`--preflight-evidence`、必要なら`--preflight-artifact`を渡す。helperがpreflight evidenceをcurrent operation contract/source/receipt/output hashesへ再検証できない場合、app smokeを開始しない。fixture成功をapp成功として扱わない。

host-side `preflight-operation-script.mjs`はBashとdeclared embedded JavaScriptのsyntaxだけを確認する。runner import、browser launch、fixture action、console、screenshotはevidence-producing `browser-preflight`で確認する。free-form `runner`からbrowser executableを推測してhostで起動しない。

## Split Browser Mode

新規Web UI workflowでは、legacy combined smokeよりsplit modeを優先する。全`browser-smoke`へ`browserRole`を宣言し、legacy field omissionと混在させない。

1. interaction operationをexactly 1つ宣言する。`browserRole: interaction`、`roleKey: browser-interaction`、viewportは`desktop` exactly 1つとする。主要action、observable state、keyboard、pointer lifecycle、console、requestを検証する。
2. viewport operationを標準viewportごとにexactly 1つ宣言する。`browserRole: viewport-validation`、`roleKey: browser-viewport.<viewport-id>`、viewportは対応する1つだけとする。
3. 標準viewportは`desktop`、`phone-portrait`、`phone-landscape`、`tablet-portrait`、`tablet-landscape`とする。
4. 各viewport operationを別のstrong-operation invocationとして実行する。これにより各roleは別Apple Container、別attempt budget、別evidence/artifact directoryを持つ。1つのsplit scriptで複数viewportをloopしない。
5. 全split roleが同じ`preflightOperationId`と同じ`sourceTreeSha256`を持ち、同じreusable `browser-preflight`へ依存する。image、runner、network、PATH、required tools、resourcesも一致させる。
6. interaction成功からviewport成功を推論せず、viewport screenshotからaction成功を推論しない。

`browserRole`を省略した既存v5 planはlegacy combined modeとして引き続き有効であり、1つの`browser-smoke`へ標準5 viewportを要求する。

## 実行条件

- execution plan作成時にbrowser runnerとbrowser imageの利用可否を確認する。`scripts/ensure-apple-container-ready.sh --start`を先に実行し、service停止を最初のattemptで発見しない。最終工程まで確認を遅らせない。
- browser runnerをcontainer内で実行する。
- repositoryをread-onlyでmountする。
- browser operationのnetworkは無効にする。`registry`はpackage-install operationだけに許可され、runtime egressはbroadでorigin/domain allowlistではない。origin-level enforcementが必要なら強いnetwork controlを使うか、browser validationを`blocked`/`unverified`にする。
- browser download、package install、server起動はcontainer operationとしてexecution planへ記録する。
- screenshot、console log、action結果をartifactとして回収する。
- legacy combined modeでは標準matrixを1つのoracle contractへ含める。split modeでは標準matrixを5つのsingle-viewport contractへ最初から分解し、後続reviewでviewportを逐次追加しない。

## 判定

- 全オラクルを観察した場合だけ`passed`とする。
- syntax testやDOM mockだけの場合、browser smokeを`not run`とする。
- screenshotだけで入力操作の成功を推定しない。
- GUI runnerが利用できない場合、機能成功を捏造せず`blocked`または`not run`とし、未確認の操作と理由をexecution reportへ列挙する。
- frontend taskを`completed`とする場合、browser smokeを`passed`にする。runner不在で成果物をdeliveryする場合、全体statusを`partial`または`unverified`にして残存riskを明示する。
