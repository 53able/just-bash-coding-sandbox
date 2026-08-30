<p align="center">
  <strong>English</strong> · <a href="./README.ja.md">日本語</a>
</p>

<h1 align="center">just-bash Coding Sandbox</h1>

<p align="center">
  <strong>Generate with reduced capabilities. Verify in an isolated container. Apply only approved bytes.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="License: MIT"></a>
  <a href="skills/just-bash-coding-sandbox/SKILL.md"><img src="https://img.shields.io/badge/Agent-Skill-7c3aed?style=flat-square" alt="Agent Skill"></a>
  <a href="https://github.com/apple/container"><img src="https://img.shields.io/badge/runtime-Apple%20Container-111827?style=flat-square" alt="Runtime: Apple Container"></a>
</p>

`just-bash-coding-sandbox` is an Agent Skill for running coding-agent workflows on a trusted, reviewed repository without handing every operation directly to the host shell. It combines capability-reduced file operations in `just-bash` with isolated build, test, browser, PTY, and native execution in Apple Container.

## Quick start

### Requirements

- A Mac with Apple silicon
- macOS 26 or later
- [Apple Container](https://github.com/apple/container)
- Node.js

### Install

Install with [Vercel Skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add 53able/just-bash-coding-sandbox --skill just-bash-coding-sandbox
```

Inspect the detected skills without installing:

```bash
npx skills add 53able/just-bash-coding-sandbox --list
```

## Why this exists

Coding agents need enough access to inspect files, generate changes, install packages, run compilers, open browsers, and publish results. Giving every step the same host privileges makes review and recovery difficult.

This Skill separates the workflow into three boundaries:

| Boundary | Purpose | Key constraint |
|---|---|---|
| Tier A: `just-bash` + OverlayFs | Inspect text and generate a candidate | Does not mutate the repository |
| Tier B: Apple Container | Install, build, test, run browsers, PTYs, and native tools | Uses explicit images, network policy, tools, oracles, and outputs |
| Delivery | Review and apply the candidate | Requires baseline-bound mutations and hash-bound human approval |

## Capabilities

- Inspect and edit a trusted, reviewed repository through a copy-on-write overlay instead of the host shell
- Bind source, script, image, network, oracle, and output metadata into a SHA-256 operation contract
- Validate exact candidate post-images before promotion
- Run package installation, builds, tests, browser checks, PTY checks, and native executables in Apple Container
- For new Web UI workflows, separate browser interaction checks from five viewport-specific checks
- Enforce stable roles, bounded retries, and classified retry evidence
- Reuse validated evidence and a one-hop artifact within the same workflow
- Produce deterministic review patches, application bundles, receipts, and workflow reports

## Workflow

1. Validate the strict risk intake.
2. Define a v5 plan with baseline-bound mutations.
3. Generate a candidate with `just-bash` and OverlayFs.
4. Validate the candidate's exact post-image set.
5. Run strong operations in Apple Container.
6. Validate evidence, retry accounting, and artifact handoff.
7. Generate a deterministic review patch and application bundle.
8. Bind explicit human approval to the reviewed artifact hashes.
9. Apply the approved bytes and emit a receipt and workflow report.

See the complete agent procedure in [`SKILL.md`](skills/just-bash-coding-sandbox/SKILL.md).

## Security model

`just-bash` is a capability-reduction layer, not a strong security boundary. Apple Container provides the process-isolation boundary for the standard profile, but this project does not claim protection against every local threat.

The workflow stops and routes the task to `external-microvm` when the repository or code is unknown or unreviewed, or when the task requires privileged execution, daemons, host sockets, credentials, hostile code, or origin-specific egress controls.

The following remain out of scope:

- An external microVM backend
- Cross-workflow or cross-host artifact reuse
- Origin-enforced egress allowlists
- Credential brokering
- Signed receipts or a trusted artifact store
- Crash-safe filesystem transactions
- Protection against malicious same-user replacement, `SIGKILL`, process crashes, or power loss

Read the detailed policy in [`execution-policy.md`](skills/just-bash-coding-sandbox/references/execution-policy.md).

## Validation

Run the complete offline self-test from the Skill directory:

```bash
cd skills/just-bash-coding-sandbox
sh scripts/self-test.sh
```

The self-test covers plan validation, risk intake, operation contracts, evidence, artifact handoff, gate reports, candidate and application bundles, browser roles, failure paths, the exact manifest, and file modes.

The repository layout is also discoverable by Vercel Skills CLI:

```bash
npx skills add . --list
```

## Repository layout

```text
skills/
└── just-bash-coding-sandbox/
    ├── SKILL.md
    ├── assets/
    ├── references/
    └── scripts/
```

This follows the `skills/<name>/SKILL.md` catalog layout supported by Vercel Skills CLI.

## License

[MIT](LICENSE) © 2026 53able
