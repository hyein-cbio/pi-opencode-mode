# pi-opencode-mode

Pi extension that registers `codemode_o` with OpenCode CodeMode v2 (`@opencode/codemode` 2.1.0). Pi's built-in `codemode` stays in place. A program calls pi tools that are already callable:

```js
const text = await tools.read({ path: "README.md" });
return text.length;
```

`route.js` is a TODO scaffold for choosing `codemode` or `codemode_o` before execution. The extension does not call it, so a `codemode_o` call runs OpenCode directly. There is no QuickJS path, store, model catalog, or Luau runtime in this package.

Load it from this directory with `pi -e /path/to/pi-opencode-mode`.

`@earendil-works/pi-coding-agent` >= 0.99.0 is the declared peer dependency. 0.99.0 is the first release whose tool context can call other tools and whose built-in `codemode` exists. The older loader probes are not full session compatibility tests; the lifecycle regressions below have been verified with actual Pi SDK **1.3.0 and 1.4.0** sessions, not every version in the peer range.

## Execution and output contract

- Each call creates a fresh OpenCode runtime: interruption after **30,000 ms**, at most **64 tool calls**. No router, fallback, or automatic replay. Pi's built-in `codemode` stays unchanged, and neither code tool is callable from the guest.
- All host calls use `ctx.executeTool`, preserving Pi's validation, permission/result hooks, and nested-call audit. The host receives both outer user cancellation and Effect interruption (including early return and race-loser cleanup at program completion). Host promises are drained before the root result is delivered, including asynchronous cleanup and hooks.
- Cancellation is cooperative, not rollback. A host tool that ignores its signal can still perform effects; one that never settles can prevent result delivery indefinitely. The 30-second deadline requests interruption, **not a hard wall-clock return guarantee**. Await your work and use only trusted, cancellation-aware tools. This interpreter is not an OS or memory-isolation sandbox and does not implement all JavaScript semantics.
- **65,536 UTF-8 bytes** bounds the extension's final `content` text, after JSON encoding, logs, error messages, warnings, separators, and truncation notices. It does not bound the entire Pi message/envelope, `details`, tool names/audit metadata, upstream allocations, or later output added by other extensions.
- Ordinary complete values retain JSON encoding (`42`, `"text"`, etc.); logs precede the value. Errors and warnings take precedence over data. Warnings remain successful if upstream reports success, but appear in both model-visible text and `details.warnings`. No warning causes a retry.
- Upstream or final-render truncation sets `details.truncated: true` and adds a visible notice. Data following that notice is an **incomplete preview, not complete JSON**. No full output is written to disk. Return smaller data when completeness matters.
- Structured error/warning diagnostics have a separate **8 KiB serialized budget**, shared between error and warnings, with bounded messages (1,024 bytes), kinds (64 bytes), and suggestions (up to three, 128 bytes each). Clipping/omission adds a `Truncated` warning; diagnostics cannot be crowded out by logs or return data. Locations and bounded suggestions remain in details.
- Host structured results take precedence over text; otherwise text blocks are joined with newlines. Non-text-only/multimodal host results without structured data are rejected.

## Tests

`npm test` runs the offline unit/boundary suite, including literal 30-second timeout and delayed-cleanup probes. It does **not** install SDKs. The real-session suite skips unless you supply an explicit existing SDK package directory:

```sh
PI_OPENCODE_SDK=/path/to/node_modules/@earendil-works/pi-coding-agent npm test
```

Real-session tests use disposable directories, in-memory history/settings, scripted assistant streams, disabled model-network discovery, and safe in-memory stubs only. No personal resources, real model calls, or real mutation tools are used.

`npm run test:pi-versions` is a separate, **network/install-enabled** historical loader/mock-context matrix; run it only deliberately. It is not proof of full session compatibility. See [TESTING.md](TESTING.md) for before/after evidence and scope.
