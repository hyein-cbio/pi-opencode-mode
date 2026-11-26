import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { baseline } from "../codemode-versions.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supportedVersions = ["0.99.0", "1.5.0"];
const selected = process.env.PI_OPENCODE_TEST_VERSION;
assert.ok(!selected || supportedVersions.includes(selected), `PI_OPENCODE_TEST_VERSION must be one of ${supportedVersions.join(", ")}`);
const versions = selected ? [selected] : supportedVersions;
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
// The dispatcher resolves npm latest once. Never accept a tag/range or
// silently use the lockfile when an explicit override is malformed.
const override = process.env.PI_OPENCODE_CODEMODE_VERSION;
assert.ok(override === undefined || /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(override),
  "PI_OPENCODE_CODEMODE_VERSION must be an exact stable version, not a tag/range or empty value");
const codeModePath = "node_modules/@opencode/codemode";

function run(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    // A nested `node --test` otherwise inherits the outer runner marker and
    // silently skips running its files. Each copy needs an independent runner.
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

// Opt-in network/install suite. Never modifies the source checkout's dependency
// tree and never shares a fixed temp directory with other runs.
for (const version of versions) {
  const lane = `full suite with ${override ? `CodeMode ${override}` : "locked CodeMode"}`;
  test(`${lane} on Pi SDK ${version}`, { timeout: 180_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-opencode-compat-"));
    try {
      const paths = new Set([...pkg.files, "package.json", "package-lock.json", "test"]);
      await Promise.all([...paths].map((path) => cp(join(root, path), join(dir, path), { recursive: true })));
      const manifestBefore = await readFile(join(dir, "package.json"), "utf8");
      const lockBefore = await readFile(join(dir, "package-lock.json"), "utf8");
      const defaultLock = JSON.parse(lockBefore);
      const lockedCodeMode = defaultLock.packages[codeModePath].version;
      const codemodeVersion = override ?? lockedCodeMode;
      assert.equal(lockedCodeMode, baseline, "lockfile must use the legacy baseline");
      const baseFlags = ["--ignore-scripts", "--no-audit", "--no-fund"];
      const install = await run(["ci", ...baseFlags], dir);
      assert.equal(install.code, 0, install.output);
      const defaultPi = defaultLock.packages["node_modules/@earendil-works/pi-coding-agent"].version;
      const readPackage = async (path) => JSON.parse(await readFile(join(dir, path, "package.json"), "utf8"));
      assert.equal((await readPackage(codeModePath)).version, lockedCodeMode, "audit the default runtime before any override");
      for (const name of ["pi-coding-agent", "pi-tui"]) {
        const key = `node_modules/@earendil-works/${name}`;
        const installed = JSON.parse(await readFile(join(dir, key, "package.json"), "utf8"));
        assert.equal(installed.version, defaultLock.packages[key].version, "audit the default lockfile host before any override");
      }
      // Security gate for the lockfile tree, including peers, before any override.
      const audit = await run(["audit", "--audit-level=moderate"], dir);
      assert.equal(audit.code, 0, audit.output);
      t.diagnostic(`Default Pi/TUI ${defaultPi}: moderate/high audit passed before compatibility override`);
      if (version !== defaultPi || codemodeVersion !== lockedCodeMode) {
        // When replacing the SDK, pin CodeMode too: npm may otherwise resolve
        // the public range afresh instead of preserving the audited baseline.
        const alternate = await run(["install", ...baseFlags, "--no-save", "--package-lock=false",
          `@earendil-works/pi-coding-agent@${version}`, `@earendil-works/pi-tui@${version}`,
          `@opencode/codemode@${codemodeVersion}`,
        ], dir);
        assert.equal(alternate.code, 0, alternate.output);
      }
      assert.equal(await readFile(join(dir, "package.json"), "utf8"), manifestBefore, "keep release manifest unchanged");
      assert.equal(await readFile(join(dir, "package-lock.json"), "utf8"), lockBefore, "keep release lockfile unchanged");
      const installedCodeMode = await readPackage(codeModePath);
      assert.equal(installedCodeMode.version, codemodeVersion, "must execute the requested CodeMode, not the lockfile version");
      t.diagnostic(`Testing actual @opencode/codemode ${installedCodeMode.version}`);
      const sdk = join(dir, "node_modules/@earendil-works/pi-coding-agent");
      for (const name of ["pi-coding-agent", "pi-tui"]) {
        const installed = JSON.parse(await readFile(join(dir, `node_modules/@earendil-works/${name}/package.json`), "utf8"));
        assert.equal(installed.version, version, "test the requested host version, not an inherited installation");
      }
      if (override !== undefined) {
        // Fail visibly if npm latest is not yet an admitted runtime endpoint,
        // before running tests that expect live dispatch and wait for it.
        const { createOpenCodeModeExtension } = await import(pathToFileURL(join(dir, "index.js")).href);
        let tool;
        createOpenCodeModeExtension()({ registerTool(value) { tool = value; } });
        const admission = await tool.execute("runtime-version", { code: "return 42;" }, undefined, undefined, { tools: [] });
        assert.equal(admission.details.ok, true, admission.content[0].text);
      }
      const result = await run(["test"], dir, { PI_OPENCODE_SDK: sdk, FORCE_COLOR: "0" });
      assert.equal(result.code, 0, result.output);
      assert.ok(result.output.includes(`Actual SDK ${version};`), "the real-session suite must run");
      assert.ok(result.output.includes(`Pi loader uses CodeMode ${codemodeVersion} with its native input serialization`),
        "the Pi loader probe must exercise the exact selected release");
      assert.ok(result.output.includes(`CodeMode ${codemodeVersion} input conversion still passes through Pi validation and hooks`),
        "the real Pi session must verify the selected runtime’s input behavior");
      // Node 22 prints TAP `#` comments. Node 24's default reporter uses `ℹ`.
      const summaries = [...result.output.matchAll(/^\s*\S+\s+tests (\d+)\r?\n\s*\S+\s+suites \d+\r?\n\s*\S+\s+pass (\d+)\r?\n\s*\S+\s+fail (\d+)\r?\n\s*\S+\s+cancelled \d+\r?\n\s*\S+\s+skipped (\d+)/gm)];
      const inner = summaries.at(-1);
      assert.ok(inner, `inner suite must report its own pass/fail/skip counts\n${result.output.slice(-2000)}`);
      assert.ok(Number(inner[1]) > 0 && inner[1] === inner[2] && inner[3] === "0" && inner[4] === "0", result.output);
      t.diagnostic(`Inner suite tests ${inner[1]}, pass ${inner[2]}, fail ${inner[3]}, skipped ${inner[4]}`);
      t.diagnostic(`Node ${process.version}; Pi ${version}; ${lane} passed with no skips`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
