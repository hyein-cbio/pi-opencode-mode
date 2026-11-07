import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenCodeModeExtension } from "../index.js";

const exec = promisify(execFile);
const modules = async () => {
  const [{ CodeMode, Tool, toolError }, { Effect }] = await Promise.all([import("@opencode/codemode"), import("effect")]);
  return { CodeMode, Tool, toolError, Effect };
};
function tool(options) {
  let definition;
  createOpenCodeModeExtension(options)({ registerTool(value) { definition = value; } });
  return definition;
}
const forbidden = { get tools() { assert.fail("must not construct tools"); }, executeTool() { assert.fail("must not dispatch"); } };
const host = (name) => ({
  tools: [{ name: "host", parameters: { type: "object" } }],
  async executeTool() { return { result: { content: [{ type: "text", text: name }] } }; },
});

test("registration and rejected preflight do not resolve backend dependencies in a fresh process", async () => {
  const entry = new URL("../index.js", import.meta.url).href;
  const program = `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    const attempts = [];
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "@opencode/codemode" || specifier === "effect") {
        attempts.push(specifier);
        throw new Error("backend deliberately unavailable");
      }
      return next(specifier, context);
    } });
    const { createOpenCodeModeExtension } = await import(${JSON.stringify(entry)});
    let tool;
    createOpenCodeModeExtension()({ registerTool(value) { tool = value; } });
    tool.prepareLoadout({ callable: [] });
    for (const code of ['text("native");', 'return "\\n";', 'return require("url");', 'await tools.host({}); return import("url");']) {
      const result = await tool.execute("reject", { code }, undefined, undefined, {
        get tools() { assert.fail("preflight must not read tools"); }
      });
      assert.equal(result.isError, true);
    }
    assert.deepEqual(attempts, []);
    const result = await tool.execute("valid", { code: "return 42;" }, undefined, undefined, {});
    assert.equal(result.details.error.kind, "ExecutionFailure");
    assert.match(result.content[0].text, /backend deliberately unavailable/);
    assert(attempts.length > 0);
    console.log("lazy dependency boundary passed");
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = await exec(process.execPath, ["--input-type=module", "-e", program], { env, timeout: 15000 });
  assert.match(result.stdout, /lazy dependency boundary passed/);
});

test("Pi file/jiti loader executes lazy backend imports, not only inline test factories", async () => {
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const dir = await mkdtemp(join(tmpdir(), "pi-opencode-loader-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory({}),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../index.js", import.meta.url))],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const definition = loaded.extensions.flatMap((extension) => [...extension.tools.values()])
      .find((entry) => entry.definition.name === "codemode_o")?.definition;
    assert.ok(definition);
    const result = await definition.execute("loaded", { code: "return await tools.host({});" }, undefined, undefined, host("loaded"));
    assert.equal(result.content[0].text, '"loaded"');
    assert.equal(result.details.calls[0].status, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preflight and an already-aborted execution do not start injected backend loading", async () => {
  let loads = 0;
  const definition = tool({ loadRuntime() { loads++; throw new Error("must not load"); } });
  for (const code of ['text("native");', 'return "\n";', 'return require("crypto");', 'const require = () => 1; return require();', 'await tools.host({}); return import("url");']) {
    const result = await definition.execute("preflight", { code }, undefined, undefined, forbidden);
    assert.equal(result.isError, true);
  }
  const controller = new AbortController(); controller.abort();
  const result = await definition.execute("abort", { code: "return 42;" }, controller.signal, undefined, forbidden);
  assert.match(result.content[0].text, /Script interrupted/);
  assert.equal(loads, 0);
});

test("concurrent cold calls share module loading, not runtime/ctx/signal/call-log state", async () => {
  let loads = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const definition = tool({ async loadRuntime() { loads++; await gate; return modules(); } });
  const a = definition.execute("a", { code: "return await tools.host({});" }, undefined, undefined, host("A"));
  const b = definition.execute("b", { code: "return await tools.host({});" }, undefined, undefined, host("B"));
  await Promise.resolve();
  assert.equal(loads, 1);
  release();
  const [left, right] = await Promise.all([a, b]);
  assert.equal(left.content[0].text, '"A"');
  assert.equal(right.content[0].text, '"B"');
  assert.notEqual(left.details.calls, right.details.calls);
  assert.equal(left.details.calls.length, 1);
  assert.equal(right.details.calls.length, 1);
  const unavailable = await definition.execute("new-catalog", { code: "return await tools.host({});" }, undefined, undefined, { tools: [] });
  assert.equal(unavailable.details.error.kind, "UnknownTool");
  assert.equal(loads, 1);
});

test("abort while modules load returns promptly and does not poison another waiting root", { timeout: 5000 }, async () => {
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const definition = tool({ loadRuntime() { started(); return gate; } });
  const controller = new AbortController();
  const first = definition.execute("cancel-loading", { code: "return 42;" }, controller.signal, undefined, forbidden);
  await ready;
  const second = definition.execute("other-root", { code: "return await tools.host({});" }, undefined, undefined, host("B"));
  controller.abort();
  const cancelled = await first; // Intentionally before releasing the import.
  assert.match(cancelled.content[0].text, /Script interrupted/);
  assert.deepEqual(cancelled.details.calls, []);
  release(await modules());
  assert.equal((await second).content[0].text, '"B"');
});

test("late import rejection after abort stays handled, with no host calls or automatic replay", { timeout: 5000 }, async () => {
  let reject, started;
  const ready = new Promise((resolve) => { started = resolve; });
  let loads = 0;
  const definition = tool({ loadRuntime() { loads++; started(); return new Promise((_resolve, fail) => { reject = fail; }); } });
  const controller = new AbortController();
  const first = definition.execute("abort", { code: "return 42;" }, controller.signal, undefined, forbidden);
  await ready;
  controller.abort();
  assert.match((await first).content[0].text, /Script interrupted/);
  reject(new Error("import unavailable"));
  const second = await definition.execute("new-call", { code: "return 42;" }, undefined, undefined, forbidden);
  assert.equal(second.details.error.kind, "ExecutionFailure");
  assert.match(second.content[0].text, /import unavailable/);
  assert.equal(loads, 1);
});
