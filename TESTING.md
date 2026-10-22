# Lifecycle/output regression evidence

Baseline: `9edcea51b4527d78603692abe351a10449c516d2` (before implementation).
Runtime used: Node 26.12.1, `@opencode/codemode` 2.1.0, Effect 4.0.1,
TypeBox 1.3.27. Dependencies were reused from existing local installations via
ignored `node_modules` links; no install, lockfile update, global configuration
change, real mutation tool, or paid model call was needed.

## Failure first

The new boundary suite ran against the unchanged implementation alongside the
four original tests: **4 passed, 16 failed** (including nested subtests).
The original four tests still passed. Failures cover host abort/settlement,
missing warnings/truncation, escaping/UTF-8 expansion, logs, and large errors.

An actual isolated Pi **1.4.0** session also reproduced the lifecycle defects:
root success/deadline with `nestedCalls.complete: false`, nested status
`unfinished`, and no visible warning for an unhandled rejection. Original
handoff probes separately captured Pi 1.3.0 and the 131,166-byte backslash output.

Local baseline logs (outside Git; retained, not overwritten):

- `/tmp/pi-opencode-before-unit.log`
- `/tmp/pi-opencode-before-sdk-1.4.0.log`
- `/tmp/pi-opencode-review-probes.log`
- `/tmp/pi-opencode-review-timeout.log`
- `/tmp/pi-opencode-review-sdk.log`

## After implementation

- `npm test`: **22 passed, 0 failed**, 1 explicit SDK-suite skip when
  `PI_OPENCODE_SDK` is unset. No SDK install is part of this command now.
- Real Pi SDK **1.3.0** and **1.4.0** session suites: **7 passed, 0 failed each**
  (parent plus six subtests).
- Early return, race loser, outer user abort, and the literal 30,000 ms deadline
  abort cancellation-aware stubs. Asynchronous cleanup settles before root
  delivery. Cancellation during Pi's hooks may stop a call before its host body
  starts; that is also a completed audit entry, not an unfinished call.
- Cancellation/deadline records now have `nestedCalls.complete: true` and
  terminal status `error` rather than `unfinished`. Stubs did not increment
  their delayed-completion counters after root return. Awaited/parallel calls
  still finish with `ok` entries.
- Real sessions preserve permission denials, schema validation, modified result
  hooks, and an additive active built-in `codemode`. No routing or fallback.
- Unhandled promise rejection and a safely blocked unawaited nested tool are
  visible in the transcript and details, without changing upstream success
  semantics. A unit probe also checks timeout-cleanup warnings after the
  program already returned (30,050 ms asynchronous cleanup).
- Backslash output is now **65,536 bytes**, visibly and structurally truncated.
  Tests cover quotes, newlines, NUL escaping, ASCII, astral/mixed Unicode,
  logs plus return, huge errors, crowded-out warnings, wrapper catch errors,
  and exact-limit complete JSON. Structured diagnostics are checked separately
  against the documented 8 KiB budget.
- Structured/text/multimodal host-return behavior is covered by unit stubs.

Local final logs:

- `/tmp/pi-opencode-final-unit.log`
- `/tmp/pi-opencode-final-sdk-1.3.0.log`
- `/tmp/pi-opencode-final-sdk-1.4.0.log`

Reproduce session tests against each locally installed SDK:

```sh
PI_OPENCODE_SDK=/absolute/path/to/SDK/package node --test test/session.test.js
```

The suite does not download SDKs. It creates disposable cwd/agent directories,
in-memory settings/history, disables personal resource discovery and model
network refresh, supplies only a fake runtime key, and replaces the model
stream with scripted messages. It registers only safe in-memory host stubs;
the built-in codemode is registered but never executed. Session directories
are removed in `finally`.

## Limits of this evidence

This is not a security certification, benchmark, all-version compatibility
claim, or actual-model E2E test. No independent benchmark repository was
changed or created. The install-enabled historical version matrix was not run.
No external CodeRabbit/model review was requested during this implementation
run, to avoid auth/billing use; the earlier zero-finding review did not detect
these defects. Changes were checked locally against the regression scenarios.

The final text bound is not a whole-transcript/heap bound. Upstream may allocate
large values before bounding them. Host cancellation is cooperative and host
cleanup is awaited; a non-settling host can still hang delivery. Cancellation
cannot undo completed side effects. No automatic retry/replay was added.
