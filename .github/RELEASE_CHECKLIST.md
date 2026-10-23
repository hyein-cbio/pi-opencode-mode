# Maintainer release checklist — 0.1.0

Preparation does not publish anything. Repository visibility, npm publication,
and release/tag creation are explicit maintainer actions.

## Before publishing

- [ ] Review the diff; ensure `package.json` and `package-lock.json` both say `0.1.0`.
- [ ] Run `npm ci`, `npm audit`, and `npm run test:pi-versions`.
- [ ] Confirm all six GitHub CI jobs pass after the changes are pushed.
- [ ] Inspect `npm pack --dry-run --json`; check for secrets in the tree and history.
- [ ] Check the README walkthrough with a configured model and inspect the TUI.
- [ ] Review `CHANGELOG.md`, supported versions, and known limits.

## Maintainer-controlled publication

- [ ] Change repository visibility to public when ready.
- [ ] Enable **Settings → Security → Private vulnerability reporting** after the
      repository is public, and verify the reporting link in `SECURITY.md` works.
- [ ] For npm publication, remove `private: true`, verify the npm package name
      is available to your account, and recheck the manifest/lockfile and tarball.
- [ ] Mark the `0.1.0` changelog entry released, create the `v0.1.0` tag and GitHub
      release, and publish the intended package version to npm.
- [ ] Verify installation from the published source, then update the README with
      the confirmed npm and/or tagged Git install command.

Do not advertise an npm package or tag before it exists. No workflow in this
repository publishes packages or changes repository visibility.
