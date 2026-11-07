# Changelog

## 0.2.0 — Unreleased

Prepared on **2026-11-07**. This entry describes the 0.2.0 source/package
preparation; the npm package, Git tag and GitHub release have not been published
as part of this work.

### Dependency support and execution safety

- Upgrade the exact runtime pins to **`@opencode/codemode` 2.2.6** and
  **Effect 4.1.0**, with **Acorn 8.15.0** unchanged. This includes the previously
  unreleased 2.2.1/2.2.5 compatibility work; the final supported pin is 2.2.6.
  The extension and CodeMode resolve the same Effect module, preserving the
  shared interruption/cleanup behavior of the bridge.
- Retain PR #6's dependency and compatibility changes. The default engine is
  still the legacy interpreter: the experimental bytecode VM, suspend/resume
  and snapshot APIs are **not enabled** by this release.
- Reject `require` before backend loading, runtime construction or host effects.
  CodeMode 2.2.6 now binds this name and can load `url`, `util` and `crypto`;
  preflight conservatively rejects references and shadowed bindings, including
  references after a would-be host call. A noncomputed property named `require`
  remains ordinary data and is not rejected for its name alone.
- Keep dynamic `import()` outside the syntax allowlist even though the new
  interpreter can execute it. Static imports remain script-mode syntax errors.
  Keep `for...in` rejected because inherited keys and keys deleted during
  iteration do not match the supported JavaScript behavior.
- Preserve model-only invocation, the fresh runtime and callable catalog for
  every execution, Pi validation/permissions/result hooks and nested-call audit,
  the 64-call budget, bounded diagnostics/output, and awaited host cleanup.
  No automatic fallback, retry or replay is introduced.

### Rendering and responsiveness

- Cache source highlighting and output components **per tool row** instead of
  rebuilding unchanged text on every nested-call update. Expensive highlighting
  is deferred until an actual render. Stable output children retain TUI Text's
  width-aware wrapping cache when only timers or call records change.
- Invalidate embedded ANSI/highlight strings when the component/theme changes,
  including palette changes behind a stable theme Proxy. Source replacement,
  expansion/collapse, resize, partial/final transitions and hook-replaced output
  still update correctly. Cache entries retain only the current children, not
  an unbounded history of sources or outputs.
- Coalesce presentation notifications on a **16ms timer**, independently of Pi's
  terminal paint scheduler. Host dispatch and record/status mutation remain
  immediate. Completion flushes pending state synchronously and removes the
  timer on success, error and cancellation; no notification is scheduled after
  the root result. Detached snapshots and observer-error isolation are retained.
- Show a raw, unformatted/unhighlighted preview while arguments stream; restore
  structural formatting and syntax highlighting when arguments are complete or
  execution starts. Older hosts without `argsComplete` retain completed-source
  behavior.
- Limit oversized collapsed source previews to **8,192 UTF-8 bytes**, cut safely
  at Unicode boundaries, and show a visible notice. Expansion exposes the full
  unhighlighted original. Display formatting and limits never rewrite executed
  or stored source, change diagnostic offsets, or alter model-visible output.

### Lazy backend loading

- Load CodeMode and Effect on the first preflight-approved execution instead of
  extension registration. Rejected programs do not load the backend.
- Concurrent executions share only the module-load promise, never a runtime,
  context, signal, callable-tool wrapper or call log. A caller can stop waiting
  on cancellation without cancelling another waiter; late import failures stay
  observed and cancelled callers cannot dispatch host tools after loading.
- This shifts one-time backend startup cost to first use. It does not eliminate
  that cost or claim a steady-state execution improvement by itself.

### Intentional visible changes and upgrade notes

- Very short host calls may finish between visual frames, so an intermediate
  `running` state need not appear. Final records retain every attempted call
  within the existing budget, including duplicate names, handled failures,
  cancellation and cleanup-aware durations.
- Streaming source is temporarily shown without highlighting/structural layout.
  Oversized source uses a limited raw preview until expanded. The original
  source and authoritative result text remain available and unchanged.
- After updating a source checkout, run `npm ci` to install the new exact pins,
  then reload/restart Pi. Do not use a stale 2.2.0/Effect 4.0.1 tree to validate
  2.2.6 support. Published-version installation commands must only be advanced
  after the corresponding npm package/tag actually exists.

### Verification and measured scope

- The combined PR #6 + performance implementation passed **115 tests**, with
  no failures or skips, on Node **22.23.1** / macOS using Pi/TUI **1.3.0** and
  **1.5.0**. The clean-copy matrix also passed Pi/TUI **0.99.0 / 1.3.0 / 1.4.0**
  with actual CodeMode **2.2.6** / Effect **4.1.0** and no skipped SDK coverage.
- Regression coverage includes deterministic formatting/highlight work counts,
  stable child reuse, cache invalidation/eviction, Unicode and raw-source
  preservation, timer coalescing/final flush, no late updates, concurrent-root
  isolation, observer failures, lazy import cancellation/failure, actual Pi
  file/jiti loading, and existing permission/output/timeout/cleanup contracts.
- A warm synthetic comparison on Node **26.13.0**, with actual Pi **1.5.0** tool
  components, 300 catalog tools and 64 immediate in-memory hosts, measured
  **105.6ms -> 3.8ms median** and **108.6ms -> 4.4ms p95** for PR #6 alone versus
  PR #6 plus these local changes. Notifications fell from **129 to 2**. Both
  sides used 2.2.6/Effect 4.1.0; samples included component setup, execution and
  final rendering, with partial component updates applied but terminal-line
  painting deferred to the end (36 samples/variant, six warmups, width120).
- These measurements are **not whole-app speedup ratios**, model/provider or
  physical-terminal E2E timings, confidence intervals, or proof that seconds of
  perceived delay are eliminated. The upstream search-index optimization is
  **not included**. See [TESTING.md](TESTING.md) for detailed evidence.

### Known limits and pending release checks

- The interpreter is not an OS or memory-isolation sandbox. Host cancellation
  remains cooperative; a non-settling host may delay delivery beyond the
  nominal 30-second interruption deadline. Completed effects cannot be undone.
- MCP readiness coordination, broad JavaScript support and live model behavior
  are unchanged; choose native codemode upfront where documented.
- Hosted Node **22.19.0 / 24.x** CI and a configured-model/TUI walkthrough remain
  release checks. No live-provider test, npm publication or tag creation is
  implied by the local results above.

## 0.1.5 — 2026-10-28

### Changed

- Use `@opencode/codemode` 2.2.0. The published interpreter sources are unchanged
  from 2.1.4; Acorn stays 8.15.0 and Effect stays 4.0.1. This dependency
  update alone does not change the tool bridge, limits, preflight, or result
  contract; `for...in` remains rejected.

### Improvements

- Admit direct `String.raw` tagged templates through preflight for backslash-heavy
  shell commands and heredocs. Other tags stay rejected; substitutions retain
  the existing compatibility checks, and source is never rewritten. Document
  interpolation/backtick caveats in model guidance and the shell examples.
- Include bounded upstream recovery suggestions in model-visible error/warning
  text, before logs and return data, without automatic retry or replay.
- Show an error-attempt count such as `1 failed` only when failures exist,
  including failures hidden by the last-eight-call preview. Do not add total or
  success counts, count cancellations as failures, or change script success.
- Nudge models to use JS template literals for multiline shell commands and
  heredocs, with explicit guidance on embedded backticks, interpolation, and
  backslash escaping. Source validation and execution behavior are unchanged.

## 0.1.4 — 2026-10-26

### Changed

- Admit `switch`/`case` and `new Date`, `new RegExp`, `new Map`,
  `new Set`, `new URL`, `new EvalError`, and `new URIError` through preflight.
  CodeMode 2.1.4 already runs them. Other constructors and unsupported syntax
  stay rejected before execution.
- Keep `for...in` rejected before any host effects: CodeMode 2.1.4 skips inherited
  properties and still visits keys deleted during iteration.
- Name `codemode_o` and native `codemode` explicitly as the model-only direct-call
  targets; `bash` and `edit` remain ordinary host calls inside a program.
- Keep short programs that call native `bash` and `edit` on `codemode_o`.
  Those host calls already ran through Pi's tool bridge; the tool guidance no
  longer treats a shell command or file edit as a reason to switch to native
  `codemode`.
- Use `@opencode/codemode` 2.1.4. Upstream promise scheduling now holds the
  main job until leftover promise work is interrupted; the extension's tool
  bridge, limits, and result contract are unchanged. Acorn stays 8.15.0 and
  Effect stays 4.0.1.

## 0.1.3 — 2026-10-25

### Improvements

- Simplify the source-preview notice to `Preview; expand for original`.

### Fixes

- Allow OpenCode-supported regular-expression literals through preflight instead
  of incorrectly reporting `NativeCodemodeRequired`; preserve syntax errors for
  invalid patterns/flags and existing BigInt/Pi-only restrictions.
- Preserve Pi's native pending/success/error panel backgrounds when call rows
  are shortened or wrapped, including duration text and trailing padding.

## 0.1.2 — 2026-10-25

### Improvements

- Show live, per-attempt host-call rows with bounded argument/error previews,
  status and duration. Preserve duplicate names, settle cancellation after host
  cleanup, and retain detached records for restored sessions.
- Format source previews at AST boundaries without changing execution input;
  preserve literals/comments/templates and fall back to raw source on parse or
  structure-check failure. Expansion also exposes the original execution source.

### Fixes

- Distinguish invalid script syntax (`SourceSyntaxError`) and unexpected
  preflight parser exceptions (`PreflightParserError`) from native-required
  compatibility limitations; do not recommend native replay for these failures.
- Preserve bounded Acorn messages and valid UTF-16 offsets/line-column locations,
  including the string start and newline detection position. Explain JS/JSON
  newline escaping without rewriting source or executing any host tool.
- Add raw LF/CR/CRLF, escaped heredoc/Korean multi-call, parser failure injection,
  diagnostic budget, and isolated real-session regression coverage.

## 0.1.1 — 2026-10-24

### Improvements

- Prefer `codemode_o` for short, compatible programs through concise model
  context guidance; choose native `codemode` upfront for Pi-specific features,
  images, MCP readiness, long-running work, or uncertain compatibility.
- Separate LLM tool selection from compatibility-only preflight validation.
  Preserve the historical routing helper and metadata for compatibility.
- Report compatibility outcomes in `details.preflight`; keep native-availability
  caveats explicit and never automatically delegate or replay execution failures.
- Add regression coverage for active/inactive/unloaded prompt guidance and
  duplicate-free reactivation; update tool-selection and testing documentation.

### Known limits

- Guidance influences model choice; it is not enforced routing or a performance
  guarantee. Custom prompts and higher-priority instructions may affect it.
- MCP startup/reconnect readiness coordination remains out of scope; prefer
  native `codemode` for MCP workflows.

## 0.1.0 — 2026-10-23

Initial public release.

### Features

- Add `codemode_o`, backed by OpenCode CodeMode 2.1.0, alongside Pi's native
  `codemode`; neither tool replaces or recursively invokes the other.
- Discover already-callable Pi tools with OpenCode's synchronous `search` API.
- Preserve Pi tool validation, permission/result hooks, and nested-call audits.
- Reject native-only programs before execution, without automatic fallback or
  replay after side effects.
- Bound final text output to 65,536 UTF-8 bytes with visible diagnostics and
  truncation indicators; await cooperative host cancellation and cleanup.
- Show highlighted source, collapsible output, and execution duration in the TUI.

### Compatibility and verification

- Require Node.js >= 22.19.0 and Pi >= 0.99.0, < 2.0.0.
- Add CI for Node 22.19.0 / 24.x and Pi 0.99.0 / 1.3.0 / 1.4.0, including isolated
  scripted real-SDK sessions. See [TESTING.md](TESTING.md).
- Include a sourced historical `pi-codemode-bench` comparison in the README,
  with measured versions, timing boundaries, and contrary CPU-heavy results.

### Known limits

- The interpreter is not an OS or memory-isolation sandbox, and supports only a
  JavaScript subset. Use trusted host tools.
- The 30-second deadline requests interruption; a host tool that never settles
  can delay delivery indefinitely. Cancellation does not roll back side effects.
- Historical benchmark results are not a current-release performance guarantee;
  no live-provider E2E guarantee is included.
