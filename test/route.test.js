import assert from "node:assert/strict";
import test from "node:test";
import { PREFLIGHT_LIMITS, ROUTE_LIMITS, ROUTE_TOOLS, checkOpenCodeCompatibility, selectCodemodeRoute } from "../route.js";
import { createOpenCodeModeExtension } from "../index.js";

const select = (code, requested = "auto") => {
  const result = selectCodemodeRoute({ code, requested });
  if (requested === "auto" || requested === "codemode_o") {
    const preflight = checkOpenCodeCompatibility(code);
    assert.equal(preflight.supported, result.route === "codemode_o");
    assert.deepEqual(preflight.reasons, result.reasons);
    assert.equal(preflight.executesSource, false);
    assert.equal("route" in preflight, false, "compatibility checking does not choose a tool");
  }
  return result;
};

test("compatibility preflight has no tool choice; historical advisory remains compatible", () => {
  assert.equal(PREFLIGHT_LIMITS, ROUTE_LIMITS);
  const accepted = checkOpenCodeCompatibility("return 42;");
  assert.deepEqual(accepted, { supported: true, reasons: ["short-opencode-subset"], executesSource: false });
  assert.ok(Object.isFrozen(accepted));
  assert.ok(Object.isFrozen(accepted.reasons));
  const rejected = checkOpenCodeCompatibility("text(42);");
  assert.deepEqual(rejected, { supported: false, reasons: ["native-name:text"], executesSource: false });
  assert.ok(Object.isFrozen(rejected));
  assert.ok(Object.isFrozen(rejected.reasons));
  // These preferences depend on task context, not static dispatch. No source runs.
  assert.equal(checkOpenCodeCompatibility("return await tools.mcp__safe__read({});").supported, true);
  assert.equal(checkOpenCodeCompatibility("let n = 0; for (let i = 0; i < 1000000; i++) n += i; return n;").supported, true);
  assert.deepEqual(ROUTE_TOOLS, ["codemode", "codemode_o"]);
  const result = select('const data = await tools.read({ path: "README.md" }); return data.length;');
  assert.deepEqual(result, {
    decision: "selected", route: "codemode_o", reasons: ["short-opencode-subset"], executesSource: false,
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.reasons));
  assert.equal(select('throw new Error("bad");').route, "codemode_o");
  assert.equal(select('return await Promise.all([tools.a({}), tools.b({})]);').route, "codemode_o");
});

test("explicit native requests stay native and invalid requests fail closed", () => {
  assert.equal(select("return 42", "codemode").route, "codemode");
  assert.equal(select("return 42", "codemode_o").route, "codemode_o");
  assert.equal(select("return 42", "unknown").route, "codemode");
  for (const input of [undefined, {}, { code: null }, { code: 42 }, { code: "" }, { code: " // comment" }]) {
    assert.equal(selectCodemodeRoute(input).route, "codemode");
  }
});

test("Pi-specific references and options select native before any work", () => {
  for (const code of [
    'store("key", 1);', 'return load("key");', 'text(42);', 'image("data:...");', 'exit();',
    'return ALL_TOOLS;', 'return await searchTools("read");', 'return await describeTool("read");',
    'return await describeNamespace("docs");', 'return models.getAvailableOfType("image");',
    'const f = text; f(1);', 'return ({text});', 'return obj[text];',
    '// @options: {"timeout_ms": 60000}\nreturn 1;',
    '// @options: not JSON\nreturn 1;',
    'const \\u0074ext = 1; return \\u0074ext;',
  ]) assert.equal(select(code).route, "codemode", code);
});

test("comments, strings and ordinary property names do not trigger native routing", () => {
  for (const code of [
    '// text(42); store("x", 1);\nreturn 1;',
    'return "models text image store load class /regex/";',
    'return `text store ${1 + 1}`;',
    'return {text: 1, models: 2, store: 3};',
    'return result.text;', 'return result["text"];', 'return tools.text({});',
  ]) assert.equal(select(code).route, "codemode_o", code);
  assert.equal(select('return `value ${load("x")}`;').route, "codemode");
});

test("regular expression literals stay in OpenCode without reading pattern text as Pi globals", () => {
  for (const code of [
    'return /x/.test("x");',
    String.raw`return "ℹ tests 78".match(/ℹ (tests|pass|fail|skipped) [0-9]+/g);`,
    String.raw`return '{"exit_code":0}'.match(/"exit_code":\d+/g);`,
    'return /text|image|models|store|class|@options:/.test("text");',
    String.raw`return /a\/b/iu.test("A/b");`,
  ]) {
    assert.equal(select(code).route, "codemode_o", code);
    assert.equal(checkOpenCodeCompatibility(code).executesSource, false);
  }
  assert.deepEqual(checkOpenCodeCompatibility("return 1n;").reasons, ["unsupported-literal"]);
});

test("unsupported or uncertain syntax selects native without speculative execution", () => {
  for (const code of [
    'return 1n;', 'class X {} return new X();',
    'return new Proxy({}, {});', 'return globalThis;', 'eval("return 1");',
    'return {get value() { return 1; }};', 'return function* () { yield 1; };',
    'import fs from "node:fs";', 'return import("node:fs");', 'return (',
  ]) assert.equal(select(code).route, "codemode", code);
});

test("source size, lines and AST depth have deterministic conservative limits", () => {
  assert.equal(select("return 1;".padEnd(ROUTE_LIMITS.maxSourceBytes)).route, "codemode_o");
  assert.equal(select("return 1;".padEnd(ROUTE_LIMITS.maxSourceBytes + 1)).route, "codemode");
  assert.equal(select('return "😀";'.padEnd(ROUTE_LIMITS.maxSourceBytes)).route, "codemode");
  assert.equal(select("\n".repeat(ROUTE_LIMITS.maxLines - 1) + "return 1;").route, "codemode_o");
  assert.equal(select("\n".repeat(ROUTE_LIMITS.maxLines) + "return 1;").route, "codemode");
  const nested = (depth) => "return " + "[".repeat(depth) + "0" + "]".repeat(depth);
  assert.equal(select(nested(ROUTE_LIMITS.maxDepth - 2)).route, "codemode_o");
  assert.equal(select(nested(ROUTE_LIMITS.maxDepth - 1)).route, "codemode");
  const array = (count) => `return [${Array(count).fill("0").join(",")}];`;
  assert.equal(select(array(ROUTE_LIMITS.maxNodes - 3)).route, "codemode_o");
  assert.equal(select(array(ROUTE_LIMITS.maxNodes - 2)).route, "codemode");
});

test("execution only rejects incompatible source before accessing tools; no delegation or replay", async () => {
  let tool;
  createOpenCodeModeExtension()({ registerTool(value) { tool = value; } });
  let touched = false;
  const ctx = {
    get tools() { touched = true; throw new Error("must not build runtime"); },
    executeTool() { touched = true; throw new Error("must not delegate"); },
  };
  const result = await tool.execute("route", { code: 'await tools.write({}); text("done");' }, undefined, undefined, ctx);
  assert.equal(touched, false);
  assert.equal(result.isError, true);
  assert.equal(result.details.route.route, "codemode"); // Legacy metadata, not dispatch.
  assert.equal(result.details.preflight.supported, false);
  assert.equal("route" in result.details.preflight, false);
  assert.equal(result.details.error.kind, "NativeCodemodeRequired");
  assert.deepEqual(result.details.toolCalls, []);
  assert.match(result.content[0].text, /not executed/i);
  assert.match(result.content[0].text, /codemode/);
});

test("OpenCode results expose compatibility outcome; execution failures never replay", async () => {
  let tool;
  createOpenCodeModeExtension()({ registerTool(value) { tool = value; } });
  let calls = 0;
  const ctx = {
    tools: [{ name: "write", parameters: { type: "object" } }],
    async executeTool() { calls++; return { result: { content: [{ type: "text", text: "done" }] } }; },
  };
  const success = await tool.execute("ok", { code: "return 42;" }, undefined, undefined, ctx);
  assert.equal(success.details.route.route, "codemode_o");
  assert.equal(success.details.preflight.supported, true);
  const failure = await tool.execute("fail", { code: 'await tools.write({}); throw new Error("stop");' }, undefined, undefined, ctx);
  assert.equal(failure.isError, true);
  assert.equal(calls, 1);
  assert.equal(failure.details.route.route, "codemode_o");
  assert.equal(failure.details.preflight.supported, true);
});
