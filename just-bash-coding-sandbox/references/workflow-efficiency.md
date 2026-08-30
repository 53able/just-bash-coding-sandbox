# Workflow Efficiency

## 目的

provenance、retry budget、risk bindingを弱めず、同じ論理task内の再実行を減らす。

## Same-workflow continuation

同じ論理taskの修正、review対応、validator修正、consumer追加では`workflowId`を維持する。operation IDを変更してretry budgetを回避せず、同じ論理roleには同じ`roleKey`を使う。

次の場合だけ新しいworkflowを開始する。

- task、repository、trust boundary、intake、またはdelivery objectiveが別物になった。
- 同じroleがinitial attemptとclassified retryを使い切り、failure evidenceと修正方針を提示した後で、humanがそのexact taskに対するfresh workflowを明示承認した。

source、script、image、outputs、resources、network、intake/risk、preflight、producer bindingのいずれかが変わった場合、旧evidenceを成功として再利用しない。

## Reuse-before-run

strong operationの前に`validate-operation-evidence.mjs`を実行する。`EVIDENCE_REUSABLE`の場合だけcontainer実行と新しいattempt予約を省く。current contractへ一致しないstatus、receipt、output、artifact、preflight、handoffはreuseしない。

build artifactを後段へ渡す場合は`references/artifact-handoff.md`のsame-workflow one-hop contractを使う。consumer追加時もproducer roleとworkflowを維持する。

## Validation decomposition

Web UIではsplit browser modeを優先する。

- `browser-interaction`: action、state、keyboard、pointer、console/requestを1つのdesktop viewportで検証する。
- `browser-viewport.<viewport-id>`: 1 roleにつき1 viewportだけを検証する。
- 各roleへ独立したevidence/artifact directoryを割り当てる。
- shared source/contractが不変の場合だけ、失敗roleとそのevidenceへ依存するdescendantを再実行する。shared source、script、image、preflight、またはrisk bindingが変わった場合は、その入力へ依存する全split roleをinvalidatedにして再実行する。

split modeのschemaとrole keyは`references/browser-validation.md`に従う。

## Operation fusion

同じtoolchain、source snapshot、dependency installを共有し、直列依存するformat、test、lint、build、packageは1つのquality operationへ融合する。各stepを別evidence fileへ保存し、最初のfailureで停止する。

独立性のないcold installを複数containerで並列化しない。browser interactionとviewport rolesのようにfailure domainが異なるoperationだけを分ける。

## 非対象

次を効率化のために導入しない。

- cross-workflowまたはcross-host artifact reuse
- shared writable package-manager/compiler cache
- source hashが異なるcandidate間のsemantic cache
- artifact chain、multi-producer merge
- intake、trust、credential、network変更を越えるreuse
- retry budgetを回避するworkflow ID／roleKey／operation ID変更

cross-workflow cacheにはauthenticated content-addressed store、namespace、atomic publication、retention、signed provenanceが必要であり、このskillのlocal same-user trust boundaryには含めない。
