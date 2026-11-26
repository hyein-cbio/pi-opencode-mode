#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEMODE_PACKAGE as codemode, CODEMODE_VERSIONS, baseline } from "./codemode-versions.js";

const extension = "pi-opencode-mode";
const [legacyMajor, legacyMinor, legacyPatch] = baseline.split(".").map(Number);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u;
const packageRoot = dirname(fileURLToPath(import.meta.url));

export function selectCodeModeSpec(installed) {
  const match = versionPattern.exec(installed ?? "");
  if (match) {
    const [major, minor, patch] = match.slice(1).map(Number);
    if (major < legacyMajor || (major === legacyMajor &&
      (minor < legacyMinor || (minor === legacyMinor && patch <= legacyPatch)))) return baseline;
  }
  return "latest";
}

// Use Node's ESM resolution from each candidate, without importing or
// evaluating the old runtime. The package only exports an ESM entry point.
const probe = `
  import { readFileSync, statSync } from "node:fs";
  import { findPackageJSON } from "node:module";
  try {
    const entry = import.meta.resolve(${JSON.stringify(codemode)});
    if (statSync(new URL(entry)).isFile()) {
      const pkg = JSON.parse(readFileSync(findPackageJSON(entry), "utf8"));
      if (pkg.name === ${JSON.stringify(codemode)} && typeof pkg.version === "string") console.log(pkg.version);
    }
  } catch { /* No usable installation in this resolution context. */ }
`;

export function resolveCodeModeVersion(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  return versionPattern.test(output) ? output : undefined;
}

function runNpm(args, capture) {
  const npmCli = process.env.npm_execpath;
  const cli = npmCli?.endsWith("npm-cli.js") ? npmCli : process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") : undefined;
  return execFileSync(cli ? process.execPath : "npm", cli ? [cli, ...args] : args, {
    encoding: "utf8", stdio: ["ignore", capture ? "pipe" : 2, 2],
  });
}

export function install({
  cwd = process.cwd(),
  agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  from,
  npm = runNpm,
} = {}) {
  const agentRoot = resolve(cwd, agentDir.replace(/^~(?=[/\\]|$)/u, () => homedir()));
  const prefix = join(agentRoot, `${extension}-runtime`);
  const target = join(prefix, "node_modules", extension);
  const candidates = [from && resolve(cwd, from), target,
    join(cwd, ".pi", "npm", "node_modules", extension),
    join(agentRoot, "npm", "node_modules", extension), cwd];
  let installed;
  for (const dir of new Set(candidates.filter(Boolean))) {
    installed = resolveCodeModeVersion(dir);
    if (installed) break;
  }

  const spec = selectCodeModeSpec(installed);
  const version = spec === "latest"
    ? JSON.parse(npm(["view", `${codemode}@latest`, "version", "--json", "--prefer-online"], true)) : spec;
  if (typeof version !== "string" || !versionPattern.test(version)) {
    throw new Error(`npm did not return a version for ${codemode}@latest`);
  }
  if (!CODEMODE_VERSIONS.includes(version)) {
    throw new Error(`${codemode}@${version} (npm latest) is not verified by this extension. ` +
      `Verified versions: ${CODEMODE_VERSIONS.join(", ")}. No installation was changed.`);
  }
  console.error(`CodeMode: ${installed ?? "not found"} → ${version} (${spec === "latest" ? "npm latest" : "legacy pin"})`);

  mkdirSync(prefix, { recursive: true });
  try {
    writeFileSync(join(prefix, "package.json"), '{"name":"pi-opencode-mode-runtime","private":true}\n', { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  // Save the selected exact dependency in a private npm project. Do not
  // modify the source checkout or Pi's shared npm dependency tree.
  npm(["install", "--prefix", prefix, "--install-links", "--save", "--save-exact", "--legacy-peer-deps",
    "--ignore-scripts", "--no-audit", "--no-fund", packageRoot, `${codemode}@${version}`], false);
  const manifest = JSON.parse(readFileSync(join(prefix, "package.json"), "utf8"));
  if (manifest.dependencies?.[codemode] !== version) {
    throw new Error(`npm did not save the exact ${codemode}@${version} requirement`);
  }
  if (!existsSync(join(target, "index.js")) || resolveCodeModeVersion(target) !== version) {
    throw new Error(`The installed ${extension} did not resolve ${codemode}@${version}`);
  }
  return target;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
      console.log("Usage: pi-opencode-mode-install [--from EXISTING_CONTEXT_DIRECTORY]");
    } else {
      if (args.length && (args.length !== 2 || args[0] !== "--from" || !statSync(args[1], { throwIfNoEntry: false })?.isDirectory())) {
        throw new Error("Usage: pi-opencode-mode-install [--from EXISTING_CONTEXT_DIRECTORY]");
      }
      console.log(install({ from: args[1] }));
    }
  } catch (error) {
    console.error(`pi-opencode-mode-install: ${error.message}`);
    process.exitCode = 1;
  }
}
