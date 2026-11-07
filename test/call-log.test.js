import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenCodeModeExtension } from "../index.js";
import { CALL_UPDATE_INTERVAL_MS, createCallLog } from "../call-log.js";

function tool() {
  let definition;
  createOpenCodeModeExtension()({ registerTool(value) { definition = value; } });
  return definition;
}
const catalog = [{ name: "host", parameters: { type: "object" } }];
const response = (text) => ({ result: { content: [{ type: "text", text }] } });

test("parallel duplicate names publish detached running and settled rows in invocation order", { timeout: 5000 }, async () => {
  const updates = [];
  const input = 'return await Promise.allSettled([tools.host({id:1}),tools.host({id:2})]);';
  const params = { code: input };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let running;
  const visible = new Promise((resolve) => { running = resolve; });
  const pending = tool().execute("parallel", params, undefined, (update) => {
    updates.push(update);
    if (update.details.calls.length === 2 && update.details.calls.every((call) => call.status === "running")) running();
  }, {
    tools: catalog,
    async executeTool(_name, args) { await gate; return response(String(args.id)); },
  });
  // Hold both hosts open until a live frame, rather than assuming every <16ms
  // intermediate state must be displayed. Final records still retain all calls.
  await visible;
  release();
  const result = await pending;
  assert.equal(params.code, input);
  assert.deepEqual(updates[0], { content: [], details: { calls: [] } });
  assert.ok(updates.some((update) => update.details.calls.length === 2 && update.details.calls.every((call) => call.status === "running")));
  assert.deepEqual(result.details.calls.map((call) => [call.name, JSON.parse(call.args).id, call.status]), [
    ["host", 1, "ok"], ["host", 2, "ok"],
  ]);
  assert.ok(result.details.calls.every((call) => call.durationMs >= 0));
  assert.deepEqual(JSON.parse(result.content[0].text), [{ status: "fulfilled", value: "1" }, { status: "fulfilled", value: "2" }]);
  assert.deepEqual(result.details.toolCalls, [{ name: "host" }, { name: "host" }]);
  assert.equal(updates[1].details.calls[0].status, "running", "earlier snapshots do not mutate after settlement");
  assert.notEqual(updates.at(-1).details.calls, result.details.calls);
});

test("call rows record execution attempts, not static source occurrences", async () => {
  let calls = 0;
  const result = await tool().execute("branches", {
    code: 'if(false) await tools.host({skipped:true}); for(let i=0;i<2;i++) await tools.host({i}); return 42;',
  }, undefined, undefined, { tools: catalog, async executeTool() { calls++; return response("ok"); } });
  assert.equal(calls, 2);
  assert.equal(result.details.calls.length, 2);
  assert.equal(result.content[0].text, "42");
  assert.ok(result.details.calls.every((call) => !call.args.includes("skipped")));
});

test("host failures stay visible even when Promise.allSettled handles them", async () => {
  const result = await tool().execute("errors", {
    code: 'return await Promise.allSettled([tools.host({id:1}),tools.host({id:2})]);',
  }, undefined, undefined, {
    tools: catalog,
    async executeTool(_name, args) {
      if (args.id === 1) return { isError: true, ...response("permission denied") };
      throw new Error("host failed");
    },
  });
  assert.equal(result.details.ok, true);
  assert.deepEqual(result.details.calls.map((call) => [call.status, call.error]), [
    ["error", "permission denied"], ["error", "host failed"],
  ]);
  assert.ok(JSON.parse(result.content[0].text).every((item) => item.status === "rejected"));
});

test("early return, race and outer abort settle cancelled rows after host cleanup", async () => {
  for (const code of ['tools.host({}); return "done";', 'return await Promise.race([tools.host({}), Promise.resolve("winner")]);', 'return await tools.host({});']) {
    const controller = new AbortController();
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    let settled = false;
    let hostElapsedMs;
    const resultPromise = tool().execute("cancel", { code }, controller.signal, undefined, {
      tools: catalog,
      async executeTool(_name, _args, { signal }) {
        const hostStartedAt = performance.now();
        started();
        try { await delay(1000, undefined, { signal }); }
        finally {
          await delay(10);
          hostElapsedMs = performance.now() - hostStartedAt;
          settled = true;
        }
        return response("late");
      },
    });
    await ready;
    if (code === 'return await tools.host({});') controller.abort();
    const result = await resultPromise;
    assert.equal(settled, true);
    assert.equal(result.details.calls.length, 1);
    assert.equal(result.details.calls[0].status, "cancelled");
    // Timers can fire slightly early; require the recorded duration to include
    // measured host work and asynchronous cleanup, not a nominal 10ms floor.
    assert.ok(result.details.calls[0].durationMs >= hostElapsedMs);
  }
});

test("observer failures and snapshot mutation cannot change tool execution", async () => {
  for (const observer of [() => { throw new Error("UI failed"); }, async () => { throw new Error("async UI failed"); },
    (update) => { for (const call of update.details.calls) call.status = "tampered"; update.details.calls.length = 0; }]) {
    const result = await tool().execute("observer", { code: 'return await tools.host({});' }, undefined, observer, {
      tools: catalog, async executeTool() { return response("ok"); },
    });
    assert.equal(result.content[0].text, '"ok"');
    assert.equal(result.details.calls[0].status, "ok");
  }
});

test("stored argument and error previews are bounded without retaining host results", async () => {
  let actual;
  const result = await tool().execute("large", {
    code: 'await tools.host({command:"한😀".repeat(10000)}); return 42;',
  }, undefined, undefined, {
    tools: catalog,
    async executeTool(_name, args) { actual = args; return response("PRIVATE RESULT BODY"); },
  });
  assert.equal(actual.command.length, 30000);
  assert.equal(result.content[0].text, "42");
  assert.ok(Buffer.byteLength(result.details.calls[0].args) <= 1024);
  assert.ok(result.details.calls[0].args.includes("…"));
  assert.ok(!JSON.stringify(result.details.calls).includes("PRIVATE RESULT BODY"));
  const failure = await tool().execute("large-error", { code: 'return await tools.host({});' }, undefined, undefined, {
    tools: catalog, async executeTool() { throw new Error("😀".repeat(10000)); },
  });
  assert.ok(Buffer.byteLength(failure.details.calls[0].error) <= 512);
  const many = await tool().execute("many", { code: 'for(let i=0;i<64;i++) await tools.host({i}); return 42;' }, undefined, undefined, {
    tools: catalog, async executeTool() { return response("ok"); },
  });
  assert.equal(many.details.calls.length, 64);
  assert.equal(many.content[0].text, "42");
});

test("call-log batches frames without delaying host dispatch and flushes before the next tick", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updates = [], releases = [];
  const log = createCallLog((update) => updates.push(update), 64);
  log.publish();
  const runs = [1, 2].map((id) => log.run("host", { id }, undefined,
    () => new Promise((resolve) => releases.push(resolve))));
  assert.equal(releases.length, 2, "hosts start immediately, not after the UI timer");
  assert.equal(updates.length, 1);
  t.mock.timers.tick(CALL_UPDATE_INTERVAL_MS - 1);
  assert.equal(updates.length, 1);
  t.mock.timers.tick(1);
  assert.equal(updates.length, 2);
  assert.ok(updates[1].details.calls.every((call) => call.status === "running"));
  releases.forEach((release) => release(42));
  assert.deepEqual(await Promise.all(runs), [42, 42]);
  assert.equal(updates.length, 2, "settlement notifications stay coalesced until flush");
  log.close();
  assert.equal(updates.length, 3);
  assert.ok(updates.at(-1).details.calls.every((call) => call.status === "ok"));
  assert.ok(updates[1].details.calls.every((call) => call.status === "running"), "earlier snapshots stay detached");
  updates.at(-1).details.calls[0].status = "tampered";
  assert.equal(log.snapshot()[0].status, "ok");
  log.close();
  log.publish();
  t.mock.timers.tick(1000);
  assert.equal(updates.length, 3, "no callback after close, even if closed twice");
});

test("64 immediate hosts keep all records but only initial and final frames", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updates = [];
  const log = createCallLog((update) => updates.push(update), 64);
  log.publish();
  await Promise.all(Array.from({ length: 64 }, (_, id) => log.run("host", { id }, undefined, async () => id)));
  assert.equal(updates.length, 1);
  log.close();
  assert.equal(updates.length, 2);
  assert.equal(updates[1].details.calls.length, 64);
  assert.deepEqual(updates[1].details.calls.map((call) => JSON.parse(call.args).id), Array.from({ length: 64 }, (_, i) => i));
  assert.ok(updates[1].details.calls.every((call) => call.status === "ok"));
  t.mock.timers.tick(1000);
  assert.equal(updates.length, 2);
});

test("scheduled observer failures/rejections stay isolated and missing observers schedule nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const observer of [() => { throw new Error("UI failed"); }, async () => { throw new Error("async UI failed"); }]) {
    const log = createCallLog(observer, 64);
    log.publish();
    let release;
    const pending = log.run("host", {}, undefined, () => new Promise((resolve) => { release = resolve; }));
    t.mock.timers.tick(CALL_UPDATE_INTERVAL_MS);
    release("ok");
    assert.equal(await pending, "ok");
    log.close();
    assert.equal(log.snapshot()[0].status, "ok");
  }
  t.mock.timers.reset();
  t.mock.method(globalThis, "setTimeout", () => assert.fail("no observer needs no timer"));
  const log = createCallLog(undefined, 64);
  log.publish();
  assert.equal(await log.run("host", {}, undefined, async () => 42), 42);
  log.close();
});

test("coalesced logs are root-local and retain errors/cancellation after cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = [], b = [], aborted = new AbortController();
  const first = createCallLog((update) => a.push(update), 64);
  const second = createCallLog((update) => b.push(update), 64);
  first.publish(); second.publish();
  const failure = first.run("denied", {}, undefined, () => { throw new Error("denied"); });
  await assert.rejects(failure, /denied/);
  let reject, cleaned = false;
  const pending = second.run("slow", {}, aborted.signal, () => new Promise((_resolve, fail) => { reject = fail; }).finally(() => { cleaned = true; }));
  first.close();
  assert.equal(a.at(-1).details.calls[0].status, "error");
  assert.equal(b.length, 1);
  t.mock.timers.tick(CALL_UPDATE_INTERVAL_MS);
  assert.equal(b.at(-1).details.calls[0].status, "running");
  aborted.abort();
  reject(new Error("aborted"));
  await assert.rejects(pending, /aborted/);
  assert.equal(cleaned, true);
  second.close();
  assert.equal(b.at(-1).details.calls[0].status, "cancelled");
  assert.equal(a.length, 2);
});

test("preflight rejection has no fabricated call rows or running notifications", async () => {
  for (const code of ['return "\n";', 'text("native");']) {
    const updates = [];
    const result = await tool().execute("reject", { code }, undefined, (value) => updates.push(value), {
      get tools() { assert.fail("no runtime"); }, executeTool() { assert.fail("no delegation"); },
    });
    assert.deepEqual(updates, []);
    assert.deepEqual(result.details.calls, []);
    assert.deepEqual(result.details.toolCalls, []);
  }
});
