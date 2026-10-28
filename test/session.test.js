import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenCodeModeExtension } from "../index.js";
import { rawNewlineSource } from "./fixtures/preflight-source.js";

// Explicit local SDK package directory only. Never installs or discovers private settings.
const sdk = process.env.PI_OPENCODE_SDK;
test("isolated real Pi SDK session", { skip: !sdk && "set PI_OPENCODE_SDK to a local SDK package directory", timeout: 45_000 }, async (t) => {
  const pi = await import(pathToFileURL(join(sdk, "dist/index.js")));
  // Older SDKs keep pi-ai nested under their own node_modules (shrinkwrap).
  // Resolve relative to this SDK instead of assuming a hoisted sibling package.
  const aiPackage = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(sdk, "package.json")));
  const { Type, createAssistantMessageEventStream } = await import(pathToFileURL(join(dirname(aiPackage), "dist/index.js")));
  const version = JSON.parse(await readFile(join(sdk, "package.json"), "utf8")).version;
  t.diagnostic(`Actual SDK ${version}; scripted stream; no model/network/real mutation tools`);
  const dir = await mkdtemp(join(tmpdir(), "pi-opencode-session-"));
  const state = { finished: 0, aborted: 0, settled: 0, starts: 0, echoRuns: 0, deniedRuns: 0 };
  const hooks = [];
  const callUpdates = [];
  const names = ["codemode", "codemode_o", "safe_echo", "safe_slow", "safe_denied"];
  let session;
  try {
    const settingsManager = pi.SettingsManager.inMemory({ defaultTools: names, cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [],
      extensionFactories: [pi.createCodemodeExtension(), createOpenCodeModeExtension(), (api) => {
        const register = (name, parameters, execute) => api.registerTool({ name, label: name, description: "Safe in-memory test stub", parameters, execute });
        register("safe_echo", Type.Object({ value: Type.Number() }), async (_id, args) => {
          state.echoRuns++;
          await delay(10); // Let sibling nested calls pass hooks and enter their bodies.
          return { content: [{ type: "text", text: String(args.value) }], details: {} };
        });
        register("safe_denied", Type.Object({}), async () => {
          state.deniedRuns++;
          return { content: [{ type: "text", text: "should not run" }], details: {} };
        });
        register("safe_slow", Type.Object({ ms: Type.Optional(Type.Number()) }), async (_id, args, signal) => {
          state.starts++;
          state.signal = signal;
          try {
            await delay(args.ms ?? 150, undefined, { signal });
            state.finished++;
            return { content: [{ type: "text", text: "slow" }], details: {} };
          } catch (error) {
            state.aborted++;
            await delay(15); // Ensure nested call audit waits for asynchronous cleanup.
            throw error;
          } finally {
            state.settled++;
          }
        });
        for (const type of ["tool_execution_start", "tool_execution_end"]) api.on(type, (event) => {
          hooks.push({ type, name: event.toolName, parent: event.parentToolCallId });
        });
        api.on("tool_execution_update", (event) => {
          if (event.toolName === "codemode_o") callUpdates.push({ id: event.toolCallId, calls: event.partialResult?.details?.calls });
        });
        api.on("tool_call", (event) => {
          hooks.push({ type: "call", name: event.toolName, parent: event.parentToolCallId });
          if (event.toolName === "safe_denied") return { block: true, reason: "test permission denied" };
        });
        api.on("tool_result", (event) => {
          hooks.push({ type: "result", name: event.toolName, parent: event.parentToolCallId });
          if (event.toolName === "safe_echo") return { content: [{ type: "text", text: "hooked" }] };
        });
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const modelRuntime = await pi.ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
    await modelRuntime.setRuntimeApiKey("openai", "offline-not-a-real-key");
    const model = modelRuntime.getModels("openai").find((entry) => entry.type === undefined || entry.type === "chat");
    assert.ok(model);
    ({ session } = await pi.createAgentSession({ cwd: dir, agentDir: dir, model, thinkingLevel: "off", modelRuntime, settingsManager, resourceLoader, sessionManager: pi.SessionManager.inMemory(dir), tools: names }));
    await session.bindExtensions({});
    assert.ok(session.getActiveToolNames().includes("codemode"), "builtin is still active");
    assert.ok(session.getActiveToolNames().includes("codemode_o"));
    await t.test("default prompt follows active loadout without duplicate or unloaded guidance", async () => {
      const definition = session.getAllTools().find((tool) => tool.name === "codemode_o");
      const guidelines = definition.promptGuidelines;
      assert.ok(guidelines.length > 0);
      function checkGuidelines(count) {
        for (const guideline of guidelines) {
          assert.equal(session.systemPrompt.split(guideline).length - 1, count, guideline);
        }
      }
      checkGuidelines(1);
      for (let cycle = 0; cycle < 2; cycle++) {
        session.setActiveToolsByName(names.filter((name) => name !== "codemode_o"));
        checkGuidelines(0);
        assert.ok(session.getActiveToolNames().includes("codemode"));
        session.setActiveToolsByName(names);
        checkGuidelines(1);
      }
      session.setActiveToolsByName(["codemode_o", "safe_echo"]);
      checkGuidelines(1);
      assert.ok(!session.getActiveToolNames().includes("codemode"));
      assert.match(session.systemPrompt, /use native if active, otherwise report it is needed/);
      session.setActiveToolsByName(names);

      const unloadedLoader = new pi.DefaultResourceLoader({
        cwd: dir, agentDir: dir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [], extensionFactories: [pi.createCodemodeExtension()],
      });
      await unloadedLoader.reload();
      assert.deepEqual(unloadedLoader.getExtensions().errors, []);
      const { session: unloaded } = await pi.createAgentSession({
        cwd: dir, agentDir: dir, model, thinkingLevel: "off", modelRuntime, settingsManager,
        resourceLoader: unloadedLoader, sessionManager: pi.SessionManager.inMemory(dir), tools: ["codemode"],
      });
      try {
        await unloaded.bindExtensions({});
        assert.ok(!unloaded.getAllTools().some((tool) => tool.name === "codemode_o"));
        for (const guideline of guidelines) assert.ok(!unloaded.systemPrompt.includes(guideline));
        assert.ok(!unloaded.systemPrompt.includes("Prefer codemode_o"));
      } finally {
        await unloaded.abort();
        await unloaded.extensionRunner.emit({ type: "session_shutdown" });
        unloaded.dispose();
      }
    });
    let seq = 0;
    async function run(code, abort = false) {
      const id = `script-${++seq}`;
      let turn = 0;
      session.agent.streamFunction = () => {
        const stream = createAssistantMessageEventStream();
        const first = ++turn === 1;
        const message = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: first ? "toolUse" : "stop",
          content: first ? [{ type: "toolCall", id, name: "codemode_o", arguments: { code } }] : [{ type: "text", text: "done" }],
        };
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
        return stream;
      };
      const starts = state.starts;
      const pending = session.prompt("Run offline scripted test");
      if (abort) {
        while (state.starts === starts) await delay(1);
        await session.abort();
      }
      await pending;
      const result = session.messages.findLast((entry) => entry.role === "toolResult" && entry.toolCallId === id);
      assert.ok(result);
      assert.ok(Number.isFinite(result.details?.durationMs), "duration survives real session storage");
      assert.ok(result.details.durationMs >= 0);
      t.diagnostic(JSON.stringify({ code: code.slice(0, 90), isError: result.isError, durationMs: result.details.durationMs, contentBytes: Buffer.byteLength(result.content[0].text), nestedCalls: result.nestedCalls }));
      return result;
    }
    await t.test("host hooks, schema validation, permissions and recursion boundary", async () => {
      const echo = await run('return await tools.safe_echo({value: 7});');
      assert.equal(echo.content[0].text, '"hooked"');
      assert.equal(echo.nestedCalls.complete, true);
      assert.equal(echo.nestedCalls.calls[0].status, "ok");
      assert.ok(hooks.some((event) => event.type === "call" && event.name === "safe_echo" && event.parent === echo.toolCallId));
      assert.ok(hooks.some((event) => event.type === "result" && event.name === "safe_echo" && event.parent === echo.toolCallId));
      const invalid = await run('return await tools.safe_echo({value: "bad"});');
      assert.equal(invalid.isError, true);
      assert.equal(state.echoRuns, 1);
      const denied = await run('return await tools.safe_denied({});');
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /permission denied/);
      assert.equal(state.deniedRuns, 0);
      assert.equal(denied.details.calls[0].status, "error");
      assert.match(denied.details.calls[0].error, /permission denied/);
      const hidden = await run('return await tools.codemode({code: "return 1"});');
      assert.equal(hidden.isError, true);
    });
    await t.test("String.raw and recovery suggestions survive real session storage", async () => {
      const raw = await run('return String.raw`python3 - <<PY\nprint("\\n")\nPY`;');
      assert.equal(raw.isError, false);
      assert.equal(JSON.parse(raw.content[0].text), 'python3 - <<PY\nprint("\\n")\nPY');
      assert.equal(raw.details.preflight.supported, true);
      assert.equal(raw.nestedCalls?.calls?.length ?? 0, 0);
      const unknown = await run('return await tools.not_a_tool({});');
      assert.equal(unknown.isError, true);
      assert.equal(unknown.details.error.kind, "UnknownTool");
      assert.ok(unknown.details.error.suggestions.length > 0);
      for (const suggestion of unknown.details.error.suggestions) {
        assert.ok(unknown.content[0].text.includes(`Suggestion: ${suggestion}\n`));
      }
    });
    await t.test("native-required source is rejected before host effects in a real session", async () => {
      const before = state.echoRuns;
      const result = await run('await tools.safe_echo({value: 1}); text("done");');
      assert.equal(result.isError, true);
      assert.equal(result.details.error.kind, "NativeCodemodeRequired");
      assert.equal(result.details.route.route, "codemode");
      assert.match(result.content[0].text, /not executed/i);
      assert.equal(state.echoRuns, before);
      assert.equal(result.nestedCalls?.calls?.length ?? 0, 0);
      assert.ok(session.getActiveToolNames().includes("codemode"));
    });
    await t.test("raw newline syntax errors do not reach tools or native; escaped source stays intact", async () => {
      const before = state.echoRuns;
      for (const source of [rawNewlineSource, 'await tools.safe_echo({value: 1}); return "\n";']) {
        const result = await run(source);
        assert.equal(result.isError, true);
        assert.equal(result.details.error.kind, "SourceSyntaxError");
        assert.match(result.content[0].text, /Unterminated string constant/);
        assert.match(result.content[0].text, /Escape newlines/);
        assert.doesNotMatch(result.content[0].text, /Use Pi\x27s built-in codemode/);
        assert.equal(result.details.preflight.executesSource, false);
        assert.equal(result.nestedCalls?.calls?.length ?? 0, 0);
        assert.equal(state.echoRuns, before);
      }
      const escaped = await run('await tools.safe_echo({value: 1}); return "\\n";');
      assert.equal(escaped.isError, false);
      assert.equal(JSON.parse(escaped.content[0].text), "\n");
      assert.equal(state.echoRuns, before + 1);
    });
    await t.test("early return and race drain cancelled nested calls", async () => {
      // Immediate cancellation can correctly stop a call before its body starts.
      const immediate = await run('tools.safe_slow({}); return "done";');
      assert.equal(immediate.nestedCalls.complete, true);
      assert.notEqual(immediate.nestedCalls.calls[0].status, "unfinished");
      for (const code of [
        'tools.safe_slow({}); await tools.safe_echo({value: 1}); return "done";',
        'return await Promise.race([tools.safe_slow({}), tools.safe_echo({value: 1})]);',
      ]) {
        const before = state.aborted;
        const result = await run(code);
        assert.equal(result.isError, false);
        assert.equal(state.aborted, before + 1);
        assert.equal(state.settled, state.starts);
        assert.equal(result.nestedCalls.complete, true);
        assert.notEqual(result.nestedCalls.calls[0].status, "unfinished");
        assert.equal(state.signal.aborted, true);
        for (const type of ["call", "result", "tool_execution_start", "tool_execution_end"]) {
          assert.ok(hooks.some((event) => event.type === type && event.name === "safe_slow" && event.parent === result.toolCallId), `${type} hook completed for cancelled nested call`);
        }
      }
      await delay(200);
      assert.equal(state.finished, 0);
    });
    await t.test("normal parallel calls publish live rows and persist metadata without changing source", async () => {
      const code = 'return await Promise.all([tools.safe_slow({ms: 5}), tools.safe_slow({ms: 5})]);';
      const result = await run(code);
      assert.equal(result.content[0].text, '["slow","slow"]');
      assert.equal(result.nestedCalls.complete, true);
      assert.ok(result.nestedCalls.calls.every((call) => call.status === "ok"));
      assert.equal(result.details.calls.length, 2);
      assert.ok(result.details.calls.every((call) => call.name === "safe_slow" && call.status === "ok" && call.durationMs >= 0));
      assert.deepEqual(result.details.calls.map((call) => JSON.parse(call.args)), [{ ms: 5 }, { ms: 5 }]);
      const updates = callUpdates.filter((update) => update.id === result.toolCallId);
      assert.ok(updates.some((update) => update.calls?.length === 2 && update.calls.every((call) => call.status === "running")));
      assert.ok(updates.some((update) => update.calls?.length === 2 && update.calls.every((call) => call.status === "ok")));
      const message = session.messages.find((entry) => entry.role === "assistant" && entry.content.some((block) => block.type === "toolCall" && block.id === result.toolCallId));
      assert.equal(message.content.find((block) => block.type === "toolCall").arguments.code, code);
    });
    await t.test("warnings and truncation reach the actual transcript", async () => {
      const warning = await run('Promise.reject(new Error("denied")); return "done";');
      assert.match(warning.content[0].text, /Warning.*denied/);
      assert.match(warning.details.warnings[0].message, /denied/);
      const failed = await run('tools.safe_denied({}); await tools.safe_echo({value: 1}); return "done";');
      assert.equal(failed.isError, false);
      assert.match(failed.content[0].text, /Warning.*permission denied/);
      assert.match(failed.details.warnings[0].message, /permission denied/);
      const output = await run('return "\\\\".repeat(40000);');
      assert.ok(Buffer.byteLength(output.content[0].text) <= 65_536);
      assert.equal(output.details.truncated, true);
      assert.match(output.content[0].text, /truncated/i);
    });
    await t.test("literal deadline drains nested cancellation and audit", async () => {
      const before = state.finished;
      const aborted = state.aborted;
      const result = await run('return await tools.safe_slow({ms: 30750});');
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /TimeoutExceeded/);
      assert.equal(state.aborted, aborted + 1);
      assert.equal(state.settled, state.starts);
      assert.equal(result.details.calls[0].status, "cancelled");
      assert.equal(result.nestedCalls.complete, true);
      assert.notEqual(result.nestedCalls.calls[0].status, "unfinished");
      await delay(850);
      assert.equal(state.finished, before);
    });
    await t.test("user abort settles the nested call", async () => {
      const before = state.aborted;
      const result = await run('return await tools.safe_slow({ms: 500});', true);
      assert.equal(result.nestedCalls.complete, true);
      assert.notEqual(result.nestedCalls.calls[0].status, "unfinished");
      assert.equal(state.aborted, before + 1);
      assert.equal(state.settled, state.starts);
    });
  } finally {
    if (session) {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown" });
      session.dispose();
    }
    await rm(dir, { recursive: true, force: true });
  }
});
