import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createCodemodeExtension, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createOpenCodeModeExtension } from "../index.js";
import { formatDuration } from "../renderer.js";

// Built-in palette only, no watcher or personal settings/resources.
initTheme("dark", false);
const colors = [];
const theme = { fg(color, value) { colors.push(color); return value; }, bold(value) { return value; } };
function tool() {
  let definition;
  createOpenCodeModeExtension()({ registerTool(value) { definition = value; } });
  return definition;
}
function context(overrides = {}) {
  return { state: {}, executionStarted: false, expanded: false, isError: false, ...overrides };
}
function result(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}
function lines(component, width = 80) {
  const rendered = component.render(width);
  for (const line of rendered) assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${visibleWidth(line)}`);
  return rendered.map((line) => stripVTControlCharacters(line).trimEnd());
}
function render(value, options = {}, ctx = context(), width = 80) {
  return lines(tool().renderResult(value, { expanded: false, isPartial: false, ...options }, theme, ctx), width).join("\n");
}

test("native-style duration is concise for short and long runs", () => {
  for (const [ms, expected] of [[0, "0.0s"], [42, "0.0s"], [1234, "1.2s"], [59000, "59.0s"], [60000, "1m 0s"], [3661000, "1h 1m 1s"]]) {
    assert.equal(formatDuration(ms), expected);
  }
});

test("call renderer shows source rather than escaped JSON arguments", () => {
  const definition = tool();
  const code = 'const value = 42;\nreturn value;';
  const text = lines(definition.renderCall({ code }, theme, context()), 80).join("\n");
  assert.equal(text, 'codemode_o (OpenCode)\nconst value = 42;\nreturn value;');
  assert.match(lines(definition.renderCall({}, theme, context())).join("\n"), /\[invalid arg\]/);
});

test("collapsed source and output cap visual lines, including long Unicode JSON", () => {
  const definition = tool();
  const code = '// ' + "한😀".repeat(200);
  const collapsedCode = lines(definition.renderCall({ code }, theme, context()), 24);
  assert.equal(collapsedCode.length, 12); // title + 10 visual lines + expand hint
  const value = result('"' + "한😀".repeat(200) + '"', { durationMs: 1234 });
  const snapshot = structuredClone(value);
  for (const width of [12, 24, 80]) {
    const collapsed = render(value, {}, context(), width);
    assert.match(collapsed, /\.\.\. \(/);
    assert.match(collapsed, /Took 1\.2s/);
    const expanded = render(value, { expanded: true }, context(), width);
    assert.ok(expanded.split("\n").length > collapsed.split("\n").length);
    assert.doesNotMatch(expanded, /more lines/);
  }
  assert.deepEqual(value, snapshot, "rendering never alters model-visible output");
});

test("ordinary and expanded output matches native codemode without optional timing", () => {
  let native;
  // Capture public factory registration only; never execute native QuickJS or touch settings.
  createCodemodeExtension()({ registerTool(value) { native = value; } });
  // Older native renderers have neither a timer nor visual-line collapse.
  // Compare the shared output contract; separate tests verify our footer and
  // collapsed Unicode previews rather than imposing newer native UI on old Pi.
  for (const [expanded, text] of [[false, "42"], [true, "42"], [true, '"한😀"'.repeat(100)]]) {
    const options = { expanded, isPartial: false };
    const ctx = context({ expanded });
    const expected = lines(native.renderResult(result(text), options, theme, ctx), 40);
    const actual = lines(tool().renderResult(result(text), options, theme, ctx), 40);
    assert.deepEqual(actual, expected);
  }
});

test("result previews preserve indentation and trailing blank lines", () => {
  const value = result("  indented log\n\n");
  const snapshot = structuredClone(value);
  for (const expanded of [false, true]) {
    assert.equal(render(value, { expanded }), "\n  indented log\n\n");
  }
  assert.deepEqual(value, snapshot);
  assert.deepEqual(lines(tool().renderResult(result(""), { expanded: true, isPartial: false }, theme, context())), []);
});

test("warnings and incomplete-output notice stay visible when data is collapsed", () => {
  colors.length = 0;
  const value = result("data\n".repeat(100), { durationMs: 500, truncated: true, warnings: [{ kind: "Truncated", message: "clipped" }] });
  const text = render(value);
  assert.match(text, /1 warning/);
  assert.match(text, /Output truncated; incomplete preview/);
  assert.match(text, /Took 0\.5s/);
  assert.ok(colors.includes("warning"));
  assert.doesNotMatch(text, /Full output:/, "no nonexistent output file is advertised");
});

test("errors, legacy results, partial results and restored timings render safely", () => {
  colors.length = 0;
  assert.match(render(result("ExecutionFailure: denied", { ok: false, durationMs: 100 })), /denied/);
  assert.ok(colors.includes("error"));
  assert.equal(render(result("legacy")), "\nlegacy");
  assert.equal(render(result("no timing", { durationMs: NaN })), "\nno timing");
  assert.equal(render(result("", { durationMs: 0 })), "\nTook 0.0s");
  assert.match(render(result("ok", { durationMs: 1000 }), {}, context({ durationMs: 2300 })), /Took 2\.3s/);
  const ctx = context({ executionStarted: true });
  tool().renderCall({ code: "return 1" }, theme, ctx);
  const startedAt = ctx.state.startedAt;
  tool().renderCall({ code: "return 1" }, theme, ctx);
  assert.equal(ctx.state.startedAt, startedAt, "repaints do not reset start time");
  const partial = render(result("stale output", { durationMs: 1000 }), { isPartial: true }, ctx);
  assert.match(partial, /Elapsed/);
  assert.doesNotMatch(partial, /Took|stale output/);
  assert.match(render(result("done", { durationMs: 1000 }), {}, context()), /Took 1\.0s/, "restored rows need no live clock");
});

test("component reuse, resize and invalidation do not retain stale output or theme", () => {
  const definition = tool();
  const old = definition.renderResult(result("old"), { expanded: false, isPartial: false }, theme, context());
  const otherTheme = { ...theme, fg(_color, value) { return `[${value}]`; } };
  const next = definition.renderResult(result("new"), { expanded: true, isPartial: false }, otherTheme, context({ lastComponent: old }));
  assert.equal(next, old);
  next.invalidate();
  const text = lines(next, 20).join("\n");
  assert.match(text, /\[new\]/);
  assert.doesNotMatch(text, /old/);
});

test("all execution exit paths record finite duration without changing content", async () => {
  const definition = tool();
  const aborted = new AbortController();
  aborted.abort();
  for (const [code, signal] of [["return 42"], ['throw new Error("bad")'], ['text("native")'], ["return 42", aborted.signal]]) {
    const value = await definition.execute("timing", { code }, signal, undefined, { tools: [] });
    assert.ok(Number.isFinite(value.details.durationMs));
    assert.ok(value.details.durationMs >= 0);
    assert.match(render(value), /Took /);
    if (!signal && code === "return 42") assert.equal(value.content[0].text, "42");
  }
  const value = await definition.execute("wait", { code: 'return await tools.wait({});' }, undefined, undefined, {
    tools: [{ name: "wait" }],
    async executeTool() { await delay(25); return { result: { content: [{ type: "text", text: "done" }] } }; },
  });
  assert.ok(value.details.durationMs >= 20);
  assert.equal(value.content[0].text, '"done"');
});
