# Parallel Execution Policy

## 目的

安全境界を弱めず、critical path上の待ち時間と無駄な再実行を減らす。並列化はjob数を増やすことではなく、依存しないlaneを同時に進め、依存する工程を1回のbounded operationへ融合することで行う。

## 1. DAGを作る

各jobを次の形でledgerへ記録する。

| Job | Input hash | Depends on | Writes | Evidence/Artifact | Status |
|---|---|---|---|---|---|
| `lane-id` | SHA-256 | job ID list | exact paths | exact paths | `queued | running | passed | failed | invalidated` |

次の条件をすべて満たすjobだけを同時実行する。

- 依存関係がない。
- source、candidate、evidence、artifact、cache、port、container nameが重ならない。
- どのjobも同じcandidate stageを変更しない。
- 各strong jobが別のempty evidence/artifact directoryを使う。
- Tier A／strong jobはvalidated v5 plan、exact script SHA-256、source tree SHA-256へ束縛される。read-only review laneはcandidate tree SHA-256を入力として記録する。
- 片方の失敗がもう片方の入力を無効化しない。

既定concurrencyは独立job数と4の小さい方にする。CPU、memory、registry rate limitが厳しい場合は2へ下げる。

## 2. 並列化するlane

### Preflight fanout

次を同時に進める。

1. just-bash runner smoke。
2. strong imageのavailability/pull/probe。
3. repository read-only inventoryとchange-class分類。
4. delivery oracle、browser oracle、PTY/TTY oracleの設計。

image pullはexternal registry operationとして記録する。mutable tagを実行planへ残さず、取得後にimmutable digestへ固定する。

### Draft fanout

最初のsource candidateができたら、fresh-contextのread-only laneへ分ける。

1. gameplay/domain semanticsとedge case。
2. UI、accessibility、responsive behavior。
3. dependency manifest、toolchain compatibility、lock generation方法。
4. test oracle、browser smoke、failure-path coverage。

clone promptを送らない。各laneへ対象seam、判断項目、既知のrisk、返却形式`APPROVE | BLOCK`を明示し、全blockerと隣接failure modeを一度に列挙させる。最初のfindingで停止するreviewをrepair入力として確定しない。writerはparentだけにし、reviewerはcandidateを変更しない。

manifestが安定した時点で、lockfile生成とsource semantic reviewは独立laneとして同時実行できる。lockfile生成はmanifest hashへ束縛し、manifest変更時は結果を`invalidated`にする。

### Validation fanout

同じbuild artifactを必要としない独立matrixだけを並列化する。Web UIでは`browser-validation.md`のsplit modeを使い、interactionとsingle-viewport roleを独立failure domainにする。

- 異なるOS/toolchain/version matrix。
- source-only static reviewとdependency/audit review。
- final semantic reviewとevidence/provenance verification。
- read-only security reviewとaccessibility review。

## 3. 並列化しない工程

次はcritical dependencyとして直列にする。

- manifest生成 → lockfile生成。
- source/lock assembly → build。
- build artifact生成 → producer evidence reuse/tree binding → artifact-only consumer。consumer gateはproducer gateをdirect dependencyにする。
- blocker修正 → candidate tree再検証。
- candidate approval → final patch生成。
- patch approval → host適用 → post-application hash照合。
- 同じcandidate stageへの複数writer。

## 4. Strong operationを融合する

同じtoolchain、dependency cache、workspaceを共有し、前工程の成功が後工程の前提なら、複数containerへ分割せず1つのquality operationへまとめる。

推奨順序:

1. toolchain/component preflight。
2. format check。
3. unit/integration tests。
4. lint/Clippy/typecheck。
5. release build。
6. package/site artifact生成。
7. artifact structure check。

`set -Eeuo pipefail`を使い、各stepを別declared evidence fileへ記録する。途中失敗を後続markerで隠さない。format修正のようなcandidate変更はquality operationから分離し、review済みartifactとして戻す。

同じdependencyを各containerでcold installするだけの並列化は避ける。CPU競合、registry待ち、重複downloadにより遅くなる。build-onceを分離する場合は`references/artifact-handoff.md`のone-hop contractを使い、consumerへrepository sourceを渡さない。

## 5. Tool orchestration

独立したhost tool callは`multi_tool_use.parallel`で同時実行する。独立したreviewは`subagent`のparallel modeで同時実行する。strong operationを並列実行する場合は、各callへ固有の次を割り当てる。

- operation ID。
- evidence directory。
- artifact directory。
- container name（helperが生成する）。
- timeout、CPU、memory budget。CPU/memoryは各operationの`resources`へ宣言し、環境変数overrideを使わない。

parallel wrapperを新たなsecurity boundaryとして扱わない。各child callは必ず既存の`run-strong-operation-apple-container.sh`を通す。

## 6. Failure batching

1つのreview findingごとにcandidateを作り直さない。並列review laneをすべて完了させ、互いに矛盾しないblockerを1つのrepair stageへまとめる。

strong operation失敗時は、同じcommandを即座に再実行しない。最初に最も早い失敗evidenceを読み、原因を次へ分類する。

- candidate defect。
- plan/script binding defect。
- missing tool/component。
- image/runtime defect。
- oracle defect。
- output contract defect。

同じ原因に対するretryは1回のrepairへ集約する。各operationはinitial attempt + 1 retry、workflowのbatch repairは1 cycleまでとする。operation contract、source tree、preflight evidence bindingの少なくとも1つが変化しないblind retryを拒否する。budget枯渇時はblockedまたはfailedにする。同じ論理的役割を新しいoperation IDへ改名してattempt budgetを回避しない。同じtaskを続ける場合は`workflow-efficiency.md`に従ってworkflow IDを維持し、split roleの失敗と依存descendantだけを再実行する。

再実行前に`validate-operation-evidence.mjs`を使う。current operation contract、source tree、schema-v2 status、schema-v2 receipt、output hashesが一致すればlaneを`reused`とし、historical plan SHAと元のelapsedMsを維持する。入力hashが変わったjobとdescendantだけを再実行する。

## 7. Rust/WebAssembly + Browser DAG

```text
plan + source draft
├─ semantic/gameplay review ──────────────┐
├─ accessibility/responsive review ───────┤
├─ lock resolve + dependency review ──────┤
└─ Rust/browser image preflight ──────────┘
                    ↓ batch repair + assembly
              candidate tree validation
                    ↓
 quality pipeline: fmt → test → clippy → wasm build → site artifact
                    ↓
              browser desktop/mobile smoke
                    ↓
├─ final semantic review ─────────────────┐
└─ evidence/provenance verification ──────┘
                    ↓
            one final patch → review → apply → hash
```

このDAGではquality pipeline内部を無理に並列化せず、その前後の待ち時間をfanoutする。

## 8. Reporting

execution reportへ次を残す。

- critical path。
- parallel groupsと最大concurrency。
- 各laneのinput hash、output path、`startedAtUtc`、`endedAtUtc`、monotonic integer `elapsedMs`、status。
- failureによりinvalidatedになったdescendant。
- 再利用したpassed evidence。
- allowed/consumed retry、failure classification、変更前後hash、budget exhaustion、batch repairで回避したretry数。

strong operationのreceipt timingはhelperが機械的に生成する。review、Tier A、workflow全体のtimingはorchestrator ledgerが記録する手動orchestration evidenceであり、receipt timingと同じ保証を主張しない。parallel laneのelapsedMsを単純加算してworkflow elapsedにしない。

cheap-to-expensive gate auditが必要な場合は`gate-reports.md`を読み、全strong roleをgateへ1対1で対応させる。global cost inversionにはgate固有の`orderExceptionReason`、dependency non-pass後の継続または全consumer attemptのobserved overlapにはedge固有の`exceptionReason`を要求する。gate reportは事後検証であり、schedulerやartifact publication controlとして扱わない。

`parallelized`を`verified`の同義語にしない。各laneの通常のcandidate、container、host、interactive statusを維持する。

## 9. Readinessとattemptの境界

source hash drift、immutable image起動失敗、required tool欠落はattempt予約前のreadiness failureとして扱う。readiness failureを新しいworkflow IDでretry budgetへ見せかけない。readinessを修正してから同じstable roleを開始する。workloadのnonzero exit、oracle failure、output contract failureだけをrole attemptへ記録する。
