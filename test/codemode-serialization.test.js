import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodeMode, Tool } from "@opencode/codemode";
import { Effect } from "effect";
import { commonInputCases, customToJSONCases, installedCodeModeVersion, currentSerializationProfile } from "./fixtures/tool-input-serialization.js";

const version = installedCodeModeVersion();
const serializationProfile = currentSerializationProfile();
assert.ok(serializationProfile, `No observed serialization baseline for CodeMode ${version}`);
const legacy = serializationProfile === "legacy";

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
    ...customToJSONCases.map(({ name, code, ...expected }) => ({ name, code, ...expected[serializationProfile] })),
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

test(`Pi loader uses CodeMode ${version} with its native input serialization`, async (t) => {
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
  for (const { name, code, rawOnly, ...expected } of customToJSONCases) {
    if (rawOnly) continue;
    const { args, error, value = "mocked" } = expected[serializationProfile];
    const inputs = [];
    const result = await tool.execute("serialization", { code }, undefined, undefined, {
      tools: [{ name: "read", parameters: { type: "object" } }],
      async executeTool(toolName, input) {
        inputs.push({ name: toolName, input });
        return { result: { content: [{ type: "text", text: "mocked" }] } };
      },
    });
    assert.equal(result.details.preflight.supported, true, name);
    assert.equal(result.details.ok, !error, `${name}: ${result.content[0].text}`);
    if (error) {
      assert.equal(result.details.error.kind, error.kind, name);
      assert.match(result.details.error.message, error.message, name);
      assert.deepEqual(inputs, [], name);
      assert.deepEqual(result.details.calls, [], name);
      assert.deepEqual(result.details.toolCalls, [], name);
    } else {
      assert.equal(JSON.parse(result.content[0].text), value, name);
      assert.deepEqual(inputs, [{ name: "read", input: args }], name);
      assert.deepEqual(result.details.toolCalls, [{ name: "read" }], name);
      assert.deepEqual(result.details.calls.map(({ name: toolName, status }) => [toolName, status]), [["read", "ok"]], name);
    }
  }
});
