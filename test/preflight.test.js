import assert from "node:assert/strict";
import test from "node:test";
import { checkOpenCodeCompatibility } from "../route.js";
import { createOpenCodeModeExtension } from "../index.js";
import { command, escapedSource, rawNewlineSource } from "./fixtures/preflight-source.js";

function registeredTool(options) {
  let tool;
  createOpenCodeModeExtension(options)({ registerTool(value) { tool = value; } });
  return tool;
}
const forbiddenContext = {
  get tools() { assert.fail("must reject before constructing runtime"); },
  executeTool() { assert.fail("no host calls or native delegation"); },
};

test("regex log extraction executes the formerly rejected program with stub host tools", async () => {
  const code = String.raw`const log = await tools.read({path:"test-log.txt"});
return {summary: log.match(/ℹ (tests|pass|fail|skipped) [0-9]+/g), exits: log.match(/"exit_code":\d+/g), diff: await tools.bash({command:"git diff --check && git status --short",timeout:15})};`;
  const params = { code };
  const calls = [];
  const diff = { output: " M renderer.js\n", truncated: false, exit_code: 0 };
  const result = await registeredTool().execute("regex-log", params, undefined, undefined, {
    tools: ["read", "bash"].map((name) => ({ name, parameters: { type: "object" } })),
    async executeTool(name, args) {
      calls.push({ name, args });
      return { result: name === "read"
        ? { content: [{ type: "text", text: 'ℹ tests 78\nℹ pass 78\nℹ fail 0\nℹ skipped 0\n{"exit_code":0}' }] }
        : { content: [], structuredContent: diff } };
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.preflight.supported, true);
  assert.equal(params.code, code, "no rewriting or native replay");
  assert.deepEqual(JSON.parse(result.content[0].text), {
    summary: ["ℹ tests 78", "ℹ pass 78", "ℹ fail 0", "ℹ skipped 0"],
    exits: ['"exit_code":0'], diff,
  });
  assert.deepEqual(calls, [
    { name: "read", args: { path: "test-log.txt" } },
    { name: "bash", args: { command: "git diff --check && git status --short", timeout: 15 } },
  ]);
  assert.deepEqual(result.details.calls.map((call) => call.status), ["ok", "ok"]);
});

test("switch and admitted constructors execute in the installed OpenCode runtime", async () => {
  const code = `let n = 0;
switch (1) { case 1: n += 1; case 2: n += 10; break; default: n += 100; }
return {
  n,
  date: new Date(0).toISOString(),
  matched: new RegExp("a", "i").test("A"),
  value: new Map([["k", 7]]).get("k"),
  size: new Set([1, 1, 2]).size,
  host: new URL("https://example.com/a").hostname,
  evalName: new EvalError("e").name,
  uriMessage: new URIError("u").message,
};`;
  const result = await registeredTool().execute("supported-syntax", { code }, undefined, undefined, { tools: [] });
  assert.equal(result.details.preflight.supported, true);
  assert.equal(result.details.ok, true, result.content?.[0]?.text);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    n: 11,
    date: "1970-01-01T00:00:00.000Z",
    matched: true,
    value: 7,
    size: 2,
    host: "example.com",
    evalName: "EvalError",
    uriMessage: "u",
  });
});

test("for-in is rejected before earlier host calls or runtime construction", async () => {
  for (const source of [
    'const keys = []; for (const key in { a: 1 }) keys.push(key); return keys;',
    'const obj = Object.create({ p: 1 }); obj.a = 2; const keys = []; for (const key in obj) keys.push(key); return keys;',
    'const obj = { a: 1, b: 2, c: 3 }, keys = []; for (const key in obj) { keys.push(key); delete obj.b; } return keys;',
  ]) {
    const params = { code: 'await tools.write({}); ' + source };
    const original = params.code;
    const result = await registeredTool().execute("for-in", params, undefined, undefined, forbiddenContext);
    assert.equal(result.isError, true);
    assert.equal(result.details.error.kind, "NativeCodemodeRequired");
    assert.deepEqual(result.details.preflight.reasons, ["unsupported-syntax:ForInStatement"]);
    assert.deepEqual(result.details.toolCalls, []);
    assert.deepEqual(result.details.calls, []);
    assert.equal(params.code, original, "no rewriting, host effects, or native delegation");
  }
});

test("regex literal methods and flags execute in the installed OpenCode runtime", async () => {
  for (const [code, expected] of [
    ['return /x/.test("x");', true],
    [String.raw`return "A/b a/B".match(/a\/b/gi);`, ["A/b", "a/B"]],
    [String.raw`return /^한.$/u.test("한😀");`, true],
    [String.raw`return /^b$/m.test("a\nb");`, true],
    [String.raw`return /a.b/s.test("a\nb");`, true],
    ['const re = /a/y; return [re.test("aa"), re.lastIndex, re.test("aa"), re.lastIndex];', [true, 1, true, 2]],
    ['return /a/d.exec("ba").indices[0];', [1, 2]],
    ['return /[a&&a]/v.test("a");', true],
    ['return /text|models|@options:/.test("models");', true],
  ]) {
    const result = await registeredTool().execute("regex", { code }, undefined, undefined, { tools: [] });
    assert.equal(result.details.ok, true, code);
    assert.deepEqual(JSON.parse(result.content[0].text), expected, code);
  }
});

test("malformed regex literals fail as source syntax errors before any host call", async () => {
  for (const literal of ["/[/", "/x/gg", "/x/z", "/x/uv", "/unterminated"]) {
    const code = `await tools.write({}); return ${literal};`;
    const preflight = checkOpenCodeCompatibility(code);
    assert.deepEqual(preflight.reasons, ["invalid-script-syntax"]);
    assert.equal(preflight.diagnostic.kind, "SourceSyntaxError");
    const result = await registeredTool().execute("bad-regex", { code }, undefined, undefined, forbiddenContext);
    assert.equal(result.isError, true);
    assert.equal(result.details.error.kind, "SourceSyntaxError");
    assert.deepEqual(result.details.calls, []);
    assert.doesNotMatch(result.content[0].text, /NativeCodemodeRequired/);
  }
});

test("raw newlines in quoted strings retain Acorn positions and escape guidance", () => {
  for (const quote of ['"', "'"]) {
    for (const newline of ["\n", "\r", "\r\n"]) {
      const code = `return ${quote}${newline}${quote};`;
      const result = checkOpenCodeCompatibility(code);
      assert.equal(result.supported, false);
      assert.deepEqual(result.reasons, ["invalid-script-syntax"]);
      assert.equal(result.executesSource, false);
      const diagnostic = result.diagnostic;
      assert.equal(diagnostic.kind, "SourceSyntaxError");
      assert.equal(diagnostic.message, "Unterminated string constant (1:7)");
      assert.equal(diagnostic.parser, "acorn");
      assert.equal(diagnostic.sourceType, "script");
      assert.equal(diagnostic.pos, 7);
      assert.equal(diagnostic.raisedAt, 8);
      assert.deepEqual(diagnostic.location, { line: 1, column: 7 });
      assert.deepEqual(diagnostic.detectedLocation, { line: 1, column: 8 });
      assert.ok(diagnostic.hint.includes("\\n"));
      assert.ok(diagnostic.hint.includes("\\\\n"));
      assert.equal("stack" in diagnostic, false);
      assert.ok(Object.isFrozen(diagnostic));
      assert.ok(Object.isFrozen(diagnostic.location));
      assert.ok(Object.isFrozen(diagnostic.detectedLocation));
    }
  }
  for (const code of ['return "\\n";', "return '\\n';", 'return `\n`;', 'return "\\\n";']) {
    assert.equal(checkOpenCodeCompatibility(code).supported, true, code);
  }
});

test("heredoc fixture differs only in newline escaping, not tool syntax or Korean", () => {
  assert.equal(checkOpenCodeCompatibility(escapedSource).supported, true);
  const failed = checkOpenCodeCompatibility(rawNewlineSource);
  assert.equal(failed.diagnostic.pos, rawNewlineSource.indexOf('"'));
  assert.equal(failed.diagnostic.raisedAt, rawNewlineSource.indexOf("\n"));
  assert.equal(failed.diagnostic.kind, "SourceSyntaxError");
  assert.equal(rawNewlineSource.replaceAll("\n", "\\n"), escapedSource);
  assert.equal(Buffer.byteLength(escapedSource) - Buffer.byteLength(rawNewlineSource), command.split("\n").length - 1);
});

test("syntax diagnostics use UTF-16 offsets and preserve CRLF line positions", () => {
  const code = '// 한😀\r\nreturn "\n";';
  const diagnostic = checkOpenCodeCompatibility(code).diagnostic;
  assert.equal(diagnostic.pos, code.indexOf('"'));
  assert.equal(diagnostic.raisedAt, code.indexOf('"') + 1);
  assert.deepEqual(diagnostic.location, { line: 2, column: 7 });
  assert.deepEqual(diagnostic.detectedLocation, { line: 2, column: 8 });
  assert.ok(Buffer.byteLength(code.slice(0, diagnostic.pos)) > diagnostic.pos);
});

test("invalid source is never rewritten, executed partially, or sent to native", async () => {
  const tool = registeredTool();
  for (const code of [rawNewlineSource, 'await tools.write({}); return "\n";', "return (", 'import fs from "node:fs";']) {
    const params = { code };
    const result = await tool.execute("syntax", params, undefined, undefined, forbiddenContext);
    assert.equal(params.code, code);
    assert.equal(result.isError, true);
    assert.equal(result.details.error.kind, "SourceSyntaxError");
    assert.deepEqual(result.details.toolCalls, []);
    assert.equal(result.details.preflight.executesSource, false);
    assert.deepEqual(result.details.error.location, result.details.preflight.diagnostic.location);
    assert.match(result.content[0].text, /^SourceSyntaxError: Source was not executed/);
    assert.match(result.content[0].text, /script mode; fix the source/);
    assert.match(result.content[0].text, /Acorn:/);
    assert.doesNotMatch(result.content[0].text, /NativeCodemodeRequired|Use Pi's built-in codemode/);
    if (code.includes('"\n')) {
      assert.match(result.content[0].text, /Detected at: line/);
      assert.match(result.content[0].text, /UTF-16 offset/);
      assert.match(result.content[0].text, /Escape newlines/);
    }
  }
});

test("escaped heredoc and progress combination runs only safe in-memory stubs", async () => {
  const tool = registeredTool();
  const calls = [];
  const params = { code: escapedSource };
  const result = await tool.execute("escaped", params, undefined, undefined, {
    tools: ["bash", "update_progress"].map((name) => ({ name, parameters: { type: "object" } })),
    async executeTool(name, args) {
      calls.push({ name, args });
      return { result: { content: [{ type: "text", text: "stub only" }] } };
    },
  });
  assert.equal(result.details.ok, true);
  assert.equal(params.code, escapedSource);
  assert.deepEqual(calls, [
    { name: "bash", args: { command, timeout: 10 } },
    { name: "update_progress", args: { steps: [{ text: "인계 자료 확인", status: "completed" }] } },
  ]);
  assert.deepEqual(JSON.parse(result.content[0].text), [
    { status: "fulfilled", value: "stub only" }, { status: "fulfilled", value: "stub only" },
  ]);
});

test("parser exceptions are distinct from syntax and compatibility failures, with bounded diagnostics", async () => {
  for (const error of [new Error("😀".repeat(10000)), new RangeError("parser stack exhausted"), new SyntaxError("parser implementation error"), "parser unavailable", null]) {
    const parseSource = () => { throw error; };
    const preflight = checkOpenCodeCompatibility("return 1;", parseSource);
    assert.equal(preflight.diagnostic.kind, "PreflightParserError");
    assert.deepEqual(preflight.reasons, ["internal-parser-error"]);
    assert.ok(Buffer.byteLength(preflight.diagnostic.message) < 600);
    assert.equal("stack" in preflight.diagnostic, false);
    assert.equal("location" in preflight.diagnostic, false);
    const result = await registeredTool({ parseSource }).execute("parser-failure", { code: "return 1;" }, undefined, undefined, forbiddenContext);
    assert.equal(result.details.error.kind, "PreflightParserError");
    assert.deepEqual(result.details.toolCalls, []);
    assert.match(result.content[0].text, /parser failed internally/);
    assert.doesNotMatch(result.content[0].text, /Use Pi's built-in codemode/);
    assert.ok(Buffer.byteLength(result.content[0].text) < 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(result.details.preflight)) < 2048);
    assert.ok(Buffer.byteLength(JSON.stringify(result.details.error)) < 2048);
    if (error instanceof Error) assert.ok(result.content[0].text.includes(error.message.slice(0, 20)));
  }
  const unsupported = checkOpenCodeCompatibility("class X {}");
  assert.deepEqual(unsupported.reasons, ["unsupported-syntax:ClassDeclaration"]);
  assert.equal("diagnostic" in unsupported, false);
  for (const source of ['return "', "return ("]) {
    const diagnostic = checkOpenCodeCompatibility(source).diagnostic;
    assert.equal(diagnostic.kind, "SourceSyntaxError");
    assert.equal("hint" in diagnostic, false, "only a detected raw newline gets escaping advice");
  }
});

test("long syntax errors are clipped and invalid parser offsets are not retained", () => {
  const name = "한".repeat(1000);
  const diagnostic = checkOpenCodeCompatibility(`let ${name}; let ${name};`).diagnostic;
  assert.equal(diagnostic.kind, "SourceSyntaxError");
  assert.match(diagnostic.message, /parser message truncated/);
  assert.ok(Buffer.byteLength(diagnostic.message) < 600);
  const error = Object.assign(new SyntaxError("injected"), { pos: -1, raisedAt: Infinity, loc: { line: "x".repeat(10000) } });
  const failure = checkOpenCodeCompatibility("return 1;", () => { throw error; });
  assert.equal(failure.diagnostic.kind, "PreflightParserError");
  assert.equal("pos" in failure.diagnostic, false);
  assert.equal("raisedAt" in failure.diagnostic, false);
  assert.equal("location" in failure.diagnostic, false);
  assert.equal("detectedLocation" in failure.diagnostic, false);
});
