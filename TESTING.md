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
When updating the matrix, keep `test/pi-versions.test.js` and
`ci/modal_ci.py` in sync; both workflows use the shared Modal matrix.

## Local unit and boundary tests

```sh
npm ci
npm test
```

After dependencies are installed, the tests do not install SDKs or use model
APIs. The release pin under test is `@opencode/codemode` **2.2.6** with Effect
**4.1.0**. Without
`PI_OPENCODE_SDK`, the `isolated real Pi SDK session` suite explicitly skips.
The boundary tests include literal 30-second
timeout and delayed-cleanup probes, so the suite takes at least 30 seconds.

## Full suite with an existing SDK

To use the SDK installed by `npm ci`:

```sh
PI_OPENCODE_SDK="$PWD/node_modules/@earendil-works/pi-coding-agent" npm test
```

Expected result: **94 passed, 0 skipped**, including the SDK suite's parent and
ten subtests. To run only the session suite:

```sh
PI_OPENCODE_SDK="$PWD/node_modules/@earendil-works/pi-coding-agent" node --test test/session.test.js
```

Expected result: **11 passed, 0 skipped**. You can also supply an absolute path to
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
**2.2.6** with Effect **4.1.0**. On Node **v22.23.4** (Linux x64), `npm test`
passed **83** tests, failed **0**, and skipped **1** (`isolated real Pi SDK
session` without `PI_OPENCODE_SDK`). With the SDK from `npm ci`
(`@earendil-works/pi-coding-agent` **1.3.0**), the same suite passed **94**,
failed **0**, and skipped **0**. `npm run test:pi-versions` passed **3** and
failed **0**: one full suite each for Pi **0.99.0**, **1.3.0**, and **1.4.0**
against installed CodeMode **2.2.6** and Effect **4.1.0**, with matching Pi TUI
versions. Each inner suite passed **94**, failed **0**, and skipped **0**.
The same clean-copy inner suites also passed on Node **v22.19.0** and
**v24.22.2** for those three Pi/TUI pairs. Hosted Modal CI for this pin has
not run.

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

## Modal-backed CI

Both GitHub workflows use the same pattern as `cloudroom-mcp`: GitHub Actions
checks out the revision, installs the pinned Python Modal SDK from
`ci/requirements.txt`, and dispatches work. **All Node/npm work runs on Modal**,
including the upstream version lookup, clean installs, full tests, and
`npm pack --dry-run --json`. There are no Node test jobs on GitHub runners.
Each workflow creates **one Modal app**, with six isolated Node/Pi calls running
in parallel inside it. This avoids Modal's app-creation rate limit. Every cell
finishes even if another fails; any failure fails the aggregate GitHub check.

**Branch protection migration:** if the old six `Node … / Pi …` checks are
required, replace them with `Node/Pi compatibility on Modal`. The upstream
workflow reports `Latest CodeMode compatibility on Modal`.

`ci/modal_ci.py` uses `node:22.19.0-bookworm-slim` and
`node:24-bookworm-slim` with Python 3.11. Each test function has 1 CPU, 2 GiB
memory, a 10-minute timeout, and no automatic retries. Each cell also runs the
Python CI regression tests. Only package inputs, tests, and the CI Python files
are uploaded; `.env`, `.git`, `.pi`, and local `node_modules` are excluded.
The existing harness still installs dependencies in disposable copies, with
lifecycle scripts disabled; there is no dependency tree shared between runs.
Remote failures propagate to the GitHub check. Modal compute may incur costs.

### One-time setup

Create a Modal CI/service-user token and add these repository or organization
Actions secrets (organization secrets must grant this repository access):

- `MODAL_TOKEN_ID`
- `MODAL_TOKEN_SECRET`

Missing tokens fail with an explicit setup error. Fork PR events are skipped
because GitHub does not expose secrets to them; `pull_request_target` is not
used. Same-repository PRs and pushes to main run normally. For a fork change,
use the trusted post-merge push check or manually dispatch a trusted ref.
Do not manually run untrusted code with Modal credentials.

### Local reproduction

With Python 3.11 and a configured Modal profile (or the two token environment
variables), from the repository root:

```sh
python -m pip install -r ci/requirements.txt
python -m unittest discover -s ci -p 'test_*.py'
modal run ci/modal_ci.py::matrix
modal run ci/modal_ci.py::matrix --upstream
modal run ci/modal_ci.py::run_tests --node-version 22.19.0 --pi-version 1.4.0
modal run ci/modal_ci.py::run_tests --node-version 24.x --pi-version 1.4.0 --upstream-version 2.2.5
modal run ci/modal_ci.py::latest
```

The last command resolves npm latest remotely without running tests. The upstream
matrix also resolves latest once, then sends that same exact version to all six
remote calls. Its local entrypoint writes the version to `GITHUB_OUTPUT` and
`GITHUB_STEP_SUMMARY`; CLI runs outside Actions do not require those files.

### Migration verification — 2026-11-03

Manual Modal runs passed all six release-pinned cells and all six upstream cells
on Node **22.19.0 / 24.22.2** × Pi **0.99.0 / 1.3.0 / 1.4.0**, with CodeMode
**2.2.5** (also npm latest at lookup time). Every cell passed the full SDK suite
with no skips, the **13 Python CI regression tests**, and package dry-run.

- [Release-pinned matrix](https://modal.com/apps/hyein-sophia-cho/main/ap-XKXGxw47V5BafNqvoEtUBN)
- [Latest-upstream matrix](https://modal.com/apps/hyein-sophia-cho/main/ap-JmMQ9t9krgC4Bc46EaO2Jl)

Both apps completed and stopped. The GitHub output/summary files, workflow
syntax (`actionlint`), and whitespace checks were also verified. These manual
runs do not mean GitHub Actions secrets or branch protection are configured.

## Post-merge latest-upstream check

`.github/workflows/upstream-codemode.yml` automatically runs its latest-version
checks when a same-repository PR **authored by `cursor[bot]` is merged into main**.
Fork PR events are skipped because they cannot access the Modal token. Manual runs
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
dependency for all authors on trusted events (see the fork policy above).

Each run queries the public npm registry on Modal for `@opencode/codemode@latest`, then
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

## 0.1.5 release verification — 2026-10-28

On macOS arm64 with Node **26.12.1** and CodeMode **2.2.0**, the full suite
passed **93 tests, 0 failures, 0 skips**. Clean disposable installs also passed
the full suite against Pi **0.99.0 / 1.3.0 / 1.4.0**, with no skips.

Regression coverage includes direct `String.raw` templates with heredocs,
backslashes, invalid cooked escapes, Unicode, and awaited substitutions;
non-admitted tags and Pi-only expressions still fail before earlier host effects.
README examples run only safe in-memory host stubs. Real SDK sessions retain raw
text and model-visible recovery suggestions. Error/warning suggestions remain
within diagnostic/final-output budgets. Rendering tests cover hidden failures,
partial/expanded views, narrow widths, and the absence of total/success counts
or zero-failure summaries; cancelled attempts do not count as failures.

These are local checks, not new Node **22.19.0 / 24.x** hosted CI evidence, a
live-provider/model walkthrough, or a fresh benchmark. No release or publication
is performed by these test commands.

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

These are historical local results, not evidence of a hosted CI run. CI now
executes on Modal's Debian-based Node images, with GitHub Actions only dispatching
work. The Node 24.x image follows the 24.x line, while the minimum Node version
is pinned exactly.

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
