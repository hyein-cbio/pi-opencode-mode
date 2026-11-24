import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

test("unverified package metadata is rejected without evaluating the backend or guest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-opencode-version-"));
  try {
    const fixtures = [
      [undefined, /Could not identify/],
      ["{", /Could not identify/],
      [{ name: "different-package", version: "2.3.0" }, /Could not identify/],
      ...["2.2.7", "2.3.0+custom", "2.3.3", "2.4.1-rc.1", "2.4.1+custom", "2.4.2", "unknown"].map((version) =>
        [{ name: "@opencode/codemode", version }, /serialization is unverified/]),
    ];
    const paths = await Promise.all(fixtures.map(async ([manifest, diagnostic], index) => {
      const location = join(dir, String(index));
      const backend = join(location, "index.mjs");
      await mkdir(location);
      await writeFile(backend, 'throw new Error("Must not evaluate an unverified backend");');
      if (manifest !== undefined) {
        await writeFile(join(location, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
      }
      return [pathToFileURL(backend).href, diagnostic.source];
    }));
    const entry = new URL("../index.js", import.meta.url).href;
    const program = `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      let backend;
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === "@opencode/codemode") return { url: backend, shortCircuit: true };
        return next(specifier, context);
      } });
      const { createOpenCodeModeExtension } = await import(${JSON.stringify(entry)});
      for (const [url, diagnostic] of ${JSON.stringify(paths)}) {
        backend = url;
        let tool;
        let readCatalog = false;
        createOpenCodeModeExtension()({ registerTool(value) { tool = value; } });
        const result = await tool.execute("unknown-version", { code: 'console.log("guest ran"); return 42;' }, undefined, undefined, {
          get tools() { readCatalog = true; return []; }
        });
        assert.equal(result.details.preflight.supported, true);
        assert.equal(result.details.error.kind, "UnsupportedCodeModeVersion", result.content[0].text);
        assert.match(result.details.error.message, new RegExp(diagnostic));
        assert.doesNotMatch(result.content[0].text, /guest ran/);
        assert.equal(readCatalog, false);
        assert.deepEqual(result.details.toolCalls, []);
        assert.deepEqual(result.details.calls, []);
      }
    `;
    await exec(process.execPath, ["--input-type=module", "-e", program], { timeout: 15000 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
