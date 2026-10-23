# Testing and compatibility

## Requirements and supported range

- Node.js **>= 22.19.0**.
- Pi and Pi TUI **>= 0.99.0, < 2.0.0**, with matching versions.
- CI covers Node **22.19.0 / 24.x** × Pi **0.99.0 / 1.3.0 / 1.4.0**.

Pi 0.99.0 is the minimum supported version: it introduced the callable-tool
context and native `codemode` used by this extension. The original loader/mock
matrix also covered 0.99.1, 0.99.2, and 1.0.0; those older checks were narrower
than full scripted sessions. The current release gates cover 0.99.0, 1.3.0, and
1.4.0 with the full suite. This CI matrix is not a restriction of the supported
range or a claim that every intermediate release has been individually tested.
Add newer baselines to both `test/pi-versions.test.js` and
`.github/workflows/ci.yml` when updating the matrix.

## Local unit and boundary tests

```sh
npm ci
npm test
```

After dependencies are installed, the tests do not install SDKs or use model
APIs. Without `PI_OPENCODE_SDK`, the session suite explicitly skips: the current
result is **41 passed, 1 skipped**. The boundary tests include literal 30-second
timeout and delayed-cleanup probes, so the suite takes at least 30 seconds.

## Full suite with an existing SDK

To use the SDK installed by `npm ci`:

```sh
PI_OPENCODE_SDK="$PWD/node_modules/@earendil-works/pi-coding-agent" npm test
```

Expected result: **49 passed, 0 skipped**, including the SDK suite's parent and
seven subtests. To run only the session suite:

```sh
PI_OPENCODE_SDK="$PWD/node_modules/@earendil-works/pi-coding-agent" node --test test/session.test.js
```

Expected result: **8 passed, 0 skipped**. You can also supply an absolute path to
another installed SDK package directory. For an exact dependency-version test,
use the clean-copy matrix below rather than mixing a local host installation
with another SDK directory.

## Clean-copy compatibility matrix (network/install enabled)

```sh
npm run test:pi-versions
```

This opt-in command installs from npm. For each supported baseline it:

1. Copies only package files, the lockfile, and tests into a unique temp directory.
2. Runs `npm ci --ignore-scripts`, then installs the exact matching Pi/TUI version
   without saving it or changing the lockfile.
3. Verifies the installed versions and runs `npm test` with `PI_OPENCODE_SDK` set,
   so the full real-session suite runs instead of skipping.
4. Removes the temp directory in `finally`, even on failure.

It does not alter the source checkout's dependencies or personal Pi settings.
To test one baseline (the same command used in each CI job):

```sh
PI_OPENCODE_TEST_VERSION=0.99.0 npm run test:pi-versions
PI_OPENCODE_TEST_VERSION=1.3.0 npm run test:pi-versions
PI_OPENCODE_TEST_VERSION=1.4.0 npm run test:pi-versions
```

CI runs these against both configured Node versions. Dependency lifecycle
scripts are deliberately disabled in this harness; ordinary checkout installs
still use `npm ci`. No paid model calls, npm publication, release creation, or
repository visibility changes are part of CI.

## 0.1.0 preparation evidence

The clean-copy matrix was reproduced locally on macOS:

| Node | Pi | Full suite |
| --- | --- | --- |
| 22.19.0 | 0.99.0 | 49 passed, 0 skipped |
| 22.19.0 | 1.3.0 | 49 passed, 0 skipped |
| 22.19.0 | 1.4.0 | 49 passed, 0 skipped |
| 24.22.1 | 0.99.0 | 49 passed, 0 skipped |
| 24.22.1 | 1.3.0 | 49 passed, 0 skipped |
| 24.22.1 | 1.4.0 | 49 passed, 0 skipped |

These are local results, not a claim that hosted CI has already run. The new
workflow runs on Ubuntu after it is pushed. The Node 24.x job follows the latest
24.x patch, while the minimum Node version is pinned exactly.

## Coverage

- Fresh execution and bridge behavior: structured/text returns, error handling,
  unsupported multimodal results, and exclusion of both code tools from guests.
- Static routing: Pi-only globals/options, supported syntax, source/AST limits,
  preflight rejection before any host effect, and no automatic replay.
- Lifecycle: early return, race losers, user abort, literal deadline, and awaited
  cooperative host cleanup, including Pi hooks and completed nested-call audits.
- Output: final UTF-8/JSON-escaping bounds, Unicode, logs, huge errors, visible
  warnings, structured diagnostic budgets, and incomplete-preview indicators.
- TUI: highlighted source, visual-line collapse/expansion, narrow Unicode output,
  whitespace, duration, legacy/partial results, and component reuse/invalidation.
  Native parity compares shared ordinary/expanded output; older native renderers
  need not implement the extension's timer or visual-line collapse.
- README: execute the documented JavaScript snippets with safe in-memory tools,
  including synchronous discovery signatures and pagination.

Session tests create disposable cwd/agent directories, in-memory settings and
history, and scripted assistant streams. Model-network discovery is disabled;
only fake runtime credentials and safe in-memory host stubs are used. Native
`codemode` is registered but never executed. No personal resources are loaded.

## Additional release checks

```sh
npm audit
npm pack --dry-run --json
git diff --check
```

Inspect the package file list for accidental secrets, local state, or missing
runtime modules. `npm audit` checks known advisories, not all security risks.
The maintainer's final steps are in the
[release checklist](https://github.com/hyein-cbio/pi-opencode-mode/blob/main/.github/RELEASE_CHECKLIST.md).

## Limits

This is not a security certification, benchmark, manual terminal-capture test,
or live-provider/model E2E test. Scripted sessions verify SDK integration, not
whether a particular model chooses the tool correctly.

The final output-text bound is not a heap or whole-transcript bound. Host
cancellation is cooperative and cleanup is awaited: a non-settling tool can
still hang delivery. Completed side effects cannot be rolled back, and failed
programs are never automatically replayed. See [SECURITY.md](SECURITY.md).
