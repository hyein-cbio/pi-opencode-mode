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
APIs. The release pin under test is `@opencode/codemode` **2.2.0**. Without
`PI_OPENCODE_SDK`, the session suite explicitly skips: the current result on
Node **v22.23.4** is **77 passed, 0 failed, 1 skipped** (78). The skip is
`isolated real Pi SDK session`. The boundary tests include literal 30-second
timeout and delayed-cleanup probes, so the suite takes at least 30 seconds.

## Full suite with an existing SDK

To use the SDK installed by `npm ci`:

```sh
PI_OPENCODE_SDK="$PWD/node_modules/@earendil-works/pi-coding-agent" npm test
```

Expected result: **87 passed, 0 skipped**, including the SDK suite's parent and
nine subtests. To run only the session suite:

```sh
PI_OPENCODE_SDK="$PWD/node_modules/@earendil-works/pi-coding-agent" node --test test/session.test.js
```

Expected result: **10 passed, 0 skipped**. You can also supply an absolute path to
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
The release pin this command installs and verifies is `@opencode/codemode`
**2.2.0**. On Node **v22.23.4**, `npm run test:pi-versions` passed **3** tests
and failed **0**, one full suite each for Pi **0.99.0**, **1.3.0**, and
**1.4.0**, with no skipped tests inside those suites.

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

## Post-merge latest-upstream check

`.github/workflows/upstream-codemode.yml` automatically runs its latest-version
checks when a PR **authored by `cursor[bot]` is merged into main**. Manual runs
are also available through `workflow_dispatch`, independently of PR authorship.
There is no weekly schedule. Closing a PR without merging, or merging a PR
from another author, skips the automatic lookup and test matrix. The author is
checked through `github.event.pull_request.user.login`, not `github.actor` or
`merged_by.login`: a human can merge a Cursor-authored PR and still trigger
the checks. PR #1 was verified through the GitHub REST API as authored by
`cursor[bot]` (the CLI GraphQL view displays this identity as `app/cursor`).

For PR events, checkout is pinned to the merged revision; manual runs use the
selected ref at dispatch time. Each qualifying PR gets its own run without a
shared concurrency group dropping queued checks. This is
separate from normal push/PR CI, which continues to test the release-pinned
dependency for all authors.

Each run queries the public npm registry for `@opencode/codemode@latest`, then
uses that exact resolved version across all six Node/Pi combinations. Registry
lookup/install failures fail the check; there is no fallback to the pinned
version. Each clean-copy run verifies the installed CodeMode version before
running the full suite, including real SDK sessions with no skips. Versions
are recorded in the job summary and test diagnostics. A new upstream version
may fail installation, engine checks or tests; that is a compatibility signal,
not a reason to skip it or silently select an older version.

To reproduce one combination locally (network/install enabled):

```sh
latest=$(npm view @opencode/codemode@latest version --registry=https://registry.npmjs.org/ --prefer-online) &&
  PI_OPENCODE_TEST_VERSION=1.4.0 PI_OPENCODE_UPSTREAM_VERSION="$latest" npm run test:pi-versions
```

`PI_OPENCODE_UPSTREAM_VERSION` must contain an exact version, not `latest` or a
version range. Without it, the harness tests the release-pinned CodeMode as
before. Candidate installs happen only in disposable copies, with lifecycle
scripts disabled and manifest/lockfile preservation checked. This workflow
never updates dependencies in the repository, merges PRs, creates releases or
publishes to npm. Passing CI is evidence for a reviewed update, not automatic
approval for deployment.

Local validation on 2026-10-25 used Node **26.12.1** and actual upstream
CodeMode **2.1.4** against Pi **0.99.0 / 1.3.0 / 1.4.0**; all three full suites
passed without skips. This is not a claim that the new hosted workflow has
already run. Cancellation timing tests compare recorded duration with measured
host/cleanup elapsed time rather than a nominal timer-delay floor.

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

## 0.1.1 release verification — 2026-10-24

On macOS with Node **26.12.1**, the clean-copy matrix passed the full suite
without skips against Pi **0.99.0**, **1.3.0**, and **1.4.0**. The GitHub CI
matrix separately gates Node **22.19.0 / 24.x** before publication.

`npm audit --omit=peer` reports **0 vulnerabilities** for the non-peer dependency
tree. Full `npm audit` reports **1 moderate / 1 high** dependency entry from the
locked test host Pi **1.3.0** and its exact **undici 8.10.2** dependency. Those
host packages are not bundled in this extension's tarball; managed Pi installs
supply them. This release does not override or downgrade the host to suppress
those advisories. Keep the host installation updated independently.

## 0.1.2 release verification — 2026-10-25

On macOS arm64 with Node **26.12.1**, clean disposable installs passed the full
suite, including isolated SDK sessions, against Pi **0.99.0**, **1.3.0**, and
**1.4.0**, with no skips. The suite now contains **76 passing tests**. GitHub CI
separately gates Node **22.19.0 / 24.x** across those same three Pi baselines.

The package includes both new runtime modules (`call-log.js` and
`source-preview.js`); no additional formatter dependency is required. Tests
cover call snapshots, duplicate names, statuses, cancellation cleanup, source
layout and original-source preservation. Rendering checks use safe fixtures,
not a live-provider/model walkthrough or a new performance measurement.

`npm audit --omit=peer` reports **0 vulnerabilities**. Full `npm audit` still
reports **1 moderate / 1 high** entry through the locked test host Pi **1.3.0**
and **undici 8.10.2**, as documented for 0.1.1. These host packages are not bundled
in the extension tarball; this patch does not downgrade the host or change the
dependency lock tree to suppress those advisories.

## 0.1.3 release verification — 2026-10-25

On macOS arm64 with Node **26.12.1**, `npm ci` followed by the full suite with
an explicit local SDK passed **82 tests, 0 failures, 0 skips**. Regression tests
cover regular-expression literals and all supported flags, malformed patterns
rejected before host calls, the previously rejected log-extraction program with
safe host stubs, and panel-background preservation through row truncation and
wrapping. No live-provider/model walkthrough or new benchmark was performed.

The implementation commit `a76c79f` passed all six hosted CI combinations:
Node **22.19.0 / 24.x** with Pi **0.99.0 / 1.3.0 / 1.4.0**. Release metadata is
verified separately by the CI run on the release commit before publication.

`npm audit --omit=peer` reports **0 vulnerabilities**. Full `npm audit` retains
the previously documented **1 moderate / 1 high** entry through the locked test
host and undici; neither host package is bundled in the extension tarball.
`npm pack --dry-run --json` includes only the 11 intended package files.

## 0.1.4 release verification — 2026-10-26

On macOS arm64 with Node **26.12.1** and CodeMode **2.1.4**, the full suite
passed **87 tests, 0 failures, 0 skips**. Clean disposable installs also passed
the full suite against Pi **0.99.0 / 1.3.0 / 1.4.0**, with no skips. Hosted
Node **22.19.0 / 24.x** checks gate the release commit separately.

Regression coverage keeps `for...in` rejected before runtime construction or
earlier host effects, including inherited-property and deleted-key cases.
`switch`/fall-through and the admitted constructors execute against the pinned
runtime. Prompt tests name both model-only code tools explicitly and retain
ordinary `bash`/`edit` host-call coverage. CodeRabbit reviewed the implementation
diff with no remaining findings. No live-provider/model walkthrough or fresh
benchmark was performed.

`npm audit --omit=peer` reports **0 vulnerabilities**. Full audit retains the
known **1 moderate / 1 high** dependency entries through the locked test host
and undici; neither is bundled in the extension tarball. The package file list
remains the same 11 intended files.

## Coverage

- Fresh execution and bridge behavior: structured/text returns, error handling,
  unsupported multimodal results, and exclusion of both code tools from guests.
- Model guidance: conditional OpenCode preference and native-first exceptions;
  real-SDK default prompt inclusion only while declared and active, no duplicate
  guidelines on repeated activation, and no guidance when the extension is absent.
  Native-inactive loadouts retain the explicit availability caveat.
- Compatibility-only preflight: Pi-only globals/options, supported syntax,
  source/AST limits, rejection before any host effect, and no automatic replay.
  Tool selection is explicitly assigned to the LLM context; the legacy advisory
  API is preserved but is not called by the extension execution path.
- Parser diagnostics: raw LF/CR/CRLF in quoted strings versus escaped newlines,
  heredoc/Korean multi-call fixtures with in-memory tools only, UTF-16 offsets
  and CRLF line positions, bounded original messages without stack retention,
  parser exception injection, and syntax versus unsupported-syntax separation.
  Isolated SDK sessions verify syntax rejection before even earlier host calls
  and preserve escaped-source results without repair or native delegation.
- Lifecycle: early return, race losers, user abort, literal deadline, and awaited
  cooperative host cleanup, including Pi hooks and completed nested-call audits.
- Output: final UTF-8/JSON-escaping bounds, Unicode, logs, huge errors, visible
  warnings, structured diagnostic budgets, and incomplete-preview indicators.
- Host-call presentation: live detached snapshots, invocation ordering with
  duplicate names, handled failures, cleanup-aware cancellation, bounded previews
  without result retention, and observers that cannot change tool behavior. Real
  SDK sessions check live updates and stored call metadata/source preservation.
- Source layout: display-only AST-boundary formatting, original-source expansion,
  literal/comment/template preservation, ASI/structural equivalence, invalid or
  incomplete input fallback, and repaint/cache behavior.
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
