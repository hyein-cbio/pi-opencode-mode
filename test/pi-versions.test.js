import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const versions = [
  { version: "0.87.1", support: "before" },
  { version: "0.99.0", support: "minimum" },
  { version: "0.99.1", support: "supported" },
  { version: "0.99.2", support: "supported" },
  { version: "1.0.0", support: "after" },
  { version: "1.2.0", support: "after", optionalInstall: true },
];

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function installSdk(version) {
  const dir = join(tmpdir(), "pi-opencode-sdks", version);
  await rm(dir, { recursive: true, force: true });
  const { code, stderr } = await run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", dir,
    `@earendil-works/pi-coding-agent@${version}`,
  ], root);
  if (code !== 0) {
    const error = new Error(`install ${version} failed\n${stderr}`);
    error.installFailure = true;
    throw error;
  }
  return dir;
}

async function probe(version, prefix) {
  const script = `
    import { mkdtemp } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const version = ${JSON.stringify(version)};
    const prefix = ${JSON.stringify(prefix)};
    const extension = ${JSON.stringify(join(root, "index.js"))};
    const pi = await import(join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
    let builtins = [];
    try {
      builtins = (await import(join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/extensions/index.js"))).builtInExtensions ?? [];
    } catch (error) {
      builtins = [];
    }
    const { readFileSync } = await import("node:fs");
    const types = readFileSync(join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts"), "utf8");
    const toolDefinition = types.slice(types.indexOf("export interface ToolDefinition"), types.indexOf("export declare function defineTool"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-opencode-agent-"));
    const paths = [extension];
    if (builtins.some((entry) => entry.name === "codemode")) paths.push("builtin:codemode");
    const loader = new pi.DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: pi.SettingsManager.inMemory({ defaultTools: ["codemode"] }),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "offline",
      additionalExtensionPaths: paths,
      extensionFactories: builtins,
    });
    const receipt = {
      version,
      createCodemodeExtension: typeof pi.createCodemodeExtension,
      executeToolOnContext: toolDefinition.includes("ctx: ExtensionToolContext"),
      builtinNames: builtins.map((entry) => entry.name),
    };
    try {
      await loader.reload();
      const loaded = loader.getExtensions();
      receipt.errors = loaded.errors;
      receipt.extensions = loaded.extensions.map((extension) => ({
        path: extension.path,
        replaceable: extension.replaceable === true,
        tools: [...extension.tools.keys()],
      }));
      const opencode = [];
      for (const extension of loaded.extensions) {
        for (const registered of extension.tools.values()) {
          if (registered.definition?.name === "codemode_o") opencode.push(registered.definition);
        }
      }
      receipt.paths = receipt.extensions.map((extension) => extension.path);
      receipt.builtinCodemodeLoaded = receipt.paths.includes("builtin:codemode");
      receipt.opencodeCount = opencode.length;
      if (builtins.some((entry) => entry.name === "codemode")) {
        const controlDir = await mkdtemp(join(tmpdir(), "pi-opencode-control-"));
        const control = new pi.DefaultResourceLoader({
          cwd: controlDir,
          agentDir: controlDir,
          settingsManager: pi.SettingsManager.inMemory({ defaultTools: ["codemode"] }),
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          systemPrompt: "offline",
          additionalExtensionPaths: ["builtin:codemode"],
          extensionFactories: builtins,
        });
        await control.reload();
        const controlLoaded = control.getExtensions();
        receipt.controlErrors = controlLoaded.errors;
        receipt.controlPaths = controlLoaded.extensions.map((extension) => extension.path);
      }
      const tool = opencode[0];
      receipt.label = tool?.label;
      receipt.toolName = tool?.name;
      if (tool) {
        const plain = await tool.execute("probe", { code: "return 40 + 2" }, undefined, undefined, { tools: [], async executeTool() { throw new Error("unused"); } });
        receipt.plain = plain.content?.[0]?.text;
        receipt.plainError = plain.isError === true;
        let seen;
        const bridged = await tool.execute("probe-tool", { code: "const value = await tools.echo({ value: 7 }); return value;" }, undefined, undefined, {
          tools: [{ name: "echo", description: "echo", parameters: { type: "object" } }, { name: "codemode", description: "self" }],
          async executeTool(name, args) {
            seen = { name, args };
            return { isError: false, result: { content: [], structuredContent: args.value } };
          },
        });
        receipt.bridged = bridged.content?.[0]?.text;
        receipt.seen = seen;
      }
    } catch (error) {
      receipt.loadError = error instanceof Error ? error.message : String(error);
    }
    console.log(JSON.stringify(receipt));
  `;
  const { code, stdout, stderr } = await run(process.execPath, ["--input-type=module", "-e", script], root);
  if (code !== 0) throw new Error(`${version} probe exited ${code}\n${stderr}\n${stdout}`);
  const line = stdout.trim().split("\n").at(-1);
  return JSON.parse(line);
}

test("pi SDKs around 0.99 load OpenCode codemode", { timeout: 600_000 }, async () => {
  const receipts = [];
  for (const entry of versions) {
    let prefix;
    try {
      prefix = await installSdk(entry.version);
      const receipt = await probe(entry.version, prefix);
      receipts.push({ ...entry, ...receipt });
    } catch (error) {
      if (!entry.optionalInstall || !error.installFailure) throw error;
      receipts.push({ ...entry, installSkipped: true, installError: error.message.split("\n")[0] });
    } finally {
      if (prefix) await rm(prefix, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(receipts, null, 2));

  for (const receipt of receipts.filter((entry) => entry.support !== "before" && !entry.installSkipped)) {
    assert.equal(receipt.loadError, undefined, receipt.version);
    assert.deepEqual(receipt.errors, [], receipt.version);
    assert.equal(receipt.opencodeCount, 1, receipt.version);
    assert.equal(receipt.toolName, "codemode_o", receipt.version);
    assert.equal(receipt.label, "codemode_o (OpenCode)", receipt.version);
    assert.equal(receipt.plain, "42", receipt.version);
    assert.equal(receipt.plainError, false, receipt.version);
    assert.equal(receipt.bridged, "7", receipt.version);
    assert.deepEqual(receipt.seen, { name: "echo", args: { value: 7 } }, receipt.version);
    assert.equal(receipt.createCodemodeExtension, "function", receipt.version);
    assert.equal(receipt.executeToolOnContext, true, receipt.version);
    assert.equal(receipt.builtinNames.includes("codemode"), true, receipt.version);
    assert.equal(receipt.builtinCodemodeLoaded, true, receipt.version);
    assert.deepEqual(receipt.controlErrors, [], receipt.version);
    assert.equal(receipt.controlPaths.includes("builtin:codemode"), true, receipt.version);
  }

  const before = receipts.find((entry) => entry.version === "0.87.1");
  assert.equal(before.createCodemodeExtension, "undefined");
  assert.equal(before.executeToolOnContext, false);
  assert.equal(before.builtinNames.includes("codemode"), false);
  assert.equal(before.plain, "42");
});
