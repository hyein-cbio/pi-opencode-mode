import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { install, resolveCodeModeVersion, selectCodeModeSpec } from "../install.js";
import { baseline, verifiedLatest } from "../codemode-versions.js";

const name = "@opencode/codemode";
const extension = "pi-opencode-mode";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-opencode-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const prefix = join(agentDir, `${extension}-runtime`);
  const target = join(prefix, "node_modules", extension);
  const shared = join(agentDir, "npm", "node_modules", extension);
  return { agentDir, cwd, prefix, target, shared };
}

function writeCodeMode(dir, version, { missingEntry = false } = {}) {
  const pkg = join(dir, "node_modules", name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version, exports: { import: "./entry.mjs" } }));
  if (!missingEntry) writeFileSync(join(pkg, "entry.mjs"), 'throw new Error("The installer must never evaluate this entry");');
}

function stubNpm(f, version, { latest, installed = version } = {}) {
  const calls = [];
  function npm(args, capture) {
    calls.push(args[0]);
    if (args[0] === "view") {
      assert.equal(capture, true);
      assert.deepEqual(args.slice(1), [`${name}@latest`, "version", "--json", "--prefer-online"]);
      return JSON.stringify(latest);
    }
    assert.equal(capture, false);
    assert.equal(args[0], "install");
    assert.equal(args[args.indexOf("--prefix") + 1], f.prefix);
    assert.ok(args.includes("--save"));
    assert.ok(args.includes("--save-exact"));
    assert.ok(args.includes("--ignore-scripts"));
    assert.equal(args.at(-1), `${name}@${version}`);
    const path = join(f.prefix, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(manifest.private, true);
    writeFileSync(path, JSON.stringify({ ...manifest, dependencies: { [name]: version } }));
    writeCodeMode(f.target, installed);
    writeFileSync(join(f.target, "index.js"), "");
  }
  return { npm, calls };
}

test("version threshold chooses the exact baseline or asks for npm latest", () => {
  for (const version of ["1.18.9", "2.2.99", "2.3.0-rc.1", "2.3.0", "2.3.0+custom"]) {
    assert.equal(selectCodeModeSpec(version), "2.3.0");
  }
  for (const version of [undefined, "unknown", "2.3.1", "2.10.0", "3.0.0"]) {
    assert.equal(selectCodeModeSpec(version), "latest");
  }
});

test("detects an older ESM-only runtime in the previous Pi install before invoking npm", (t) => {
  const f = fixture(t);
  writeCodeMode(f.shared, "2.2.7");
  writeCodeMode(f.cwd, "2.4.1");
  const { npm, calls } = stubNpm(f, "2.3.0");
  assert.equal(install({ ...f, npm }), f.target);
  assert.deepEqual(calls, ["install"]);
  assert.equal(resolveCodeModeVersion(f.shared), "2.2.7", "shared Pi npm path is unchanged");
  assert.equal(resolveCodeModeVersion(f.target), "2.3.0");
});

test("a selected 2.3.0 remains pinned on reinstall, unless an explicit context is chosen", (t) => {
  const f = fixture(t);
  writeCodeMode(f.target, "2.3.0");
  let { npm, calls } = stubNpm(f, "2.3.0");
  assert.equal(install({ ...f, npm }), f.target);
  assert.deepEqual(calls, ["install"]);

  writeCodeMode(f.cwd, "2.3.1");
  ({ npm, calls } = stubNpm(f, verifiedLatest, { latest: verifiedLatest }));
  assert.equal(install({ ...f, from: ".", npm }), f.target);
  assert.deepEqual(calls, ["view", "install"]);
});

for (const context of [undefined, "missing-entry", "2.3.1", "2.4.1"]) {
  test(`resolves latest at install time for ${context ?? "no existing runtime"}`, (t) => {
    const f = fixture(t);
    if (context) writeCodeMode(f.cwd, context === "missing-entry" ? "2.3.0" : context, { missingEntry: context === "missing-entry" });
    const { npm, calls } = stubNpm(f, verifiedLatest, { latest: verifiedLatest });
    assert.equal(install({ ...f, npm }), f.target);
    assert.deepEqual(calls, ["view", "install"]);
    assert.equal(resolveCodeModeVersion(f.target), verifiedLatest);
  });
}

test("a failed latest lookup cannot install an older substitute", (t) => {
  const f = fixture(t);
  assert.throws(() => install({ ...f, npm(args) {
    assert.equal(args[0], "view");
    throw new Error("registry offline");
  } }), /registry offline/);
  assert.equal(existsSync(f.prefix), false);
});

test("an unverified npm latest does not replace a working install", (t) => {
  const f = fixture(t);
  writeCodeMode(f.target, verifiedLatest);
  const path = join(f.prefix, "package.json");
  const manifest = JSON.stringify({ private: true, dependencies: { [name]: verifiedLatest } });
  writeFileSync(path, manifest);
  const [major, minor, patch] = verifiedLatest.split(".");
  const latest = `${major}.${minor}.${Number(patch) + 1}`;
  const { npm, calls } = stubNpm(f, latest, { latest });
  assert.throws(() => install({ ...f, npm }), /npm latest.*not verified.*No installation was changed/);
  assert.deepEqual(calls, ["view"]);
  assert.equal(readFileSync(path, "utf8"), manifest);
  assert.equal(resolveCodeModeVersion(f.target), verifiedLatest);
});

test("unexpected installed resolution fails instead of reporting success", (t) => {
  const f = fixture(t);
  const { npm } = stubNpm(f, verifiedLatest, { latest: verifiedLatest, installed: baseline });
  assert.throws(() => install({ ...f, npm }), { message: `The installed ${extension} did not resolve ${name}@${verifiedLatest}` });
});
