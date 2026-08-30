# just-bash Coding Sandbox

`just-bash`による限定的なファイル操作とApple Containerによる隔離実行を組み合わせ、コーディングエージェントの変更生成・検証・承認・適用を分離するAgent Skillです。

## できること

- 未知のリポジトリを直接host shellへ渡さず、copy-on-write overlay上で調査・変更する
- package install、build、test、browser、native executableをApple Container内で実行する
- source、script、image、network、oracle、outputをSHA-256でoperation contractへ束縛する
- candidate validation、patch review、明示承認を経てhostへtransactionalに適用する
- stable roleとretry budgetを使い、blind retryやoperation IDによるbudget resetを拒否する
- Web UIのinteraction検証と5 viewport検証を独立したroleへ分割する
- 同一workflow内で検証済みevidenceとone-hop artifactを再利用する

## 必要環境

- macOS
- [Apple Container](https://github.com/apple/container)
- Node.js

このSkillはlocal macOSとApple Containerを対象にしています。privileged処理、daemon、host socket、credential、hostile code、origin単位のegress制御が必要な処理は実行せず、`external-microvm`として停止します。

## インストール

[Vercel Skills CLI](https://github.com/vercel-labs/skills)を使います。

```bash
npx skills add 53able/just-bash-coding-sandbox --skill just-bash-coding-sandbox
```

インストール前に検出結果だけを確認する場合:

```bash
npx skills add 53able/just-bash-coding-sandbox --list
```

## リポジトリ構造

```text
skills/
└── just-bash-coding-sandbox/
    ├── SKILL.md
    ├── assets/
    ├── references/
    └── scripts/
```

`skills/<name>/SKILL.md`はVercel Skills CLIの標準的なcatalog layoutです。

## ワークフロー概要

1. strict risk intakeを検証する
2. baseline-bound mutationを含むv5 planを作る
3. just-bashとOverlayFsでcandidateを生成する
4. Apple Containerでbuild、test、browser、PTYなどを検証する
5. evidence、artifact、retry ledgerを検査する
6. deterministic review patchとapplication bundleを作る
7. hash-boundなhuman approvalを取得する
8. hostへ適用し、receiptとworkflow reportを発行する

詳細な手順は[`SKILL.md`](skills/just-bash-coding-sandbox/SKILL.md)を参照してください。

## セキュリティ境界

`just-bash`はcapability削減層であり、強いsecurity boundaryではありません。Apple Containerも、悪意あるsame-user process、`SIGKILL`、process crash、電源断、署名されていないlocal receiptに対する完全な保証を提供するものとして扱いません。

次の機能は現在の対象外です。

- external microVM backend
- cross-workflowまたはcross-host artifact reuse
- origin-enforced egress allowlist
- credential broker
- signed receipt / trusted artifact store
- crash-safe filesystem transaction

## 検証

Skillディレクトリでself-testを実行できます。

```bash
cd skills/just-bash-coding-sandbox
sh scripts/self-test.sh
```

self-testはplan、risk intake、contract、evidence、artifact handoff、gate report、candidate/application bundle、browser role、manifest、file modeの互換性とfailure pathを検査します。

## License

[MIT License](LICENSE)
