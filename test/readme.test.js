import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOpenCodeModeExtension } from "../index.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const packageSource = readFileSync(new URL("../package.json", import.meta.url), "utf8");
function examples(heading) {
  const start = readme.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, heading);
  const end = readme.indexOf("\n## ", start + 1);
  return [...readme.slice(start, end === -1 ? undefined : end).matchAll(/^([ \t]*)```js\n([\s\S]*?)^\1```/gm)]
    .map((match) => match[2].split("\n").map((line) => line.slice(match[1].length)).join("\n"));
}
function setup() {
  let tool;
  createOpenCodeModeExtension()({ registerTool(value) { tool = value; } });
  const calls = [];
  const ctx = {
    tools: [
      { name: "read", description: "Read file contents", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "find", description: "Find files by glob", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, limit: { type: "number" } }, required: ["pattern"] } },
      ...Array.from({ length: 4 }, (_, index) => ({ name: `host_${index}`, description: "Other callable host tool", parameters: { type: "object" } })),
      { name: "codemode" }, { name: "codemode_o" },
    ],
    async executeTool(name, args) {
      calls.push({ name, args });
      let text;
      if (name === "read" && args.path === "package.json") text = packageSource;
      else if (name === "read" && args.path === "README.md") text = readme;
      else if (name === "find") text = "alpha.test.js\nbeta.test.js";
      else throw new Error(`Unexpected host call: ${name}`);
      return { result: { content: [{ type: "text", text }] } };
    },
  };
  async function run(code) {
    const result = await tool.execute("readme", { code }, undefined, undefined, ctx);
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.equal(result.details.route.route, "codemode_o");
    return { value: JSON.parse(result.content[0].text), details: result.details };
  }
  return { tool, calls, run };
}

test("README first-success source runs as an active codemode_o tool", async () => {
  const { tool, calls, run } = setup();
  assert.equal(tool.name, "codemode_o");
  assert.equal(tool.defaultActive, true);
  assert.match(tool.description, /synchronous search/);
  const snippets = examples("Quick start");
  assert.equal(snippets.length, 1);
  assert.equal((await run(snippets[0])).value, 42);
  assert.deepEqual(calls, []);
});

test("README multi-tool example returns a compact overview with the documented inputs", async () => {
  const { calls, run } = setup();
  const snippets = examples("When to choose which tool");
  assert.equal(snippets.length, 1);
  const { value } = await run(snippets[0]);
  const pkg = JSON.parse(packageSource);
  assert.deepEqual(value, { name: pkg.name, testCommand: pkg.scripts.test, testFiles: "alpha.test.js\nbeta.test.js" });
  assert.deepEqual(calls, [
    { name: "read", args: { path: "package.json" } },
    { name: "find", args: { pattern: "**/*.test.js", path: "test", limit: 20 } },
  ]);
});

test("README search examples expose input signatures without invoking host tools", async () => {
  const { calls, run } = setup();
  const snippets = examples("Discover tools and their arguments");
  assert.equal(snippets.length, 3);
  const lookup = await run(snippets[0]);
  assert.equal(lookup.value.items.length, 1);
  assert.equal(lookup.value.items[0].path, "tools.read");
  assert.match(lookup.value.items[0].signature, /path: string/);
  assert.equal(lookup.value.remaining, 0);
  assert.equal(lookup.value.next, null);
  assert.deepEqual(lookup.details.toolCalls, [{ name: "search" }]);
  assert.deepEqual(calls, []);

  const first = await run(snippets[2]);
  assert.equal(first.value.items.length, 5);
  assert.equal(first.value.remaining, 1);
  assert.deepEqual(first.value.next, { offset: 5 });
  const next = await run(`return search({ query: "", limit: 5, offset: ${first.value.next.offset} });`);
  assert.equal(next.value.items.length, 1);
  assert.equal(next.value.remaining, 0);
  assert.equal(next.value.next, null);
  const paths = [...first.value.items, ...next.value.items].map((item) => item.path);
  assert.equal(new Set(paths).size, 6);
  assert.ok(!paths.includes("tools.codemode") && !paths.includes("tools.codemode_o"));
  assert.deepEqual(calls, []);

  const read = await run(snippets[1]);
  assert.equal(read.value, readme.length);
  assert.deepEqual(calls, [{ name: "read", args: { path: "README.md" } }]);
});
