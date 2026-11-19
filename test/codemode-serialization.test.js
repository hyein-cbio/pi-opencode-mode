import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodeMode, Tool } from "@opencode/codemode";
import { Effect } from "effect";
import { commonInputCases, customToJSONCases } from "./fixtures/tool-input-serialization.js";

const { version } = JSON.parse(readFileSync(findPackageJSON(import.meta.resolve("@opencode/codemode")), "utf8"));
const legacy = version === "2.3.0";
assert.ok(["2.3.0", "2.3.1", "2.3.2"].includes(version), `No observed serialization baseline for CodeMode ${version}`);

function runMock({ timeoutMs = 5_000, maxToolCalls = 64 } = {}) {
  const inputs = [];
  const runtime = CodeMode.make({
    tools: { read: Tool.make({
      description: "Inert input recorder (no filesystem)", input: { type: "object" }, output: {},
      execute(input) { inputs.push(input); return Effect.succeed("mocked"); },
    }) },
    limits: { timeoutMs, maxToolCalls, maxOutputBytes: 4096 },
  });
  return { inputs, run: (code, signal) => Effect.runPromise(runtime.execute(code), { signal }) };
}

test(`published CodeMode ${version} tool-input conversion (not a Pi compatibility claim)`, async () => {
  const { inputs, run } = runMock();
  const cases = [
    ...customToJSONCases.map(({ name, code, ...expected }) => ({ name, code, ...expected[legacy ? "legacy" : "dropsMethods"] })),
    ...commonInputCases,
  ];
  for (const { name, code, args, error, value = "mocked" } of cases) {
    const result = await run(code);
    if (error) {
      assert.equal(result.ok, false, name);
      assert.equal(result.error.kind, error.kind, name);
      assert.match(result.error.message, error.message, name);
      assert.deepEqual(result.toolCalls, [], name);
      assert.deepEqual(inputs.splice(0), [], name);
    } else {
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(result.value, value, name);
      assert.deepEqual(result.toolCalls, [{ name: "read" }], name);
      assert.deepEqual(inputs.splice(0), [args], name);
    }
  }
});

test("raw VM timeout and call budget; JSON round trip is not an equivalent converter", async () => {
  const timed = runMock({ timeoutMs: 250 });
  const result = await timed.run('return await tools.read({ toJSON() { while (true) {} } });');
  if (legacy) {
    assert.equal(result.error?.kind, "TimeoutExceeded");
    assert.deepEqual(timed.inputs, []);
    assert.deepEqual(result.toolCalls, []);
  } else {
    assert.equal(result.ok, true);
    assert.deepEqual(timed.inputs, [{}], "upstream discarded the method instead of running it under the budget");
  }

  const loop = 'while (true) {} return await tools.read({});';
  const plainTimeout = await timed.run(loop);
  assert.equal(plainTimeout.error?.kind, "TimeoutExceeded");
  assert.deepEqual(plainTimeout.toolCalls, []);

  const limited = runMock({ maxToolCalls: 1 });
  const over = await limited.run('await tools.read({ n: 1 }); return await tools.read({ n: 2 });');
  assert.equal(over.error?.kind, "ToolCallLimitExceeded");
  assert.deepEqual(over.toolCalls, [{ name: "read" }]);
  assert.deepEqual(limited.inputs, [{ n: 1 }]);

  const failed = await limited.run('return await tools.read(JSON.parse(JSON.stringify({ n: Promise.resolve(1) })));');
  assert.equal(failed.error?.kind, "InvalidDataValue");
  assert.match(failed.error.message, /un-awaited Promise/);
  assert.deepEqual(failed.toolCalls, []);
  assert.deepEqual(limited.inputs, [{ n: 1 }]);
});

test("raw VM cancellation stops before the would-be dispatch", { timeout: 5_000 }, async () => {
  const { inputs, run } = runMock({ timeoutMs: 10_000 });
  const signal = AbortSignal.timeout(30);
  const loop = legacy ? 'return await tools.read({ toJSON() { while (true) {} } });' : 'while (true) {} return await tools.read({});';
  await assert.rejects(run(loop, signal), /interrupt/i);
  assert.equal(signal.aborted, true);
  assert.deepEqual(inputs, []);
});

test("string search and guest Buffer support are not shared across the tested releases", async () => {
  const { run } = runMock();
  const searched = await run('return search("read");');
  if (legacy) assert.equal(searched.error?.kind, "InvalidToolInput");
  else assert.equal(searched.value?.items[0]?.path, "tools.read");
  assert.equal((await run('return typeof Buffer;')).value, legacy ? "undefined" : "function");
});

test(`Pi extension ${legacy ? "admits the exact release" : "refuses unsafe inputs before guest execution"} (${version})`, async (t) => {
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const dir = await mkdtemp(join(tmpdir(), "pi-opencode-serialization-loader-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../index.js", import.meta.url))],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const tool = loaded.extensions.flatMap((extension) => [...extension.tools.values()])
    .find((entry) => entry.definition.name === "codemode_o")?.definition;
  assert.ok(tool, "the real Pi SDK must load the extension from disk");
  const { code } = customToJSONCases[0];
  let catalogReads = 0;
  const inputs = [];
  const result = await tool.execute("serialization", {
    code: `console.log("guest ran"); ${code}`,
  }, undefined, undefined, {
    get tools() {
      catalogReads++;
      return [{ name: "read", parameters: { type: "object" } }];
    },
    async executeTool(_name, args) {
      inputs.push(args);
      return { result: { content: [{ type: "text", text: "mocked" }] } };
    },
  });
  assert.equal(result.details.preflight.supported, true);
  if (legacy) {
    assert.equal(result.details.ok, true, result.content[0].text);
    assert.match(result.content[0].text, /guest ran/);
    assert.equal(catalogReads, 1);
    assert.deepEqual(inputs, [customToJSONCases[0].legacy.args]);
  } else {
    assert.equal(result.isError, true);
    assert.equal(result.details.error.kind, "UnsupportedCodeModeVersion");
    assert.ok(result.details.error.message.includes(`@opencode/codemode "${version}"`));
    assert.match(result.content[0].text, /Source was not executed.*drops custom toJSON.*No automatic delegation or replay/);
    assert.doesNotMatch(result.content[0].text, /guest ran/);
    assert.deepEqual(result.details.calls, []);
    assert.deepEqual(result.details.toolCalls, []);
    assert.equal(catalogReads, 0);
    assert.deepEqual(inputs, []);
  }
});
