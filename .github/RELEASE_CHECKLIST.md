# Maintainer release checklist — 0.2.0

Preparation does not publish anything. Repository visibility, npm publication,
and release/tag creation are explicit maintainer actions.

## Before publishing

- [ ] Review the diff; ensure `package.json`, the lockfile top level and its root
      package entry all say `0.2.0`, and runtime pins are CodeMode `2.2.6`,
      Effect `4.1.0`, and Acorn `8.15.0`.
- [ ] Check that the 0.2.0 notes distinguish synthetic path measurements from
      whole-app latency and describe coalesced frames/first-use backend loading.
- [ ] Run `npm ci`, `npm audit`, and `npm run test:pi-versions`.
- [ ] Configure `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` Actions secrets, migrate
      required checks to `Node/Pi compatibility on Modal`, and confirm its six
      Modal matrix cells pass after the changes are pushed.
- [ ] Inspect `npm pack --dry-run --json`; check for secrets in the tree and history.
- [ ] Check the README walkthrough with a configured model and inspect the TUI.
- [ ] Review `CHANGELOG.md`, supported versions, and known limits.

## Maintainer-controlled publication

- [ ] Change repository visibility to public when ready.
- [ ] Enable **Settings → Security → Private vulnerability reporting** after the
      repository is public, and verify the reporting link in `SECURITY.md` works.
- [ ] For npm publication, remove `private: true`, verify the npm package name
      is available to your account, and recheck the manifest/lockfile and tarball.
- [ ] Mark the `0.2.0 — Unreleased` changelog entry released with the actual date,
      create the `v0.2.0` tag and GitHub release, and publish the intended package
      version to npm.
- [ ] Verify installation from the published source, then advance the README's
      previous-release commands to the confirmed `0.2.0` npm/tag commands and
      update its preparation notice and the supported version in `SECURITY.md`.

Do not advertise an npm package or tag before it exists. No workflow in this
repository publishes packages or changes repository visibility.
