# pi-opencode-mode

Pi extension that registers `codemode_o` with OpenCode CodeMode v2 (`@opencode/codemode` 2.1.0). Pi's built-in `codemode` stays in place. A program calls pi tools that are already callable:

```js
const text = await tools.read({ path: "README.md" });
return text.length;
```

`route.js` performs static preflight selection before a `codemode_o` call can execute. Short OpenCode-subset programs select `codemode_o`; Pi-specific or uncertain programs select native `codemode`. The built-in tool remains unchanged. There is no QuickJS implementation, store, model catalog, or Luau runtime in this package.

## Routing

`selectCodemodeRoute({ code, requested: "auto" })` returns an immutable `{ decision, route, reasons, executesSource: false }` without evaluating source. An explicit `requested: "codemode"` always stays native. `requested: "codemode_o"` still requires preflight approval.

- OpenCode candidates are at most **8,192 UTF-8 source bytes**, **100 lines**, **2,000 AST nodes**, and **64 AST levels**. Acorn parses source without executing it; a conservative syntax allowlist rejects unknown syntax.
- Pi globals (`text`, `image`, `exit`, `store`, `load`, `ALL_TOOLS`, `searchTools`, `describeTool`, `describeNamespace`, `models`), options comments (`@options:`), classes, regex/BigInt literals, generators, accessors, and uncertain constructors stay native. Only standard error constructors are admitted. Comments, strings, and ordinary property names do not count as global references; shadowed Pi names conservatively stay native.
- This is a compatibility heuristic, **not** a full JavaScript semantic validator, cost estimator, or security boundary. Tool availability, values, built-in methods, runtime failures, and actual running time cannot be proven statically. Native selection does not guarantee that native Pi supports the program either.
- Native Pi `codemode` is **model-only**, so this extension cannot invoke it through `ctx.executeTool`. When preflight selects native, `codemode_o` returns `NativeCodemodeRequired` **before constructing the runtime or calling any host tool**. The caller must invoke the active built-in `codemode` itself, using its raw-source input contract. If it is disabled, enable it first. No tool name rewriting or permission bypass is used.
- Results include the preflight decision in `details.route`. Once OpenCode execution starts, any failure stays an OpenCode failure: **no automatic fallback, retry, or replay**, since host tools may already have produced effects.

Load it from this directory with `pi -e /path/to/pi-opencode-mode`.

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

- [x] Align `codemode_o` with native Pi `codemode`, including concise execution time.

The TUI shows a syntax-highlighted source preview (10 visual lines), a compact
result preview (5 visual lines), and the native-style muted `Took 0.1s` footer.
Use Pi\'s configured tool-expansion shortcut to see the full retained source or
output. Limits count wrapped terminal lines, including long JSON and Unicode.
Warnings and incomplete-output indicators remain visible above collapsed data.

Each result records monotonic elapsed milliseconds in `details.durationMs`,
including preflight, execution, and awaited host cleanup, on success, failure,
cancellation, and native-route rejection. The renderer prefers Pi\'s own recorded
row duration when available (which also includes Pi\'s surrounding hooks), and
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
