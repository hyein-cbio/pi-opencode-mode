# Security policy

## Supported versions

Security fixes target the latest released version, currently **0.1.0**.
See [CHANGELOG.md](CHANGELOG.md) for release history.

## Reporting a vulnerability

Do **not** disclose vulnerabilities, credentials, or private tool results in a
public issue or pull request.

Use GitHub's private vulnerability reporting form:

https://github.com/hyein-cbio/pi-opencode-mode/security/advisories/new

If the form is unavailable, open an issue asking only for a private reporting
channel, with no technical details or sensitive data. Wait for the maintainer
to arrange private contact before sending your report.

Include the affected commit/version, Node and Pi versions, a minimal reproducer
using safe mock tools, expected/actual behavior, and likely impact. Do not test
against other people's systems or include real secrets. Response times are
best-effort; this project has no guaranteed security-response SLA.

## Trust boundary

- Installing this extension executes trusted extension code in Pi's host process.
- Guest programs can invoke the tools already callable in their session, through
  Pi's validation and permission/result hooks. Review the tools you enable.
- The OpenCode interpreter is **not** an OS sandbox or memory-isolation boundary.
  Routing limits are compatibility checks, not an authorization boundary.
- Cancellation is cooperative, and cannot undo completed side effects. A host
  tool that never settles can prevent result delivery beyond the nominal deadline.
- Text-output limits do not bound host allocations, the complete transcript, or
  diagnostic/audit metadata outside the documented budgets.

See the [README execution contract](README.md#execution-and-output-contract)
for exact limits.
