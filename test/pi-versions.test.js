import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supportedVersions = ["0.99.0", "1.3.0", "1.4.0"];
const selected = process.env.PI_OPENCODE_TEST_VERSION;
assert.ok(!selected || supportedVersions.includes(selected), `PI_OPENCODE_TEST_VERSION must be one of ${supportedVersions.join(", ")}`);
const versions = selected ? [selected] : supportedVersions;
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

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
  test(`full suite with Pi SDK ${version}`, { timeout: 180_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-opencode-compat-"));
    try {
      const paths = new Set([...pkg.files, "package.json", "package-lock.json", "test"]);
      await Promise.all([...paths].map((path) => cp(join(root, path), join(dir, path), { recursive: true })));
      for (const args of [
        ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--package-lock=false",
          `@earendil-works/pi-coding-agent@${version}`, `@earendil-works/pi-tui@${version}`],
      ]) {
        const result = await run(args, dir);
        assert.equal(result.code, 0, result.output);
      }
      const sdk = join(dir, "node_modules/@earendil-works/pi-coding-agent");
      for (const name of ["pi-coding-agent", "pi-tui"]) {
        const installed = JSON.parse(await readFile(join(dir, `node_modules/@earendil-works/${name}/package.json`), "utf8"));
        assert.equal(installed.version, version, "test the requested host version, not an inherited installation");
      }
      const result = await run(["test"], dir, { PI_OPENCODE_SDK: sdk, FORCE_COLOR: "0" });
      assert.equal(result.code, 0, result.output);
      assert.ok(result.output.includes(`Actual SDK ${version};`), "the real-session suite must run");
      assert.match(result.output, /\bskipped 0\b/u, "compatibility runs must not skip SDK coverage");
      t.diagnostic(`Node ${process.version}; Pi ${version}; full suite passed with no skips`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
