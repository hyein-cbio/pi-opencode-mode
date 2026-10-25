import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenCodeModeExtension } from "../index.js";

function tool() {
  let definition;
  createOpenCodeModeExtension()({ registerTool(value) { definition = value; } });
  return definition;
}
const catalog = [{ name: "host", parameters: { type: "object" } }];
const response = (text) => ({ result: { content: [{ type: "text", text }] } });

test("parallel duplicate names publish detached running and settled rows in invocation order", async () => {
  const updates = [];
  const input = 'return await Promise.allSettled([tools.host({id:1}),tools.host({id:2})]);';
  const params = { code: input };
  const result = await tool().execute("parallel", params, undefined, (update) => updates.push(update), {
    tools: catalog,
    async executeTool(_name, args) { await delay(args.id === 1 ? 20 : 5); return response(String(args.id)); },
  });
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
    const resultPromise = tool().execute("cancel", { code }, controller.signal, undefined, {
      tools: catalog,
      async executeTool(_name, _args, { signal }) {
        started();
        try { await delay(1000, undefined, { signal }); }
        finally { await delay(10); settled = true; }
        return response("late");
      },
    });
    await ready;
    if (code === 'return await tools.host({});') controller.abort();
    const result = await resultPromise;
    assert.equal(settled, true);
    assert.equal(result.details.calls.length, 1);
    assert.equal(result.details.calls[0].status, "cancelled");
    assert.ok(result.details.calls[0].durationMs >= 10);
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
