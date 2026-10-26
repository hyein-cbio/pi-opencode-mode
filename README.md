# pi-opencode-mode

A small Pi extension that leaves native `codemode` in place and lets you choose OpenCode CodeMode too.

It registers **`codemode_o`**, backed by `@opencode/codemode` 2.1.4: another execution option for short, self-contained JavaScript-like programs that call Pi tools. Host calls retain Pi's validation, permission/result hooks, and nested-call audit; cancellation waits for host cleanup, and output keeps bounded, visible diagnostics.

Short programs can be quick: see the [benchmark snapshot](#benchmark-snapshot) for measured comparisons with native `codemode`. Both can batch tool calls; this extension lets you use the OpenCode interpreter in Pi without replacing the native tool. Performance depends on the workload, and lower latency does not imply stronger isolation. You choose the tool: preflight can reject an unsuitable OpenCode program, but never switches tools or falls back automatically.

## At a glance

Illustrative transcript (not a terminal capture):

```text
You: Call codemode_o with {"code":"return 42;"}.

codemode_o (OpenCode)
return 42;

42
Took 0.0s
```

Native `codemode` is left unchanged and can be active alongside it. This extension adds an
interpreter choice, not an OpenCode server or a replacement Pi CLI.

## Install

Install the versioned npm package in Pi:

```sh
pi install npm:pi-opencode-mode@0.1.3
```

Or install the tagged Git source:

```sh
pi install git:github.com/hyein-cbio/pi-opencode-mode@v0.1.3
```

Restart Pi after installation. To explicitly enable both code tools:

```sh
pi --tools read,find,codemode,codemode_o
```

The walkthrough below uses a source checkout so its example files are available
in the working directory. Installing the package does not copy that checkout
into your project.

## Quick start

Requires **Node.js >= 22.19.0**, npm, Git, and **Pi >= 0.99.0, < 2.0.0** with a configured model/provider. Check `node --version` and `pi --version`; if you are new to Pi, see its [quickstart](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md). In Pi, `/login` configures a provider and `/model` chooses a model. The extension does not need an OpenCode account or server; asking Pi to call it still uses your configured model.

1. **Install from source for the walkthrough.** Use the release tag so the examples match this version.

   ```sh
   git clone --branch v0.1.3 https://github.com/hyein-cbio/pi-opencode-mode.git
   cd pi-opencode-mode
   npm ci
   ```

2. **Load the extension and explicitly enable both code tools.** Run from the checkout so the examples below can find its files:

   ```sh
   pi -e "$PWD" --tools read,find,codemode,codemode_o
   ```

   `--tools` replaces the default declared tool selection; this example keeps `read` and `find` for the walkthrough. The extension is active by default when loaded, but naming it explicitly avoids an existing default tool allowlist leaving it out. Native `codemode` is enabled here for comparison, not overridden. From another folder, use `-e /absolute/path/to/pi-opencode-mode` instead.

3. **Confirm activation and request the first call.** In Pi's chat editor, ask:

   > Confirm that `codemode_o` is in your available tools, then call **that tool**, not native `codemode`, with `{"code":"return 42;"}`. Do not just predict the result.

   The source sent to `codemode_o` is:

   ```js
   return 42;
   ```

4. **Check the actual tool result.** The transcript should contain a **`codemode_o (OpenCode)`** tool row, result **`42`**, and a concise `Took …` footer in the TUI. An assistant merely saying “42” is not proof the extension ran. Pi's editor is a chat interface, not a JavaScript REPL.

If the tool is missing, check startup load errors and the absolute `-e` path, run `npm ci` in the checkout, and restart with the explicit tool list above. An `UnknownTool` for a guest call means that host tool is not callable in that session; inspect the catalog below. `NativeCodemodeRequired` means the source did **not** run—invoke native `codemode` directly if active; otherwise report that it is needed. Never automatically replay a program after an execution failure: host effects may already have occurred.

## Benchmark snapshot

**18.1× faster on the small-program control, 14.1× on read/reduce, and 3.7× on
parallel context collection** in a recorded
[pi-codemode-bench](https://github.com/hyein-cbio/pi-codemode-bench) run.
These are ratios of native Pi to `codemode_o` **median tool latency**, not
end-to-end assistant speedups; ratios use the unrounded source measurements.

The table below copies the benchmark's preselected ten-case cross-section,
including a CPU-heavy case where native Pi wins. Values are **median / p95 in
milliseconds** (lower is better).

| Case | Native Pi `codemode` median / p95 (ms) | `codemode_o` median / p95 (ms) |
|---|---:|---:|
| even-squares-10 | 10.158 / 10.803 | 0.561 / 0.803 |
| read-reduce | 9.904 / 11.376 | 0.705 / 1.668 |
| parallel-context | 12.594 / 13.592 | 3.381 / 3.522 |
| cursor-pagination | 10.791 / 13.036 | 1.243 / 2.720 |
| retry-waves | 18.499 / 20.513 | 9.010 / 9.636 |
| fan-in-dag-64 | 21.785 / 24.801 | 12.998 / 14.053 |
| deep-roundtrip-64 | 15.870 / 16.301 | 7.264 / 7.659 |
| arithmetic-100000 | 12.807 / 13.660 | 203.832 / 212.545 |
| json-records-8k-x1 | 10.111 / 11.203 | 2.904 / 3.988 |
| json-strings-48k-x4 | 10.698 / 10.901 | 8.573 / 11.366 |

### What was measured

- **2026-10-22**, Apple M5 Pro, macOS arm64, Node **26.12.1**; Pi SDK **1.0.0**
  for both actual registered tools, not direct-runtime substitutes. Native Pi
  here means its built-in QuickJS `codemode`, not the separate Luau project.
- `pi-opencode-mode` **0.0.1** at revision
  [`53b9dd9`](https://github.com/hyein-cbio/pi-opencode-mode/tree/53b9dd937ad53cd3558b086ab21e812780524d5a),
  OpenCode CodeMode **2.1.0**, Effect **4.0.1**. This is a **historical snapshot,
  not a fresh measurement of 0.1.3**; later code changes have not been remeasured
  in this table.
- **20 warm samples**, 4 warmups, and one first-invocation control per eligible
  case/tool. p95 is nearest-rank. The clock spans root tool execution, including
  guest runtime and bridge work, but excludes session setup, extension loading,
  and model generation. Host tools are synthetic in-memory fixtures.
- Full corpus: **76 cases, 3,675 executions, 0 invalid**, including **75
  expected-error checks**. Five unsupported `codemode_o` cells remain visible:
  two 128-call cases, classes, depth-40 JSON, and per-call deadlines. Unsupported
  cells and expected errors are **not speed wins**.

Short orchestration looked good in this run; tight CPU loops did not. This is
one host and one run, without confidence intervals or production-workload
weights—not a universal ranking, stronger-security claim, or automatic routing
rule. Different runtime limits still apply.

Source snapshot (commit-pinned):
[all 76 cases](https://github.com/hyein-cbio/pi-codemode-bench/blob/0eb3afa24279a50b6aa8da7da44cd7ebcd6a28d6/benchmarks/results/pi-comparison.json.md)
· [every timing sample and source hash](https://github.com/hyein-cbio/pi-codemode-bench/blob/0eb3afa24279a50b6aa8da7da44cd7ebcd6a28d6/benchmarks/results/pi-comparison.json)
· [protocol and provenance](https://github.com/hyein-cbio/pi-codemode-bench/blob/0eb3afa24279a50b6aa8da7da44cd7ebcd6a28d6/benchmarks/README.md).
The source hashes identify the measured implementation; the recorded benchmark
HEAD alone does not, because that measurement used a dirty benchmark checkout.

## When to choose which tool

Prefer `codemode_o` over native `codemode` for short, self-contained programs known to fit its supported syntax and limits. This includes batching already-callable non-MCP tools and returning compact text or JSON. Native `bash` and `edit` are ordinary calls in that set: `await tools.bash({ ... })` and `await tools.edit({ ... })`. A shell command or file edit is not, by itself, a reason to choose native `codemode`. You can also reuse short OpenCode programs, adapting host-tool names and arguments to Pi's current catalog.

The extension supplies this conditional preference through the registered tool's `promptGuidelines`, which Pi adds to the default system prompt while `codemode_o` is active and declared. No `AGENTS.md` edit or whole-system-prompt replacement is needed. This is model guidance, not a forced router or a performance guarantee; higher-priority instructions and custom system prompts may affect it. It does not activate tools, replace native `codemode`, or change other extensions. In particular, it does not guarantee extra edit/write diff presentation from other extensions.

| Need | Choose |
| --- | --- |
| Short, fresh program with known supported syntax that awaits already-callable non-MCP tools, including native `bash` and `edit`, and returns text/JSON | Prefer `codemode_o` |
| Batch independent non-MCP tool calls or summarize results within those limits | Prefer `codemode_o`; native can also do this |
| Pi's `text()`, `image()`, `exit()`, `store()`/`load()`, `models`, or native discovery helpers | Native `codemode` |
| Longer or long-running programs, broader/uncertain syntax or limits, or Pi's `// @options:` controls | Native `codemode` upfront |
| Image/screenshot display or generation | Native `codemode` (structured GUI data alone is not excluded) |
| MCP discovery/calls, especially during startup or reconnect | Prefer native `codemode`; `codemode_o` does not coordinate MCP readiness |

Choose native upfront for incompatible work; do not always try `codemode_o` first. Invoke native only when active; if unavailable, report that it is needed. `NativeCodemodeRequired` is a pre-execution rejection, not an execution failure. After execution fails, never automatically replay: host effects may already have occurred. Both code tools are model-only and must be called directly, not as `tools.codemode_o` or `tools.codemode` inside a script.

For example, ask Pi to run this source with `codemode_o` to inspect the package and locate its tests in parallel, returning only a small overview:

```js
const [packageSource, testFiles] = await Promise.all([
  tools.read({ path: "package.json" }),
  tools.find({ pattern: "**/*.test.js", path: "test", limit: 20 }),
]);
const pkg = JSON.parse(packageSource);
return { name: pkg.name, testCommand: pkg.scripts.test, testFiles };
```

This uses two independent, read-only host tools and awaits both. The result contains the package name, its test command, and at most 20 test paths, rather than the full package file. Native `codemode` can perform the same task. Here the choice is the interpreter and this extension's explicit limits—not a promised speedup, stronger isolation, or a capability missing from Pi.

## Discover tools and their arguments

The callable-tool list in `codemode_o`'s description shows names, not every argument. Before using an unfamiliar tool, inspect its current signature with OpenCode's **synchronous `search(...)` global**. For an exact lookup, ask Pi to run:

```js
return search({ query: "tools.read", limit: 1 });
```

The returned object has `items` (each with `path`, `description`, and `signature`), `remaining`, and `next`. For `read`, the signature includes its required `path` argument and any optional arguments exposed by your Pi version. An exact callable path such as `tools.read` avoids guessing names or schemas; then make the actual call in a subsequent `codemode_o` program:

```js
const contents = await tools.read({ path: "README.md" });
return contents.length;
```

To browse rather than look up a known name:

```js
return search({ query: "", limit: 5 });
```

Pass the returned `next.offset` as `offset` in another `search({ query: "", limit: 5, offset: ... })` call when `next` is not `null`. You can also use descriptive queries or a `namespace` filter matching a catalog path prefix.

`search` does not invoke the listed host tools, requires no `await`, and counts toward the **64-call** budget. It only sees tools **already callable in this session**; it does not install, activate, or bypass permissions for tools. `codemode` and `codemode_o` are excluded from the guest catalog. Unlike Pi's native `searchTools()`/`describeTool()` helpers, this global is named `search` and takes an options object. Input signatures come from host schemas; output signatures may be generic (`Promise<unknown>`) and do not prove a return value's shape. Consult the tool's description and the bridge contract below as well.

## Context-based tool selection and compatibility checks

**The LLM chooses the tool before calling it**, using the task and the extension-provided context guidelines above. There is no code-based dispatcher, automatic delegation, or try-OpenCode-first policy. Performance, MCP readiness, image needs, and other task-level considerations belong to that contextual choice—not an AST classifier.

After the LLM explicitly calls `codemode_o`, `checkOpenCodeCompatibility(code)` only accepts or rejects that source, returning immutable `{ supported, reasons, executesSource: false }` with an optional bounded `diagnostic` on parser failures. It never selects or invokes another tool. Keep this pre-execution guard: a mistaken choice must not run partially before discovering an unsupported construct.

The historical `selectCodemodeRoute` helper and `ROUTE_LIMITS` alias remain for API compatibility only; the extension does not call that helper. Its `requested: "auto"` result is a legacy static advisory, not the tool-selection policy.

- OpenCode candidates are at most **8,192 UTF-8 source bytes**, **100 lines**, **2,000 AST nodes**, and **64 AST levels**. Acorn parses source without executing it; a conservative compatibility allowlist rejects unknown syntax.
- Pi globals (`text`, `image`, `exit`, `store`, `load`, `ALL_TOOLS`, `searchTools`, `describeTool`, `describeNamespace`, `models`), options comments (`@options:`), classes, BigInt literals, generators, accessors, and uncertain constructors are rejected by the OpenCode preflight. `switch`/`case`, `for...in`, and `new Date`, `new RegExp`, `new Map`, `new Set`, `new URL`, `new EvalError`, and `new URIError` are admitted because CodeMode 2.1.4 runs them. Regular-expression literals (such as `/pattern/g`) are supported; malformed patterns or flags fail as source syntax errors. Other constructors, including `new Promise` and `new URLSearchParams`, stay rejected. Comments, strings, and ordinary property names do not count as global references; shadowed Pi names conservatively stay native.
- This is a compatibility guard, **not** a tool selector, full JavaScript semantic validator, cost estimator, or security boundary. Tool availability, values, built-in methods, runtime failures, and actual running time cannot be proven statically. Rejection does not guarantee that native Pi supports the program either.
- Native Pi `codemode` is **model-only**, so this extension cannot invoke it through `ctx.executeTool`. When preflight rejects a compatibility limitation, `codemode_o` returns `NativeCodemodeRequired` **before constructing the runtime or calling any host tool**. The caller must invoke the active built-in `codemode` itself, using its raw-source input contract. If it is disabled, report that native `codemode` is needed; this extension does not enable it. No tool name rewriting or permission bypass is used.
- Invalid source in Acorn's script context returns `SourceSyntaxError` (`invalid-script-syntax`), not a native recommendation. Unexpected parser exceptions return `PreflightParserError` (`internal-parser-error`). Both stop before runtime construction, preserve a bounded original parser message without a stack or source excerpt, and never rewrite or replay source. Syntax errors should be fixed before running; internal parser failures should be reported.
- Parser diagnostics in `details.preflight.diagnostic` retain valid `pos` / `raisedAt` UTF-16 offsets and `location` / `detectedLocation` (1-based lines, 0-based columns). The rendered error includes these positions; an unterminated string's start and the newline where it was detected are distinct.
- Raw LF/CR inside ordinary quoted JS strings is invalid: use a JS `\n` escape, or `\\n` when embedding that source in a JSON `code` string. Heredoc text, Korean, and `/` inside a correctly escaped string are data, not unsupported JS syntax. Preflight does not automatically repair escaping.
- Results include the compatibility outcome in `details.preflight`. `details.route` is retained as legacy metadata, not an executed dispatch, a guarantee that native is available, or a recommendation for invalid source. Once OpenCode execution starts, any failure stays an OpenCode failure: **no automatic fallback, retry, or replay**, since host tools may already have produced effects.

The supported Pi range is **>= 0.99.0, < 2.0.0**, with matching Pi/TUI versions. Pi 0.99.0 introduced the callable-tool context and native `codemode` required by this extension. CI checks **0.99.0** (minimum), **1.3.0**, and **1.4.0** on Node **22.19.0** and **24.x**, running both the unit suite and isolated real-SDK sessions. The CI matrix is a set of regression baselines, not the complete list of supported versions; intermediate releases are not individually certified.

## Execution and output contract

- Each preflight-approved call creates a fresh OpenCode runtime: interruption after **30,000 ms**, at most **64 tool calls**. Compatibility checking runs first; no automatic fallback or replay. Pi's built-in `codemode` stays unchanged, and neither code tool is callable from the guest.
- All host calls use `ctx.executeTool`, preserving Pi's validation, permission/result hooks, and nested-call audit. The host receives both outer user cancellation and Effect interruption (including early return and race-loser cleanup at program completion). Host promises are drained before the root result is delivered, including asynchronous cleanup and hooks.
- Cancellation is cooperative, not rollback. A host tool that ignores its signal can still perform effects; one that never settles can prevent result delivery indefinitely. The 30-second deadline requests interruption, **not a hard wall-clock return guarantee**. Await your work and use only trusted, cancellation-aware tools. This interpreter is not an OS or memory-isolation sandbox and does not implement all JavaScript semantics.
- **65,536 UTF-8 bytes** bounds the extension's final `content` text, after JSON encoding, logs, error messages, warnings, separators, and truncation notices. It does not bound the entire Pi message/envelope, `details`, tool names/audit metadata, upstream allocations, or later output added by other extensions.
- Ordinary complete values retain JSON encoding (`42`, `"text"`, etc.); logs precede the value. Errors and warnings take precedence over data. Warnings remain successful if upstream reports success, but appear in both model-visible text and `details.warnings`. No warning causes a retry.
- Upstream or final-render truncation sets `details.truncated: true` and adds a visible notice. Data following that notice is an **incomplete preview, not complete JSON**. No full output is written to disk. Return smaller data when completeness matters.
- Structured error/warning diagnostics have a separate **8 KiB serialized budget**, shared between error and warnings, with bounded messages (1,024 bytes), kinds (64 bytes), and suggestions (up to three, 128 bytes each). Clipping/omission adds a `Truncated` warning; diagnostics cannot be crowded out by logs or return data. Locations and bounded suggestions remain in details.
- Host structured results take precedence over text; otherwise text blocks are joined with newlines. Non-text-only/multimodal host results without structured data are rejected.

## Output presentation

The TUI shows a syntax-highlighted source preview (10 visual lines), live
nested-call rows, a compact result preview (5 visual lines), and the native-style
muted `Took 0.1s` footer. Use Pi's configured tool-expansion shortcut for details.
Limits count wrapped terminal lines, including long JSON and Unicode. Warnings
and incomplete-output indicators remain visible above collapsed data.

- **Readable source, unchanged execution.** A display-only layout pass separates
  multi-element arrays (including batched tool calls) and block statements with
  two-space indentation. It preserves literal/comment/template contents and
  checks the parsed structure after formatting. Invalid, incomplete, oversized,
  or too-complex input falls back to the original source without repair. A label
  above the source reads `Preview; expand for original`; expansion shows
  both the formatted view and
  the original source used for execution, storage, and error positions. No
  whole-system prompt change, formatter dependency, or input rewriting is used.
- **One row per host-call attempt.** Repeated names remain separate rows in
  invocation order, with `…` running, `✓` success, `✗` error, and `⊘` cancelled,
  argument previews and elapsed time. Permission/schema failures are attempts,
  not proof a host body ran. Collapsed views show the last eight calls, each in
  one width-bounded row; expansion shows all retained previews and error text.
  Pi's native shell supplies pending/success/error backgrounds; shortened call
  rows preserve that background through the ellipsis, duration and padding.
- **Live and restored records.** `onUpdate` publishes detached snapshots during
  execution; final `details.calls` retains up to 64 records after host cleanup.
  Each record keeps a name (128 UTF-8 bytes), argument preview (1,024 bytes),
  status, duration and optional error preview (512 bytes), never result bodies.
  Arguments are depth/item/string-limited before serialization, so expanded
  previews are still bounded and may be incomplete JSON. No additional full
  argument/output file is written. Legacy rows without call metadata do not
  invent calls or success states. Existing `details.toolCalls` remains unchanged;
  interpreter-only discovery is not fabricated as a timed host call.

Each result records monotonic elapsed milliseconds in `details.durationMs`,
including preflight, execution, and awaited host cleanup, on success, failure,
cancellation, and native-route rejection. The renderer prefers Pi's own recorded
row duration when available (which also includes Pi's surrounding hooks), and
uses the persisted extension duration for older SDKs/restored rows. During a
partial render, elapsed time is computed on redraw; no polling timer is created.
Legacy results without timing metadata simply omit the footer.

This is a **presentation-only** alignment: model-visible `content` remains the
bounded JSON/log/diagnostic text described above, without an extra execution
header. JSON encoding, error/warning semantics, routing, output budgets,
cancellation, and the OpenCode runtime are unchanged. Renderers use only public
Pi/TUI APIs; no native renderer internals or QuickJS execution are imported.

## Tests

`npm test` runs the offline unit/boundary suite, including literal 30-second timeout and delayed-cleanup probes. It does **not** install SDKs. The real-session suite skips unless you supply an explicit existing SDK package directory:

```sh
PI_OPENCODE_SDK=/path/to/node_modules/@earendil-works/pi-coding-agent npm test
```

Real-session tests use disposable directories, in-memory history/settings, scripted assistant streams, disabled model-network discovery, and safe in-memory stubs only. No personal resources, real model calls, or real mutation tools are used.

`npm run test:pi-versions` is a separate, **network/install-enabled** compatibility matrix. It installs dependencies into disposable copies and runs the full suite, including real-SDK sessions, against Pi 0.99.0, 1.3.0, and 1.4.0. See [TESTING.md](TESTING.md) for reproduction commands and coverage limits.

## Project information

- [Changes and 0.1.3 release notes](CHANGELOG.md)
- [Security policy and private reporting](SECURITY.md)
- [Bug reports and feature requests](https://github.com/hyein-cbio/pi-opencode-mode/issues)

Please include the extension, Pi, and Node versions in bug reports. Do not put
credentials, private tool results, or vulnerability details in public issues.
