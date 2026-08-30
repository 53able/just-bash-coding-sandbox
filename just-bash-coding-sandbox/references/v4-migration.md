# Execution Plan v1–v4 to v5 Migration

v1〜v4 planを実行または成功evidenceとして再利用しない。次の順序でv5 workflowを新規作成する。

1. `assets/execution-plan.json`を複製し、`version: 5`、stable `workflowId`、`runtime {provider: apple-container, scope: local-macos-only}`を設定する。
2. 旧expected targetをstable ID付き`changeSet.mutations`へ変換する。`add`は`beforeSha256: null`、`modify | delete | rename`はbaseline fileのexact SHA-256を使う。renameは`from`と`to`を指定する。
3. `candidateStage.expectedTargets`を`candidateStage.mutationIds`へ置き換える。promotable stageでは全mutation IDを含める。
4. `candidateExports`をpost-imageだけにする。add／modifyは`path`、renameは`to`を含め、deleteとrenameの`from`にtombstoneを作らない。
5. 各strong operationへworkflow内でuniqueかつretry間でstableな`roleKey`を追加する。operation IDをrole identityとして使わない。
6. immutable image、script hash、source hash、PATH、required tools、resources、network、timeout、oracles、exact outputsを再確認する。
7. browser taskではrepository非依存`browser-preflight`とtransitive evidence bindingを作り直す。
8. schema-v2 attempt ledgerを新規作成する。v1 ledgerを移植せず、`workflowId + roleKey`でinitial + 1 retryを数える。
9. `node scripts/validate-execution-plan.mjs <plan>`を実行する。high-risk／daemon／privileged taskは`external-microvm`としてblockedにし、このskillで実行しない。
10. Tier A、schema-v2 candidate validation、schema-v2 operation contract、schema-v2 status/receiptを新規生成する。旧status／receiptを変換しない。
11. baseline-bound patchを生成し、exact patch SHA-256への明示承認後だけtransactional host application helperを使う。
12. workflow aggregatorでcandidate、container、host application、host runtime、interactive statusを別々に記録する。

完了条件:

- v5 validatorがpassし、v1〜v4がrejectされる。
- 全mutation preimageとpost-imageが拘束される。
- operation ID改名でrole retry budgetをresetできない。
- delete／rename candidateにtombstoneがない。
- human approval JSONがplan、candidate validation/tree、review patch、patch-review、application bundleを拘束し、schema-v2 host application receiptが同じhash群と全mutation post-imageを拘束する。
- container successをhost-runnableまたはinteractive-verifiedへ昇格していない。
