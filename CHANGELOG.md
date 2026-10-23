# Changelog

## 0.1.0 — unreleased

Initial public-release preparation. No release tag or npm publication is implied
by this entry.

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
