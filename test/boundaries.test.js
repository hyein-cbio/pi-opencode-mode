import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenCodeModeExtension } from "../index.js";

const LIMIT = 65_536;
function run(code, ctx = { tools: [] }, signal) {
  let tool;
  createOpenCodeModeExtension()({ registerTool(value) { tool = value; } });
  return tool.execute("boundary", { code }, signal, undefined, ctx);
}
function slowHost(duration = 100, cleanupMs = 10) {
  const state = { started: 0, finished: 0, aborted: 0, settled: 0 };
  const ctx = {
    tools: [{ name: "slow", parameters: { type: "object" } }],
    async executeTool(_name, _args, { signal }) {
      state.started++;
      state.signal = signal;
      try {
        await delay(duration, undefined, { signal });
        state.finished++;
        return { result: { content: [{ type: "text", text: "done" }] } };
      } catch (error) {
        state.aborted++;
        // Exercise real asynchronous host cleanup, not merely an abort event.
        await delay(cleanupMs);
        throw error;
      } finally {
        state.settled++;
      }
    },
  };
  return { ctx, state };
}
function bounded(result, truncated = true) {
  const text = result.content.map((block) => block.text).join("");
  assert.ok(Buffer.byteLength(text) <= LIMIT, `got ${Buffer.byteLength(text)} bytes`);
  assert.equal(Buffer.from(text).toString("utf8"), text, "well-formed UTF-8");
  assert.ok(Buffer.byteLength(JSON.stringify({ error: result.details.error, warnings: result.details.warnings })) <= 8192, "bounded structured diagnostics");
  if (truncated) {
    assert.equal(result.details.truncated, true);
    assert.match(text, /truncated/i);
  }
  return text;
}

test("early return aborts and drains cooperative host work before reporting success", async () => {
  const { ctx, state } = slowHost();
  const result = await run('tools.slow({}); return "done";', ctx);
  assert.equal(result.isError, undefined);
  assert.equal(state.started, 1);
  assert.equal(state.aborted, 1);
  assert.equal(state.settled, 1);
  assert.equal(state.signal.aborted, true);
  assert.ok(result.details.durationMs >= 10, "timing includes asynchronous host cleanup");
  await delay(130);
  assert.equal(state.finished, 0);
});

test("race loser is aborted; normal awaited and parallel calls finish", async () => {
  const raced = slowHost();
  const result = await run('return await Promise.race([tools.slow({}), Promise.resolve("winner")]);', raced.ctx);
  assert.equal(result.content[0].text, '"winner"');
  assert.equal(raced.state.aborted, 1);
  assert.equal(raced.state.settled, 1);
  const normal = slowHost(10);
  assert.equal((await run('return await tools.slow({});', normal.ctx)).content[0].text, '"done"');
  assert.equal((await run('return await Promise.all([tools.slow({}), tools.slow({})]);', normal.ctx)).content[0].text, '["done","done"]');
  assert.equal(normal.state.finished, 3);
  assert.equal(normal.state.aborted, 0);
});

test("outer abort also drains nested host cleanup", async () => {
  const { ctx, state } = slowHost(500);
  const controller = new AbortController();
  const pending = run('return await tools.slow({});', ctx, controller.signal);
  while (!state.started) await delay(1);
  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(state.aborted, 1);
  assert.equal(state.settled, 1);
  assert.equal(state.finished, 0);
});

test("literal 30-second timeout aborts cooperative host work", { timeout: 35_000 }, async () => {
  const { ctx, state } = slowHost(30_750);
  const cleanup = slowHost(100, 30_050);
  const [result, returned] = await Promise.all([
    run('return await tools.slow({});', ctx),
    run('tools.slow({}); return "done";', cleanup.ctx),
  ]);
  assert.equal(returned.isError, undefined);
  assert.match(returned.content[0].text, /Warning TimeoutExceeded/);
  assert.equal(returned.details.warnings[0].kind, "TimeoutExceeded");
  assert.equal(cleanup.state.settled, 1);
  assert.ok(returned.details.durationMs >= 30_000, "timing includes delayed cleanup after early return");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /TimeoutExceeded/);
  assert.equal(state.aborted, 1);
  assert.equal(state.settled, 1);
  await delay(850);
  assert.equal(state.finished, 0);
});

test("warnings are visible and structural without changing success semantics", async () => {
  const result = await run('Promise.reject(new Error("denied")); return "done";');
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Warning.*ExecutionFailure.*denied/);
  assert.match(result.details.warnings[0].message, /denied/);
  assert.equal((await run("return 42")).content[0].text, "42");
  const many = await run('for (let i = 0; i < 100; i++) Promise.reject(new Error("denied " + i + "x".repeat(1000))); return "done";');
  bounded(many);
  assert.match(many.content[0].text, /Warning.*denied 0/);
  assert.ok(many.details.warnings.some((warning) => warning.kind === "Truncated"));
});

test("warning budget is reserved even when logs and return data fill output", async () => {
  const result = await run('Promise.reject(new Error("denied")); console.log("x".repeat(65536)); return "y".repeat(65536);');
  assert.match(bounded(result), /Warning.*denied/);
  assert.match(result.details.warnings[0].message, /denied/);
});

test("encoded output, logs and diagnostics respect the final UTF-8 limit", async (t) => {
  for (const [name, code] of [
    ["backslash", 'return "\\\\".repeat(40000);'],
    ["quote", 'return \'"\'.repeat(40000);'],
    ["newline", 'return "\\n".repeat(40000);'],
    ["ascii", 'return "x".repeat(66000);'],
    ["astral", 'return "😀".repeat(20000);'],
    ["mixed unicode", 'return "한😀\\n\\\\".repeat(10000);'],
    ["nul", 'return "\\u0000".repeat(20000);'],
    ["logs", 'console.log("x".repeat(65500)); return "😀".repeat(100);'],
    ["error", 'throw new Error("😀".repeat(40000));'],
    ["warnings", 'Promise.reject(new Error("x".repeat(70000))); return "ok";'],
  ]) await t.test(name, async () => bounded(await run(code)));
  // A complete JSON return at and below the boundary stays parseable.
  for (const length of [0, LIMIT - 3, LIMIT - 2]) {
    const result = await run(`return "x".repeat(${length});`);
    const text = bounded(result, false);
    assert.equal(JSON.parse(text).length, length);
    assert.notEqual(result.details.truncated, true);
  }
  bounded(await run(`return "x".repeat(${LIMIT - 1});`));
});

test("host errors and result formats keep the public bridge contract", async () => {
  const ctx = {
    tools: [{ name: "host", parameters: { type: "object" } }],
    async executeTool() { return { result: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }; },
  };
  assert.equal((await run('return await tools.host({});', ctx)).content[0].text, '"a\\nb"');
  ctx.executeTool = async () => ({ result: { structuredContent: { value: 7 }, content: [] } });
  assert.equal((await run('return (await tools.host({})).value;', ctx)).content[0].text, "7");
  ctx.executeTool = async () => ({ result: { content: [{ type: "image", data: "not-an-image" }] } });
  assert.match((await run('return await tools.host({});', ctx)).content[0].text, /Non-text result/);
  ctx.executeTool = async () => ({ isError: true, result: { content: [{ type: "text", text: "denied" }] } });
  assert.match((await run('return await tools.host({});', ctx)).content[0].text, /denied/);
  ctx.executeTool = async () => { throw new Error("\\".repeat(100_000)); };
  bounded(await run('return await tools.host({});', ctx));
  const aborted = new AbortController();
  aborted.abort(new Error("x".repeat(100_000)));
  bounded(await run('return 42;', ctx, aborted.signal), false);
  bounded(await run('return 42;', { get tools() { throw new Error("😀".repeat(100_000)); } }));
});
