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

test("formatted source preview separates calls and expansion retains execution source", () => {
  const definition = tool();
  const code = 'const r = await Promise.allSettled([tools.read({path:"A"}),tools.read({path:"B"}),tools.bash({command:"not executed"})]); for(let i=0;i<r.length;i++){console.log(r[i]);}';
  const args = { code };
  const snapshot = structuredClone(args);
  const ctx = context();
  const collapsed = lines(definition.renderCall(args, theme, ctx), 160).join("\n");
  assert.match(collapsed, /^codemode_o \(OpenCode\)\nPreview; expand for original\n/);
  assert.match(collapsed, /\n  tools.read\(\{path:"A"\}\),\n  tools.read\(\{path:"B"\}\),\n  tools.bash/);
  assert.doesNotMatch(collapsed, /Original source \(/);
  const cached = ctx.state.sourcePreview;
  const expanded = lines(definition.renderCall(args, theme, { ...ctx, expanded: true }), 240).join("\n");
  assert.match(expanded, /Original source \(execution and error locations\)/);
  assert.ok(expanded.endsWith(code));
  assert.match(expanded, /^codemode_o \(OpenCode\)\nPreview; expand for original\n/);
  assert.equal(ctx.state.sourcePreview, cached, "layout is cached separately from theme styling");
  assert.deepEqual(args, snapshot, "formatting never changes execution or stored arguments");
  definition.renderCall({ code: "return 42;" }, theme, ctx);
  assert.equal(ctx.state.sourcePreview.code, "return 42;");
});

test("concise preview notice stays above the source when collapsed and expanded", () => {
  const definition = tool();
  const code = "return [" + Array.from({ length: 12 }, (_, i) => `tools.read({path:"file_${i}"})`).join(",") + "];";
  const ctx = context();
  const component = definition.renderCall({ code }, theme, ctx);
  const text = lines(component, 120).join("\n");
  assert.match(text, /^codemode_o \(OpenCode\)\nPreview; expand for original\nreturn \[\n  tools.read/);
  assert.match(text, /more lines,.*to expand\)$/);
  for (const width of [12, 24, 80]) lines(component, width);
  const expanded = lines(definition.renderCall({ code }, theme, { ...ctx, expanded: true, lastComponent: component }), 120).join("\n");
  assert.doesNotMatch(expanded, /more lines|to expand|Formatted preview|display only/);
  assert.match(expanded, /^codemode_o \(OpenCode\)\nPreview; expand for original\nreturn \[/);
  assert.ok(expanded.indexOf("Original source") > expanded.indexOf('tools.read({path:"file_11"})'));
});

test("invalid and incomplete source render unformatted without escaping repair", () => {
  const definition = tool();
  for (const code of ['return "\n";', 'await tools.read({']) {
    const args = { code };
    const ctx = context();
    const text = lines(definition.renderCall(args, theme, ctx)).join("\n");
    assert.doesNotMatch(text, /Preview; expand for original/);
    assert.equal(ctx.state.sourcePreview.formatted, code);
    assert.equal(args.code, code);
  }
});

test("call summaries render duplicate names as distinct status rows without changing output", () => {
  const value = result("42", { calls: [
    { name: "read", args: '{"path":"A"}', status: "ok", durationMs: 12 },
    { name: "read", args: '{"path":"B"}', status: "error", durationMs: 3, error: "denied\nreason" },
    { name: "bash", args: '{"command":"not executed"}', status: "cancelled", durationMs: 4 },
  ], durationMs: 20 });
  const snapshot = structuredClone(value);
  const collapsed = render(value);
  assert.match(collapsed, /✓ read \{"path":"A"\} 12ms\n✗ read \{"path":"B"\} 3ms\n⊘ bash/);
  assert.doesNotMatch(collapsed, /denied/);
  const expanded = render(value, { expanded: true });
  assert.match(expanded, /denied\n    reason/);
  assert.ok(expanded.endsWith("Took 0.0s"));
  assert.match(expanded, /\n42\n/);
  assert.deepEqual(value, snapshot);
});

test("collapsed calls show the last eight in bounded rows, expanded shows all retained previews", () => {
  const value = result("", { calls: Array.from({ length: 12 }, (_, i) => ({
    name: `host_${i}`, args: JSON.stringify({ path: "한😀".repeat(200) }), status: "ok", durationMs: 2,
  })) });
  const collapsed = render(value);
  assert.match(collapsed, /4 earlier calls/);
  assert.doesNotMatch(collapsed, /✓ host_0 /);
  assert.match(collapsed, /✓ host_4 /);
  assert.match(collapsed, /✓ host_11 /);
  assert.equal(collapsed.split("\n").length, 10);
  const expanded = render(value, { expanded: true });
  assert.match(expanded, /✓ host_0 /);
  assert.doesNotMatch(expanded, /earlier calls/);
  assert.ok(expanded.length > collapsed.length);
  for (const width of [5, 12, 24, 80]) {
    assert.ok(render(value, {}, context(), width).split("\n").length <= 10);
    render(value, { expanded: true }, context(), width);
  }
});

test("partial rows show running calls and elapsed time, legacy rows never infer success", () => {
  const value = result("stale output", { calls: [{ name: "read", args: '{"path":"A"}', status: "running" }] });
  const ctx = context({ state: { startedAt: Date.now() } });
  const text = render(value, { isPartial: true }, ctx);
  assert.match(text, /… read/);
  assert.match(text, /Elapsed/);
  assert.doesNotMatch(text, /stale output|Took/);
  assert.equal(render(result("legacy", { toolCalls: [{ name: "read" }] })), "\nlegacy");
  assert.match(render(result("", { calls: [{ name: "old", args: "{}" }] })), /\? old/);
  assert.match(render(result("", { calls: [null, { name: "old", status: "constructor" }] })), /\? old/);
});

test("formatted and call-list components repaint for resize, expansion and theme changes", () => {
  const definition = tool();
  const args = { code: 'const r=[tools.read({path:"한😀"}),tools.read({path:"B"})]; return r;' };
  const ctx = context();
  const source = definition.renderCall(args, theme, ctx);
  for (const width of [12, 24, 80]) lines(source, width);
  const newTheme = { ...theme, fg(_color, value) { return `[${value}]`; } };
  const next = definition.renderCall(args, newTheme, { ...ctx, expanded: true, lastComponent: source });
  assert.equal(next, source);
  next.invalidate();
  assert.match(lines(next, 80).join("\n"), /\[Original source/);
  const value = result("", { calls: [{ name: "read", args: "{}", status: "ok", durationMs: 1 }] });
  const rows = definition.renderResult(value, { expanded: false, isPartial: false }, theme, context());
  const updated = definition.renderResult(value, { expanded: true, isPartial: false }, newTheme, context({ lastComponent: rows }));
  updated.invalidate();
  assert.match(lines(updated).join("\n"), /\[✓\]/);
});

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
