# Interactive Validation

Use this only when `delivery.interactive.required: true`. The v5 contract must declare `runner: host | container`, an exact non-empty `command`, non-empty `terminalType`, positive `rows` and `columns`, and non-empty `oracles`. A host runner additionally requires `delivery.hostRuntime.required: true` and an exact matching entry in `hostRuntime.commands`. When interactive delivery is not required, use `runner: none`, empty command/terminal/oracles, and zero dimensions.

## Required PTY/TTY Checks

- Launch the exact declared command with the declared runner in a real PTY/TTY using the declared terminal type and minimum dimensions.
- Confirm startup reaches the expected screen or prompt without hanging.
- Send representative input and observe every declared oracle.
- Exercise the documented quit path and bounded exit.
- Verify echo, cursor visibility, alternate-screen state, and input mode are restored after normal quit and forced termination.
- Resize when applicable and confirm redraw, bounds, and input.
- Capture runner, command, terminal type, dimensions, input, oracles, exit code, timeout, resize, and restoration evidence.

## Delivery Receipts

`aggregate-workflow-report.mjs`へ渡すhost runtime receiptはschema v2とし、exact fields `schemaVersion,status,authority,provenance,workflowId,planSha256,startedAtUtc,endedAtUtc,elapsedMs,commands`を持たせる。`status: passed`、`authority: host`、`provenance: declared-host-runtime-validation`を使い、`commands`へplanと同じ順序で`{command,exitCode,startedAtUtc,endedAtUtc,elapsedMs}`を記録する。全exit codeを0にする。commandを実行していない場合はreceiptを作らない。

interactive receiptもschema v2とし、exact fields `schemaVersion,status,authority,provenance,workflowId,planSha256,startedAtUtc,endedAtUtc,elapsedMs,runner,command,terminalType,rows,columns,oracles`を持たせる。`provenance: declared-interactive-validation`を使い、runner、command、terminal、dimensions、oraclesをplanとexact一致させる。観察していないoracleを記録しない。これらのcaller-owned receiptはprovenanceであり、malicious same-userへの認証ではない。

## Status Rule

Record `interactive-verified` only when every declared check passes. Otherwise record `unverified` with the missing runner, input, resize, quit, or restoration evidence. Container success, snapshots, unit tests, and piped stdin never imply interactive success.
