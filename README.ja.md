<p align="center">
  <a href="./README.md">English</a> · <strong>日本語</strong>
</p>

<h1 align="center">just-bash Coding Sandbox</h1>

<p align="center">
  <strong>限定された権限で生成し、隔離環境で検証し、承認されたバイト列だけを適用する。</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="License: MIT"></a>
  <a href="skills/just-bash-coding-sandbox/SKILL.md"><img src="https://img.shields.io/badge/Agent-Skill-7c3aed?style=flat-square" alt="Agent Skill"></a>
  <a href="https://github.com/apple/container"><img src="https://img.shields.io/badge/runtime-Apple%20Container-111827?style=flat-square" alt="Runtime: Apple Container"></a>
</p>

`just-bash-coding-sandbox`は、信頼済み・レビュー済みのリポジトリに対するすべての操作をホストシェルへ直接渡さず、macOS上でコーディングエージェントのワークフローを実行するためのAgent Skillです。`just-bash`による権限を限定したファイル操作と、Apple Containerによるビルド、テスト、ブラウザ、PTY、ネイティブ実行の隔離を組み合わせます。

## クイックスタート

### 必要環境

- Apple silicon搭載Mac
- macOS 26以降
- [Apple Container](https://github.com/apple/container)
- Node.js

### インストール

[Vercel Skills CLI](https://github.com/vercel-labs/skills)を使ってインストールします。

```bash
npx skills add 53able/just-bash-coding-sandbox --skill just-bash-coding-sandbox
```

インストールせずに検出結果だけを確認する場合:

```bash
npx skills add 53able/just-bash-coding-sandbox --list
```

## このSkillが必要な理由

コーディングエージェントには、ファイルの調査、変更の生成、パッケージのインストール、コンパイル、ブラウザの起動、成果物の公開に必要なアクセス権が求められます。すべての工程へ同じホスト権限を与えると、レビューと復旧が難しくなります。

このSkillはworkflowを3つの境界へ分離します。

| 境界 | 目的 | 主な制約 |
|---|---|---|
| Tier A: `just-bash` + OverlayFs | textを調査しcandidateを生成する | repositoryを変更しない |
| Tier B: Apple Container | install、build、test、browser、PTY、native toolを実行する | image、network、tool、oracle、outputを明示する |
| Delivery | candidateをreviewして適用する | baseline-bound mutationとhash-boundなhuman approvalを要求する |

## できること

- 信頼済み・レビュー済みのリポジトリをホストシェルではなくcopy-on-write overlay経由で調査・編集する
- source、script、image、network、oracle、outputをSHA-256 operation contractへ束縛する
- promotion前にcandidateのexact post-imageを検証する
- package install、build、test、browser、PTY、native executableをApple Containerで実行する
- 新規Web UIワークフローでは、ブラウザ操作の検証と5つのviewport別検証を独立したroleへ分離する
- stable role、bounded retry、classified retry evidenceを強制する
- 同一workflow内で検証済みevidenceとone-hop artifactを再利用する
- deterministic review patch、application bundle、receipt、workflow reportを生成する

## ワークフロー

1. strict risk intakeを検証する。
2. baseline-bound mutationを含むv5 planを定義する。
3. `just-bash`とOverlayFsでcandidateを生成する。
4. candidateのexact post-image setを検証する。
5. Apple Containerでstrong operationを実行する。
6. evidence、retry accounting、artifact handoffを検証する。
7. deterministic review patchとapplication bundleを生成する。
8. 明示的なhuman approvalをreview済みartifactのhashへ束縛する。
9. 承認されたbytesを適用し、receiptとworkflow reportを発行する。

完全なagent向け手順は[`SKILL.md`](skills/just-bash-coding-sandbox/SKILL.md)を参照してください。

## セキュリティモデル

`just-bash`はcapability削減層であり、強いsecurity boundaryではありません。Apple Containerはstandard profileのprocess隔離境界ですが、すべてのlocal threatに対する保護を保証するものではありません。

未知・未レビューのリポジトリやコード、privileged実行、daemon、host socket、credential、hostile code、origin単位のegress制御が必要な処理は実行せず、`external-microvm`へrouteして停止します。

次の機能は現在の対象外です。

- external microVM backend
- cross-workflowまたはcross-host artifact reuse
- origin-enforced egress allowlist
- credential broker
- signed receiptまたはtrusted artifact store
- crash-safe filesystem transaction
- malicious same-user replacement、`SIGKILL`、process crash、電源断への保護

詳細は[`execution-policy.md`](skills/just-bash-coding-sandbox/references/execution-policy.md)を参照してください。

## 検証

Skillディレクトリでoffline self-testを実行できます。

```bash
cd skills/just-bash-coding-sandbox
sh scripts/self-test.sh
```

self-testはplan validation、risk intake、operation contract、evidence、artifact handoff、gate report、candidate/application bundle、browser role、failure path、exact manifest、file modeを検査します。

Vercel Skills CLIによるrepository layoutの検出も確認できます。

```bash
npx skills add . --list
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

Vercel Skills CLIが対応する`skills/<name>/SKILL.md`形式のcatalog layoutです。

## ライセンス

[MIT](LICENSE) © 2026 53able
