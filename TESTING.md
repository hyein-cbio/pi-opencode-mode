# Testing and compatibility

## Requirements and supported range

- Node.js **>= 22.19.0** for CodeMode **2.3.0**; use **Node.js >= 24** for
  npm latest, which currently depends on `psychoscript`.
- Pi and Pi TUI **>= 0.99.0, < 2.0.0**, with matching versions. CI covers the
  minimum **0.99.0** and the locked **1.5.0** pair, not every Pi release.
- The [`package.json`](package.json) dependency records the only two runtime
  endpoints: the locked legacy baseline and the latest verified release. The
  installer and runtime read both from this declaration. CI resolves npm
  latest dynamically rather than testing a list of intermediate versions.

## Default development baseline and host security

The default `npm ci` tree locks matching **Pi/TUI 1.5.0**. CI also tests the
minimum Pi/TUI **0.99.0** without narrowing the public **>= 0.99.0, < 2.0.0**
peer range.
The checkout lockfile uses CodeMode **2.3.0** as the baseline. The installer
saves an exact selected version in a private npm project; the extension's npm
range allows that selection, and its runtime allowlist gates guest execution.
Effect **4.1.0**, Acorn **8.15.0**, and the default Pi/TUI lockfile are
unchanged. CodeMode 2.4.x moves the interpreter into its `psychoscript` dependency,
which declares **Node.js >= 24**. CI runs with `engine-strict` enabled and
does not run the npm-latest lane on Node 22.

For the default environment, check the **full** dependency tree, including peers:

```sh
npm ci
npm audit --audit-level=moderate
PI_OPENCODE_SDK="$PWD/node_modules/@earendil-works/pi-coding-agent" npm test
```

The matrix harness runs this audit gate immediately after its clean default
install and before replacing Pi/TUI with an older pair. Moderate/high findings
fail that default-baseline check. It does not audit or automatically fix the
intentionally old compatibility tree after the override. No `audit fix`,
transitive dependency override or minimum-peer increase is used to hide alerts.

An unbundled peer is not necessarily harmless: users running a vulnerable host
can still be affected. Recommend an up-to-date matching Pi/TUI pair within the
supported range. Functional compatibility with older SDKs is not a security
recommendation or a promise that those host dependencies are patched. Dated
1.3.0 audit/release records below describe historical states, not the new default.

## Local unit and boundary tests

```sh
npm ci
npm test
```

After dependencies are installed, the tests do not install SDKs or use model
APIs. With the checkout lockfile this tests `@opencode/codemode` **2.3.0** and
Effect **4.1.0**. Without `PI_OPENCODE_SDK`, the `isolated real Pi SDK session`
suite explicitly skips.
The boundary tests include literal 30-second
timeout and delayed-cleanup probes, so the suite takes at least 30 seconds.

## Full suite with an existing SDK

To use the SDK installed by `npm ci`:

```sh
PI_OPENCODE_SDK="$PWD/node_modules/@earendil-works/pi-coding-agent" npm test
```

Expected result: **130 passed, 0 skipped**, including SDK sessions and the
CodeMode version and serialization regressions. To run only the session suite:

```sh
PI_OPENCODE_SDK="$PWD/node_modules/@earendil-works/pi-coding-agent" node --test test/session.test.js
```

Expected result: **13 passed, 0 skipped**. You can also supply an absolute path to
another installed SDK package directory. For an exact dependency-version test,
use the clean-copy matrix below rather than mixing a local host installation
with another SDK directory.

## Clean-copy compatibility matrix (network/install enabled)

```sh
npm run test:pi-versions
```

This opt-in command installs from npm. For each supported baseline it:

1. Copies only package files, the lockfile, and tests into a unique temp directory.
2. Runs `npm ci --ignore-scripts` and verifies that the installed Pi/TUI
   (**1.5.0**) and CodeMode (**2.3.0**) match the lockfile.
3. Runs `npm audit --audit-level=moderate` on that default tree, **including
   peers**, before any override.
4. Installs the exact Pi/TUI and CodeMode versions if they differ from the
   default, without saving changes to the manifest or lockfile.
5. Verifies the selected versions and runs `npm test` with `PI_OPENCODE_SDK`
   set. Every cell checks that Pi’s real loader and scripted session exercised
   the exact CodeMode release and that the full suite ran without skips.
6. Removes the temp directory in `finally`, even on failure.

It does not alter the source checkout's dependencies or personal Pi settings.
By default, the command tests the **0.99.0** and **1.5.0** Pi/TUI pairs with
locked CodeMode **2.3.0**. To select one Pi endpoint or check npm latest
(on Node 24):

```sh
PI_OPENCODE_TEST_VERSION=0.99.0 npm run test:pi-versions
latest=$(npm view @opencode/codemode@latest version --registry=https://registry.npmjs.org/ --prefer-online) &&
  PI_OPENCODE_CODEMODE_VERSION="$latest" npm run test:pi-versions
```

`PI_OPENCODE_CODEMODE_VERSION` must be an exact stable version. An unverified
value is installed into a disposable copy and rejected at the runtime gate,
before the full suite. CI does not substitute the baseline on failure.

## Modal-backed CI

GitHub Actions runs the offline Python dispatcher tests once. All Node/npm
work runs on Modal: npm latest is resolved once per run, and packaging is
checked once per full run, not in every cell.

| Trigger | CodeMode | Node | Pi/TUI | Full-suite cells |
| --- | --- | --- | --- | ---: |
| Push to `main` | Locked **2.3.0** | 22.19.0, 24.x | 0.99.0, 1.5.0 | 4 |
| Push to `main` and weekly schedule | Exact npm `latest` | 24.x | 0.99.0, 1.5.0 | 2 |

A push runs six cells in one wave. If npm latest is already the baseline,
it skips the duplicate cells. The weekly check runs only the two latest cells
and detects upstream changes even without a repository push. Lookup/install
failures and runtime refusals fail the check; after dispatch any other cells
are allowed to finish. The former duplicate bot-PR workflow is retired.

Each Modal test function has 1 CPU, 2 GiB memory, a ten-minute timeout and no
retries. GitHub allows 25 minutes for the job including image setup. Only
package files, the lockfile, and tests are uploaded; not `.env`, `.git`,
`.pi`, or local `node_modules`. Each cell uses an isolated install with
`engine-strict` enabled and dependency lifecycle scripts disabled.

`Node/Pi compatibility on Modal` runs on trusted `main` and must not be
configured as a required pull-request check. Modal compute may incur costs.

### One-time setup

Create a Modal CI/service-user token and add these repository or organization
Actions secrets (organization secrets must grant this repository access):

- `MODAL_TOKEN_ID`
- `MODAL_TOKEN_SECRET`

Missing tokens fail with an explicit setup error. Pull-request events never run
the credentialed Modal workflow, and `pull_request_target` is not used. Every
change, including a same-repository or fork PR, is tested by the trusted
post-merge push to `main`. Manual dispatch is intentionally unavailable so an
unreviewed ref cannot be selected for a credential-bearing run.

### Local reproduction

With Python 3.11 and a configured Modal profile (or the two token environment
variables), from the repository root:

```sh
python -m pip install -r ci/requirements.txt
python -m unittest discover -s ci -p 'test_*.py'
modal run ci/modal_ci.py::matrix
modal run ci/modal_ci.py::matrix --latest-only
modal run ci/modal_ci.py::run_tests --node-version 22.19.0 --pi-version 0.99.0
modal run ci/modal_ci.py::latest
```

The last command only resolves npm latest. The matrix logs the resolved version
and records it in the GitHub job summary. The single-cell entrypoint also
accepts `--codemode-version <exact version>` for an explicit test on Node 24.

### Installer and CodeMode 2.4.2 verification

`test/install.test.js` exercises the threshold, ESM resolution without module
evaluation, lookup failures, and post-install verification with disposable
fixtures and stubbed npm commands. The suite does not contact the registry.
A separate local smoke test installed the real packed installer into three
disposable Pi agent directories: absent → **2.4.2**, existing **2.3.0** →
**2.3.0**, and existing **2.3.1** → **2.4.2**. Each saved the exact requirement
and loaded through Pi's package loader; only the legacy lane ran custom
`toJSON()` during dispatch. Earlier local probes also ran CodeMode **2.4.2**
on Node **22.23.1** (without the strict engine gate) and **26.13.1**.

The current six-cell matrix passed locally on Node **22.19.0** and **24.22.2**
with `engine-strict` enabled: **139 tests per cell**, including real Pi SDK
sessions, with no skips. This is not a hosted Modal run.

### Local verification for CodeMode 2.4.0 and 2.4.1

On macOS arm64, Node **22.19.0** and **24.22.3** each passed the full
**130-test** suite with no skips for all five supported CodeMode releases on
Pi/TUI **1.5.0**. On both Node versions, the **2.4.1** latest-upstream check also
passed with Pi/TUI **0.99.0, 1.3.0, and 1.4.0**.

A fresh install of the 0.2.3 tarball with `engine-strict` on Node **24.22.3**
selected CodeMode **2.4.1** and `psychoscript` **0.2.1**, executed the packaged
extension, and passed `npm audit`. On Node **22.19.0**, the same fresh install
with `engine-strict` rejected `psychoscript` with `EBADENGINE`, while the locked
checkout installed successfully with `engine-strict`. This is local evidence,
not a hosted Modal run.

### Historical 0.2.2 multi-version verification

On macOS arm64, the **12** release compatibility cells passed on Node
**22.19.0** and **24.22.2**. Each cell passed **126** tests with no skips,
including real Pi sessions. The **2.3.2** upstream-mode cell also passed on
Node **24.22.2** with Pi/TUI **1.5.0**. These runs used the clean-copy harness,
not hosted Modal.

### Historical 0.2.1 matrix verification

Before 2.3.1 and 2.3.2 were supported, the 12 clean-copy cells were reproduced
locally on macOS arm64 with Node **22.19.0** and **24.22.2**: each of the eight
release cells passed **125**
tests, and each of the four refusal cells passed **5**, with no skips or
failures. On 24.22.2, selecting the same 2.3.2 artifact in upstream mode
failed at runtime admission as intended. The Modal dispatcher unit tests
and both workflow lint checks also passed. These results are not a hosted
Modal run.

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

## Checking a new npm latest

If the npm tag changes and CI returns `UnsupportedCodeModeVersion`, update
the second exact version in the [`package.json`](package.json) dependency
and sync the root lockfile declaration without changing the installed
**2.3.0** lock pin. Run the latest lane on Node 24 to verify that serialization
and real-Pi tests still pass before merging. The installer does not replace
a working runtime with an unverified version. CI does not automatically
override the runtime guard, merge, publish, or create a release.

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

## Local presentation/loading optimization verification — 2026-11-07

Before rebasing onto PR #6, the performance changes were validated against
CodeMode **2.2.5** / Effect **4.0.6** as recorded below. These are historical
pre-rebase measurements, not verification of the current **2.2.6 / 4.1.0** pins.
No upstream search-index patch was included. Source-checkout `node_modules`
was not reinstalled: tests used exact dependencies in disposable copies instead.

- On Node **22.23.1**, the complete offline-cache clean-copy matrix passed for
  Pi/TUI **0.99.0 / 1.3.0 / 1.4.0**, including real-SDK sessions with no skips.
  The same three versions also passed on Node **26.13.0** before the final
  file-loader/oversized-whitespace regressions were added.
- On Node **22.23.1**, the final suite with existing Pi/TUI **1.5.0** passed
  **114 tests**, with no failures or skips. Session fixtures import TypeBox
  directly rather than relying on the removed pi-ai Type re-export.
- Deterministic tests count formatting/highlighting work, verify stable child
  reuse and bounded cache entries, and exercise palette changes behind a stable
  theme Proxy via `invalidate()`, source changes, resizing, expansion, raw
  streaming/completion, oversized Unicode source and hook-replaced output.
- Mock-timer tests prove immediate host dispatch/record mutation, 16ms frame
  coalescing, synchronous final flush, detached snapshots, observer-error
  isolation, concurrent-root independence and no post-completion callback.
- Fresh-process module hooks prove registration/rejected preflight do not
  resolve CodeMode/Effect. Additional tests cover actual Pi file/jiti loading,
  shared cold imports with fresh execution state, abort-before/during loading,
  and safely observed late import rejection without replay.

A local warm synthetic comparison on Node **26.13.0** used actual Pi **1.5.0**
tool components, 300 catalog entries and 64 immediate in-memory hosts, at width120. Thirty-six
samples per variant, six warmups and seeded alternating order measured component
setup + execution + final rendering. With partial component updates applied but
terminal-line rendering deferred to the end, baseline/current median latency
was **104.0 / 4.1ms** (p95 **113.8 / 5.2ms**), with **129 / 2** notifications.
Rendering every partial frame was a separate heavier sensitivity case, not an
observed terminal cadence. These are not model/API/real-terminal E2E timings,
whole-application speedup ratios, confidence intervals or evidence that seconds
of real-user delay have been eliminated. Streaming/output/import measurements
were exploratory; no wall-clock thresholds are enforced by unit tests.

The hosted Node **22.19.0 / 24.x** matrix was not dispatched for this local
change. Existing CI still owns those release checks. No package publication,
release, upstream issue or PR was performed.

## PR #6 rebase verification — 2026-11-07

The local presentation/loading changes now build on PR #6 head
`101f98cc3c7dc7f22a3c5054fdec355655f569c2`, with CodeMode **2.2.6**, Effect
**4.1.0** and Acorn **8.15.0**. The PR's lockfile, `require` preflight guard,
legacy-engine selection and dependency-specific regression tests are preserved.
Lazy-loading tests additionally assert that `require` (including shadowed names)
and dynamic `import()` after a would-be host call do not even load the backend.

- A fresh `npm ci --ignore-scripts` copy verified the actual dependency versions
  and the same resolved Effect module path for both extension and CodeMode.
- On Node **22.23.1** / macOS, PR #6 alone passed **94 tests**, no failures or
  skips, with Pi/TUI **1.3.0**. With the performance changes, the full suite
  passed **115 tests**, no failures or skips, on both Pi/TUI **1.3.0** and
  **1.5.0**.
- The complete clean-copy compatibility matrix on Node **22.23.1** also passed
  Pi/TUI **0.99.0 / 1.3.0 / 1.4.0**, with actual CodeMode **2.2.6** and no
  skipped SDK coverage. An initial offline attempt hit stale npm version
  metadata; the normal registry-backed matrix then passed all three cells.
- The source checkout's existing `node_modules` remains unchanged. It still
  contains the old **2.2.0 / 4.0.1** installation, so run `npm ci` before
  testing/deploying this checkout directly; the results above use isolated
  matching dependency trees, not that stale installation.

The same 300-tool/64-immediate-host synthetic component comparison described
above, now with the PR #6 backend on both sides, measured median **105.6 / 3.8ms**
and p95 **108.6 / 4.4ms** for PR-only versus PR+performance changes. Notification
counts remained **129 / 2**. These are warm Node **26.13.0** / Pi **1.5.0** path
measurements, not whole-app speedups or real-provider/physical-terminal E2E.
Earlier **2.2.5 / 4.0.6** measurements remain explicitly historical above.
No hosted Modal matrix, upstream search-index modification, new commit or
remote publication was performed for this rebase.

## 0.2.0 release preparation verification — 2026-11-07

The manifest and both root lockfile version fields are **0.2.0**. Runtime pins
remain CodeMode **2.2.6**, Effect **4.1.0** and Acorn **8.15.0**; no additional
runtime implementation change was made for the version bump.

After the bump, the full suite again passed **115 tests**, no failures or skips,
on Node **22.23.1** with Pi/TUI **1.5.0** and the exact backend pins in an
isolated tree. The complete clean-copy matrix also passed Pi/TUI
**0.99.0 / 1.3.0 / 1.4.0**, with no skipped SDK coverage. The package regression
now checks manifest/lockfile root version and dependency agreement, plus a
matching changelog entry. The package dry-run identifies
`pi-opencode-mode-0.2.0.tgz` and retains the intended 11-file package scope.

The changelog records prepared changes, intentional UI cadence/loading behavior,
pre-rebase versus post-rebase measurements and limitations. The README keeps
previously published install commands explicitly separate from testing the
prepared 0.2.0 checkout; the release checklist advances those commands only
after publication is confirmed. Source commits do not imply publication: this
preparation does not create tags, publish npm packages or create GitHub releases.
Hosted CI and a live-model/TUI walkthrough remain explicit pre-publication checks.

## 0.2.0 hosted release verification — 2026-11-07

The [merged-runtime CI run](https://github.com/hyein-cbio/pi-opencode-mode/actions/runs/42400320558)
passed on `fbb961aabc22e651f8cc59b5d5489bf4ea3c9b23`, including the full six-cell
Node **22.19.0 / 24.x** × Pi/TUI **0.99.0 / 1.3.0 / 1.4.0** Modal matrix and
package inspection. This supersedes the pending-hosted-CI status in the earlier
preparation/rebase records above; those records are retained as historical
local evidence. Release finalization changes documentation only, not runtime
sources or dependency pins.

Final isolated release checks on Node **22.23.1** / Pi **1.3.0** passed the
full **115-test** suite without skips. `npm audit --omit=peer` reported **0**
known runtime-tree vulnerabilities. Full audit of the locked Pi **1.3.0** peer
tree reported **2 moderate / 1 high** entries via Pi, `minimatch` and `undici`.
These host/test packages are not bundled in the 11-file tarball; no automatic
host dependency upgrade or audit-fix rewrite was applied. Keep Pi updated
independently of the extension.

A configured-model/physical-TUI walkthrough was not performed. The release
retains the documented cooperative-cancellation, memory/isolation and
MCP-readiness limits; passing CI is not a live-provider E2E guarantee.

## Default-host lockfile refresh verification — 2026-11-07

After the 0.2.0 release, the development lockfile was refreshed to matching
**Pi/TUI 1.5.0**, with **minimatch 11.0.3** and **undici 8.12.3**. The package
version, public peer range, and complete CodeMode/Effect/Acorn lock entries are
unchanged. The 0.2.0 release-time 1.3.0 audit findings above remain historical;
the refreshed default is a distinct source-checkout maintenance change.

A fresh isolated `npm ci --ignore-scripts` on Node **22.23.1** verified the
restored broad peer contract and passed the full **115-test** suite with no
failures or skips. Full `npm audit` and `npm audit --omit=peer` both reported
**0** known vulnerabilities. These are registry-advisory snapshots, not security
certification. The checkout's pre-existing `node_modules` was not reinstalled;
run `npm ci` to apply the new lockfile to an existing development installation.

The unchanged three-version compatibility matrix also passed all cells, with
no skipped SDK coverage. Each cell first verified and audited the default
**1.5.0** installation, then installed its older **0.99.0 / 1.3.0 / 1.4.0** pair
and ran the full suite without changing the copied manifest/lockfile. Auditing
those old fixtures after the override would test a different security baseline
and is deliberately not part of the default audit gate. Existing Python CI
regressions passed **13 tests**; package dry-run retained the 11-file scope.
No hosted matrix was dispatched for this uncommitted maintenance change.

## CodeMode 2.2.7 verification — 2026-11-10

Local only, on Linux 6.12.113+ x86_64. Starting main was
`7bf2f4c7ff4102a86edef55b56b39504b1dfd21b`, which pinned CodeMode **2.2.6**,
Effect **4.1.0**, and Acorn **8.15.0**. The candidate keeps Effect and Acorn
and pins CodeMode **2.2.7**. `npm view @opencode/codemode dist-tags.latest`
returned `2.2.7` at 2026-11-10T15:01:02Z. No open pull request existed for that
version. Hosted Modal CI has not run on this candidate. macOS was not
exercised. No live model API and no new benchmark.

Published artifact comparison, not the monorepo release notes, is the baseline.
2.2.7 still depends on exact Effect **4.1.0** and Acorn **8.15.0**. The default
runtime is still `catalog` plus `execute`. New idempotent/durable tool wrappers,
VM `runId` options, and extension snapshot hooks are not used. `for...in` and
`require` behavior matches 2.2.6. The legacy engine now passes each plain
`execute` a `<runId>:<callId>` key. The extension ignores that argument, so Pi
still receives only the decoded input and call metadata does not store the key.

On Node **v22.23.4**, a fresh `npm ci --ignore-scripts` exited 0 and installed
CodeMode 2.2.7, Effect 4.1.0, Acorn 8.15.0, and Pi/TUI 1.5.0, with one shared
Effect module path. `npm test` without `PI_OPENCODE_SDK` exited 0: tests 105,
pass 104, fail 0, skipped 1 (`isolated real Pi SDK session`). With
`PI_OPENCODE_SDK` pointed at that install, `npm test` exited 0: tests 116,
pass 116, fail 0, skipped 0, Actual SDK 1.5.0. `npm pack --dry-run` lists 11
files and `git diff --check` is clean.

`npm run test:pi-versions` exited 0 on Node **v22.19.0**, **v22.23.4**, and
**v24.22.1**. Each parent run was tests 3, pass 3, fail 0, skipped 0. Every
cell used CodeMode 2.2.7 and matching Pi/TUI **0.99.0**, **1.3.0**, and
**1.4.0**. Each inner suite was tests 116, pass 116, fail 0, skipped 0.
`PI_OPENCODE_UPSTREAM_VERSION` and `PI_OPENCODE_TEST_VERSION` were unset.

## CodeMode 2.3.0 verification — 2026-11-13

Local only, on Linux 6.12.113+ x86_64. Starting main was
`495d174a5cdead2ca4a385c53c59487c4478d8ab`, which pinned CodeMode **2.2.7**,
Effect **4.1.0**, and Acorn **8.15.0**. The candidate keeps Effect and Acorn
and pins CodeMode **2.3.0**. `npm view @opencode/codemode dist-tags.latest`
returned `2.3.0` at 2026-11-13T15:02:03Z (semver 7.8.6 `compare` is 1; no
prerelease). No open pull request existed for that version. Hosted Modal CI
has not run on this candidate. macOS was not exercised. No live model API and
no new benchmark.

The published artifacts are the comparison baseline. 2.3.0 has no `gitHead`,
`engines`, or peer metadata. It still depends on exact Effect **4.1.0** and
Acorn **8.15.0**. The package removes the legacy AST interpreter, so
`CodeMode.make` is the bytecode runtime and also exposes `program` and
`resume`. This extension still calls only `runtime.execute` and does not
suspend, resume, or use idempotent, durable, or freeform tools. Direct
execution of both artifacts showed the same `for...in` snapshot divergence,
the same `require`/`import` globals, the same `<runId>:<callId>` keys, and
the same flat `UnknownTool` wording. Search ranking is now a word index:
exact path lookup and empty-query order are unchanged, while `zones` no
longer matches `timezones` as a substring. That ranking change is outside
the extension's asserted catalog contract. The OpenCode `v2.3.0` GitHub
release notes describe the product, not this package's interpreter delta.

On Node **v22.23.4**, a fresh `npm ci --ignore-scripts` exited 0 and installed
CodeMode 2.3.0, Effect 4.1.0, Acorn 8.15.0, and Pi/TUI 1.5.0, with one shared
Effect module path. `npm test` without `PI_OPENCODE_SDK` exited 0: tests 105,
pass 104, fail 0, skipped 1 (`isolated real Pi SDK session`). With
`PI_OPENCODE_SDK` pointed at that install, `npm test` exited 0: tests 116,
pass 116, fail 0, skipped 0, Actual SDK 1.5.0. `npm pack --dry-run` lists 11
files and `git diff --check` is clean.

`npm run test:pi-versions` exited 0 on Node **v22.19.0**, **v22.23.4**, and
**v24.22.3**. Each parent run was tests 3, pass 3, fail 0, skipped 0. Every
cell used CodeMode 2.3.0 and matching Pi/TUI **0.99.0**, **1.3.0**, and
**1.4.0**. Each inner suite was tests 116, pass 116, fail 0, skipped 0.
`PI_OPENCODE_UPSTREAM_VERSION` and `PI_OPENCODE_TEST_VERSION` were unset.
Local Node 24.22.3 is not the hosted `node:24` image.

## CodeMode tool input serialization

The comparison uses the actual installed npm artifacts and inert input recorders.
The behavior changed at **2.3.1**. The current suite exercises only the
legacy baseline and the latest verified release.

| Installed `@opencode/codemode` | Standalone public runtime | Pi extension |
| --- | --- | --- |
| 2.3.0 | Invokes custom `toJSON` before dispatch, including nested objects and arrays; an exception prevents dispatch. | Admitted, using the unmodified VM and bridge. |
| Latest verified release | Drops the method; a method-only input becomes `{}`, existing fields stay unchanged, and a would-be exception does not run. | Admitted, using the unmodified VM and bridge. Pi may reject a missing or invalid field before the tool body runs. |

The raw probe also compares invocation count, property key and receiver, ordinary
function fields, nested and rejected promises, cycles and non-JSON values. Direct
`this` is rejected by Pi preflight; receiver behavior is measured in the raw VM
only. String-form `search` and guest `Buffer` exist in the latest verified
release but not 2.3.0. Neither is portable across the two endpoints.

The test suite checks the installed artifact’s exact inputs, conversion
errors, invocation count, timeouts, cancellation, and call budget. The real
Pi file loader verifies dispatch and conversion; an isolated Pi session checks
that both conversion behaviors still go through schema validation, hooks,
and call auditing. Separate lazy-loading tests verify that unverified releases
are rejected before importing the runtime, running guest code, or reading the
host catalog.

[Upstream #64513](https://github.com/anomalyco/opencode/pull/64513) accepts
dropping `toJSON`. The published `CodeMode.make` options expose tools, hooks,
extensions and limits, but no input conversion hook. Its lower-level runtime
translation policy is not a package export and only controls dropping functions
and waiting for promises. Tool hooks and host extension globals receive values
after conversion; the missing guest receiver and method cannot be recovered.
A guest `JSON.stringify`/`parse` round trip is also not equivalent: it rejects
nested promises that the tool boundary awaits, and loses negative zero.

The extension therefore uses the installed runtime’s native behavior. There
is no host-side shim, source rewrite, or automatic fallback. To get the same
arguments on all versions, compute the object explicitly before the tool call.
The npm-latest CI lane fails early if the version is not a verified endpoint.

Run `npm run test:codemode-serialization` under the locked release or in a
disposable copy with another supported release installed. For example:

```sh
npm ci
version=$(node --input-type=module -e 'import { verifiedLatest } from "./codemode-versions.js"; console.log(verifiedLatest)')
npm install --no-save --package-lock=false "@opencode/codemode@$version"
npm run test:codemode-serialization
```

These focused tests cover conversion and the Pi loader;
use the clean-copy compatibility matrix above for the full suite with real Pi
sessions.

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
