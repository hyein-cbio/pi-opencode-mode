# pi-opencode-mode

A small Pi extension that leaves native `codemode` in place and lets you choose OpenCode CodeMode too.

It registers **`codemode_o`**, backed by `@opencode/codemode` 2.1.0: another execution option for short, self-contained JavaScript-like programs that call Pi tools. Host calls retain Pi's validation, permission/result hooks, and nested-call audit; cancellation waits for host cleanup, and output keeps bounded, visible diagnostics.

This is not a claim that OpenCode is faster or safer than native `codemode`. There is no comparative benchmark here. Both can batch tool calls; the reason to install this extension is to use the OpenCode interpreter in Pi without replacing the native tool. You choose the tool: preflight can reject an unsuitable OpenCode program, but never switches tools or falls back automatically.

## Quick start

Requires **Node.js >= 22.19**, npm, Git, and an installed Pi CLI with a configured model/provider. Check `node --version` and `pi --version`; if you are new to Pi, see its [quickstart](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md). In Pi, `/login` configures a provider and `/model` chooses a model. The extension does not need an OpenCode account or server; asking Pi to call it still uses your configured model.

1. **Install this checkout's dependencies.** The package is currently private; use a local checkout rather than an npm package name.

   ```sh
   git clone https://github.com/hyein-cbio/pi-opencode-mode.git
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

If the tool is missing, check startup load errors and the absolute `-e` path, run `npm ci` in the checkout, and restart with the explicit tool list above. An `UnknownTool` for a guest call means that host tool is not callable in that session; inspect the catalog below. `NativeCodemodeRequired` means the source did **not** run—use native `codemode` for it. Never automatically replay a program after an execution failure: host effects may already have occurred.

## When to choose which tool

Choose `codemode_o` when you already work with OpenCode CodeMode and want to reuse a short program's control flow in Pi, adapting host-tool names and arguments to the current catalog. It gives you the same interpreter family and `search(...)` interface, while Pi-native workflows can keep using `codemode`. Programs still have to fit this extension's supported subset and limits.

| Need | Choose |
| --- | --- |
| Deliberately use the OpenCode interpreter for a short, fresh program that awaits tools and returns JSON | `codemode_o` |
| Batch independent tool calls or summarize results before the model sees them | Either; this is not an OpenCode-only advantage |
| Pi's `text()`, `image()`, `exit()`, `store()`/`load()`, `models`, or native discovery helpers | Native `codemode` |
| Longer programs, broader JavaScript syntax, or Pi's `// @options:` controls | Native `codemode` |

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

## Routing

`selectCodemodeRoute({ code, requested: "auto" })` returns an immutable `{ decision, route, reasons, executesSource: false }` without evaluating source. An explicit `requested: "codemode"` always stays native. `requested: "codemode_o"` still requires preflight approval.

- OpenCode candidates are at most **8,192 UTF-8 source bytes**, **100 lines**, **2,000 AST nodes**, and **64 AST levels**. Acorn parses source without executing it; a conservative syntax allowlist rejects unknown syntax.
- Pi globals (`text`, `image`, `exit`, `store`, `load`, `ALL_TOOLS`, `searchTools`, `describeTool`, `describeNamespace`, `models`), options comments (`@options:`), classes, regex/BigInt literals, generators, accessors, and uncertain constructors stay native. Only standard error constructors are admitted. Comments, strings, and ordinary property names do not count as global references; shadowed Pi names conservatively stay native.
- This is a compatibility heuristic, **not** a full JavaScript semantic validator, cost estimator, or security boundary. Tool availability, values, built-in methods, runtime failures, and actual running time cannot be proven statically. Native selection does not guarantee that native Pi supports the program either.
- Native Pi `codemode` is **model-only**, so this extension cannot invoke it through `ctx.executeTool`. When preflight selects native, `codemode_o` returns `NativeCodemodeRequired` **before constructing the runtime or calling any host tool**. The caller must invoke the active built-in `codemode` itself, using its raw-source input contract. If it is disabled, enable it first. No tool name rewriting or permission bypass is used.
- Results include the preflight decision in `details.route`. Once OpenCode execution starts, any failure stays an OpenCode failure: **no automatic fallback, retry, or replay**, since host tools may already have produced effects.

`@earendil-works/pi-coding-agent` >= 0.99.0 is the declared peer dependency. 0.99.0 is the first release whose tool context can call other tools and whose built-in `codemode` exists. The older loader probes are not full session compatibility tests; the lifecycle regressions below have been verified with actual Pi SDK **1.3.0 and 1.4.0** sessions, not every version in the peer range.

## Execution and output contract

- Each preflight-approved call creates a fresh OpenCode runtime: interruption after **30,000 ms**, at most **64 tool calls**. Static routing runs first; no automatic fallback or replay. Pi's built-in `codemode` stays unchanged, and neither code tool is callable from the guest.
- All host calls use `ctx.executeTool`, preserving Pi's validation, permission/result hooks, and nested-call audit. The host receives both outer user cancellation and Effect interruption (including early return and race-loser cleanup at program completion). Host promises are drained before the root result is delivered, including asynchronous cleanup and hooks.
- Cancellation is cooperative, not rollback. A host tool that ignores its signal can still perform effects; one that never settles can prevent result delivery indefinitely. The 30-second deadline requests interruption, **not a hard wall-clock return guarantee**. Await your work and use only trusted, cancellation-aware tools. This interpreter is not an OS or memory-isolation sandbox and does not implement all JavaScript semantics.
- **65,536 UTF-8 bytes** bounds the extension's final `content` text, after JSON encoding, logs, error messages, warnings, separators, and truncation notices. It does not bound the entire Pi message/envelope, `details`, tool names/audit metadata, upstream allocations, or later output added by other extensions.
- Ordinary complete values retain JSON encoding (`42`, `"text"`, etc.); logs precede the value. Errors and warnings take precedence over data. Warnings remain successful if upstream reports success, but appear in both model-visible text and `details.warnings`. No warning causes a retry.
- Upstream or final-render truncation sets `details.truncated: true` and adds a visible notice. Data following that notice is an **incomplete preview, not complete JSON**. No full output is written to disk. Return smaller data when completeness matters.
- Structured error/warning diagnostics have a separate **8 KiB serialized budget**, shared between error and warnings, with bounded messages (1,024 bytes), kinds (64 bytes), and suggestions (up to three, 128 bytes each). Clipping/omission adds a `Truncated` warning; diagnostics cannot be crowded out by logs or return data. Locations and bounded suggestions remain in details.
- Host structured results take precedence over text; otherwise text blocks are joined with newlines. Non-text-only/multimodal host results without structured data are rejected.

## Output presentation

The TUI shows a syntax-highlighted source preview (10 visual lines), a compact
result preview (5 visual lines), and the native-style muted `Took 0.1s` footer.
Use Pi's configured tool-expansion shortcut to see the full retained source or
output. Limits count wrapped terminal lines, including long JSON and Unicode.
Warnings and incomplete-output indicators remain visible above collapsed data.

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

`npm run test:pi-versions` is a separate, **network/install-enabled** historical loader/mock-context matrix; run it only deliberately. It is not proof of full session compatibility. See [TESTING.md](TESTING.md) for before/after evidence and scope.
