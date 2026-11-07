import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createOpenCodeRenderers } from "../renderer.js";
import { formatSourcePreview } from "../source-preview.js";

const context = (extra = {}) => ({ state: {}, expanded: false, executionStarted: true, keyHint: () => "expand", ...extra });
const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
const value = (text, details = {}) => ({ content: [{ type: "text", text }], details });
function text(component, width = 120) {
  const lines = component.render(width);
  for (const line of lines) assert.ok(visibleWidth(line) <= width);
  return lines.map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
}
function instrument() {
  const counts = { format: 0, highlight: 0 };
  const renderers = createOpenCodeRenderers({
    formatSource(code) { counts.format++; return formatSourcePreview(code); },
    highlightSource(code) { counts.highlight++; return code.split("\n"); },
  });
  return { renderers, counts };
}

test("unchanged source lazily highlights once and keeps its Text across call updates and widths", () => {
  const { renderers, counts } = instrument();
  const ctx = context(), args = { code: "return 42;" };
  const component = renderers.renderCall(args, theme, ctx);
  ctx.lastComponent = component;
  assert.equal(counts.highlight, 0, "no highlight work before an actual paint");
  text(component);
  const source = component.parts.get("source").component;
  for (let i = 0; i < 129; i++) {
    assert.equal(renderers.renderCall(args, theme, ctx), component);
    text(component, [12, 24, 120][i % 3]);
  }
  assert.equal(counts.format, 1);
  assert.equal(counts.highlight, 1);
  assert.equal(component.parts.get("source").component, source);
  for (let i = 0; i < 20; i++) text(renderers.renderCall({ code: `return ${i};` }, theme, ctx));
  assert.equal(component.parts.size, 2, "retain current title/source, not source history");
});

test("invalidate repaints embedded highlight/style strings for a stable theme Proxy", () => {
  let palette = "old";
  const stableTheme = new Proxy({}, { get(_target, key) {
    if (key === "fg") return (_color, source) => `[${palette}]${source}`;
    if (key === "bold") return (source) => source;
  } });
  let highlights = 0;
  const renderers = createOpenCodeRenderers({ highlightSource(source) {
    highlights++;
    return [stableTheme.fg("syntaxKeyword", source)];
  } });
  const ctx = context(), args = { code: "return 42;" };
  const component = renderers.renderCall(args, stableTheme, ctx);
  ctx.lastComponent = component;
  assert.match(text(component), /\[old\]return/);
  palette = "new";
  component.invalidate();
  assert.equal(renderers.renderCall(args, stableTheme, ctx), component);
  const rendered = text(component);
  assert.match(rendered, /\[new\]return/);
  assert.doesNotMatch(rendered, /\[old\]/);
  assert.equal(highlights, 2);
});

test("streaming prefixes skip parsing/highlighting and completion restores formatted original expansion", () => {
  const { renderers, counts } = instrument();
  const ctx = context({ executionStarted: false, argsComplete: false });
  const code = 'const r=[tools.read({path:"한😀"}),tools.read({path:"B"})]; return r;';
  for (const prefix of [code.slice(0, 20), code.slice(0, 39), code]) {
    ctx.lastComponent = renderers.renderCall({ code: prefix }, theme, ctx);
    const rendered = text(ctx.lastComponent);
    assert.match(rendered, /Source streaming/);
    assert.equal(ctx.state.sourcePreview.formatted, prefix);
  }
  assert.deepEqual(counts, { format: 0, highlight: 0 });
  ctx.argsComplete = true;
  ctx.expanded = true;
  const args = { code };
  ctx.lastComponent = renderers.renderCall(args, theme, ctx);
  const rendered = text(ctx.lastComponent);
  assert.match(rendered, /Preview; expand for original/);
  assert.match(rendered, /Original source/);
  assert.ok(rendered.endsWith(code));
  assert.equal(args.code, code);
  assert.deepEqual(counts, { format: 1, highlight: 2 });
});

test("execution start completes old-host streaming state even without argsComplete transition", () => {
  const { renderers, counts } = instrument();
  const ctx = context({ executionStarted: false, argsComplete: false });
  ctx.lastComponent = renderers.renderCall({ code: "return 42;" }, theme, ctx);
  text(ctx.lastComponent);
  ctx.executionStarted = true;
  text(renderers.renderCall({ code: "return 42;" }, theme, ctx));
  assert.deepEqual(counts, { format: 1, highlight: 1 });
});

test("oversized source has a bounded Unicode-safe raw preview and full original on expansion", () => {
  const { renderers, counts } = instrument();
  const code = "// " + "한😀".repeat(5000) + " ORIGINAL_TAIL";
  const args = { code }, ctx = context();
  ctx.lastComponent = renderers.renderCall(args, theme, ctx);
  const collapsed = text(ctx.lastComponent, 40);
  assert.match(collapsed, /Source preview limited/);
  assert.doesNotMatch(collapsed, /ORIGINAL_TAIL|\uFFFD/);
  assert.ok(Buffer.byteLength(ctx.state.sourcePreview.formatted) <= 8192);
  ctx.expanded = true;
  assert.match(text(renderers.renderCall(args, theme, ctx), 120), /ORIGINAL_TAIL/);
  assert.deepEqual(counts, { format: 0, highlight: 0 });
  assert.equal(args.code, code);
});

test("oversized whitespace prefix still allows expansion to inspect the original tail", () => {
  const { renderers, counts } = instrument();
  const code = " ".repeat(9000) + "return 42;";
  const ctx = context();
  ctx.lastComponent = renderers.renderCall({ code }, theme, ctx);
  assert.match(text(ctx.lastComponent), /Source preview limited/);
  ctx.expanded = true;
  assert.match(text(renderers.renderCall({ code }, theme, ctx)), /return 42;/);
  assert.deepEqual(counts, { format: 0, highlight: 0 });
});

test("source cache preserves lone surrogates and releases old preview for invalid args", () => {
  const { renderers } = instrument();
  const ctx = context(), code = 'return "\uD800";';
  ctx.lastComponent = renderers.renderCall({ code }, theme, ctx);
  text(ctx.lastComponent);
  assert.equal(ctx.state.sourcePreview.code, code);
  assert.equal(ctx.state.sourcePreview.limited, false);
  text(renderers.renderCall({}, theme, ctx));
  assert.equal(ctx.state.sourcePreview, undefined);
  assert.equal(ctx.lastComponent.parts.size, 1);
});

test("result output child survives timer/call updates but not replaced text, theme or expansion", () => {
  const { renderers } = instrument();
  const ctx = context(), result = value("long output ".repeat(1000), { durationMs: 10 });
  ctx.lastComponent = renderers.renderResult(result, { expanded: false, isPartial: false }, theme, ctx);
  text(ctx.lastComponent);
  const output = ctx.lastComponent.parts.get("output").component;
  result.details.calls = [{ name: "host", args: "{}", status: "running" }];
  result.details.durationMs = 1000;
  text(renderers.renderResult(result, { expanded: false, isPartial: false }, theme, ctx));
  assert.equal(ctx.lastComponent.parts.get("output").component, output);
  result.details.calls[0].status = "error";
  result.details.calls[0].error = "denied";
  result.details.warnings = [{}];
  result.details.truncated = true;
  const updated = text(renderers.renderResult(result, { expanded: false, isPartial: false }, theme, ctx));
  assert.match(updated, /1 failed|1 warning/);
  assert.match(updated, /Output truncated/);
  assert.equal(ctx.lastComponent.parts.get("output").component, output);
  result.content[0].text = "REPLACED";
  assert.match(text(renderers.renderResult(result, { expanded: true, isPartial: false }, theme, ctx)), /REPLACED/);
  assert.notEqual(ctx.lastComponent.parts.get("output").component, output);
  const otherTheme = { ...theme, fg(_color, source) { return `[new]${source}`; } };
  assert.match(text(renderers.renderResult(result, { expanded: true, isPartial: false }, otherTheme, ctx)), /\[new\]REPLACED/);
});

test("result invalidate updates same-instance palette and partial transitions evict stale output", () => {
  let prefix = "old";
  const mutableTheme = { fg(_color, source) { return `${prefix}:${source}`; } };
  const { renderers } = instrument(), ctx = context();
  const result = value("body", { durationMs: 10 });
  ctx.lastComponent = renderers.renderResult(result, { expanded: false, isPartial: false }, mutableTheme, ctx);
  assert.match(text(ctx.lastComponent), /old:body/);
  prefix = "new";
  ctx.lastComponent.invalidate();
  assert.match(text(ctx.lastComponent), /new:body/);
  assert.doesNotMatch(text(ctx.lastComponent), /old:/);
  const partial = text(renderers.renderResult(result, { expanded: false, isPartial: true }, mutableTheme, ctx));
  assert.doesNotMatch(partial, /body|Took/);
  assert.equal(ctx.lastComponent.parts.has("output"), false);
});

test("row caches and injected keybinding hints are isolated", () => {
  const { renderers } = instrument();
  const a = context({ keyHint: () => "EXPAND_A" }), b = context({ keyHint: () => "EXPAND_B" });
  const args = { code: "// " + "long ".repeat(300) };
  a.lastComponent = renderers.renderCall(args, theme, a);
  b.lastComponent = renderers.renderCall(args, theme, b);
  assert.notEqual(a.lastComponent, b.lastComponent);
  assert.match(text(a.lastComponent, 80), /EXPAND_A/);
  assert.match(text(b.lastComponent, 80), /EXPAND_B/);
  text(renderers.renderCall({ code: "return 1;" }, theme, a));
  assert.match(text(b.lastComponent, 80), /EXPAND_B/);
});
