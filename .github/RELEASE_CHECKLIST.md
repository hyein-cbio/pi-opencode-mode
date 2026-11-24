# Maintainer release checklist

Preparation does not publish anything. Repository visibility, npm publication,
and release/tag creation are explicit maintainer actions.

## Before publishing

- [ ] Review the diff; ensure `package.json`, the lockfile top level and its root
      package entry all agree on the release version. Check that the CodeMode
      dependency accepts only verified releases, the lockfile uses the chosen
      baseline (`2.3.0`), and Effect and Acorn stay exact.
- [ ] Check that the release notes explain how custom `toJSON()` differs between
      supported CodeMode versions.
- [ ] Run `npm ci`, `npm audit`, and the clean-copy suites for each supported
      CodeMode release (see [TESTING.md](../TESTING.md)).
- [ ] Configure `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` Actions secrets, keep
      `Node/Pi compatibility on Modal` out of required pull-request checks, and
      confirm all sixteen full compatibility cells pass after changes reach `main`.
- [ ] Inspect `npm pack --dry-run --json`; check for secrets in the tree and history.
- [ ] Check the README walkthrough with a configured model and inspect the TUI.
- [ ] Review `CHANGELOG.md`, supported versions, and known limits.

## Maintainer-controlled publication

- [ ] Change repository visibility to public when ready.
- [ ] Enable **Settings → Security → Private vulnerability reporting** after the
      repository is public, and verify the reporting link in `SECURITY.md` works.
- [ ] For npm publication, remove `private: true`, verify the npm package name
      is available to your account, and recheck the manifest/lockfile and tarball.
- [ ] Mark the Unreleased changelog entry with the version and actual date,
      create the corresponding tag and GitHub release, and publish the package
      version to npm.
- [ ] Verify the GitHub tag, npm version, and installation from the published
      artifact. Keep the README and security policy aligned with the release.

Do not advertise an npm package or tag before it exists. No workflow in this
repository publishes packages or changes repository visibility.
