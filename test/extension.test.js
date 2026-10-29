import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createOpenCodeModeExtension } from "../index.js";

function registeredTool() {
  const tools = [];
  createOpenCodeModeExtension()({
    registerTool(tool) { tools.push(tool); },
  });
  assert.equal(tools.length, 1);
  return tools[0];
}

function ctxWith(tools) {
  return {
    tools,
    async executeTool(name, args) {
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) return { isError: true, result: { content: [{ type: "text", text: `unknown ${name}` }] } };
      return tool.run(args);
    },
  };
}

test("package is one OpenCode-backed pi extension", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./index.js"]);
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@opencode/codemode", "acorn", "effect"]);
  assert.equal(pkg.dependencies["@opencode/codemode"], "2.2.1");
});

test("registration supplies conditional preference without routing or prompt hooks", () => {
  // This stub deliberately provides no lifecycle or activation APIs.
  const tool = registeredTool();
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bselectCodemodeRoute\b/, "execution must not use the legacy selector");
  const guidelines = tool.promptGuidelines.join("\n");
  assert.ok(guidelines.length <= 900, "keep model guidance concise");
  assert.match(guidelines, /Choose from task context/);
  assert.match(guidelines, /Prefer codemode_o for short, self-contained programs within its syntax\/limits, including tools\.bash and tools\.edit/);
  assert.match(guidelines, /Call codemode_o or native codemode directly \(model-only\)/);
  assert.match(guidelines, /Use native codemode upfront/);
  assert.match(guidelines, /Pi globals\/@options\/models, images, MCP \(readiness\), or work past these limits/);
  assert.match(guidelines, /A bash or edit call alone stays here/);
  assert.match(guidelines, /Preflight validates, never routes/);
  assert.match(guidelines, /NativeCodemodeRequired means no source ran/);
  assert.match(guidelines, /use native if active, otherwise report it is needed/);
  assert.match(guidelines, /Never automatically replay execution failures; effects are not rolled back/);
  assert.ok(guidelines.includes("For multiline shell/heredoc commands, use JS template literals (backticks), not raw newlines in quoted strings"));
  assert.match(guidelines, /Double backslashes in ordinary templates, not String.raw/);
  assert.match(guidelines, /shell quotes do not protect JS strings/);
  assert.ok(guidelines.includes("Both evaluate ${...}; escape backtick delimiters"));
  assert.ok(guidelines.includes("String.raw retains backslashes used to escape backticks/${...}"));
  assert.equal(tool.exposure, "model-only");
  assert.equal(tool.defaultActive, true);
  assert.ok(tool.promptSnippet && !tool.promptSnippet.includes("\n"));
  for (const description of [tool.description, tool.prepareLoadout({ callable: [] }).descriptions.codemode_o]) {
    assert.match(description, /Prefer codemode_o for short, self-contained programs/);
    assert.match(description, /await tools\.bash\(\{ \.\.\. \}\) and await tools\.edit\(\{ \.\.\. \}\)/);
    assert.match(description, /including bash and edit/);
    assert.match(description, /native codemode directly only if active/);
    assert.match(description, /Never automatically replay after an execution failure/);
  }
});

test("native bash and edit calls run as ordinary host tools", async () => {
  const calls = [];
  const result = await registeredTool().execute("bash-edit", {
    code: 'const listed = await tools.bash({ command: "git status --short" }); await tools.edit({ path: "README.md", edits: [{ oldText: "a", newText: "b" }] }); return listed;',
  }, undefined, undefined, {
    tools: ["bash", "edit"].map((name) => ({ name, parameters: { type: "object" } })),
    async executeTool(name, args) {
      calls.push({ name, args });
      return { result: { content: [{ type: "text", text: name === "bash" ? " M README.md\n" : "edited" }] } };
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.preflight.supported, true);
  assert.equal(JSON.parse(result.content[0].text), " M README.md\n");
  assert.deepEqual(calls, [
    { name: "bash", args: { command: "git status --short" } },
    { name: "edit", args: { path: "README.md", edits: [{ oldText: "a", newText: "b" }] } },
  ]);
});

test("runs a fresh confined program and calls one pi tool", async () => {
  const tool = registeredTool();
  assert.equal(tool.name, "codemode_o");
  assert.equal(tool.exposure, "model-only");

  const plain = await tool.execute("c1", { code: "return 40 + 2" }, undefined, undefined, ctxWith([]));
  assert.equal(plain.isError, undefined);
  assert.equal(plain.content[0].text, "42");

  const calls = [];
  const host = ctxWith([{
    name: "codemode",
    description: "native pi codemode",
    async run() { throw new Error("routed to native codemode"); },
  }, {
    name: "codemode_o",
    description: "must not be exposed",
    async run() { throw new Error("recursive"); },
  }, {
    name: "orders",
    description: "lookup",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(args) {
      calls.push(args);
      return { isError: false, result: { content: [{ type: "text", text: "" }], structuredContent: { id: args.id, total: 17 } } };
    },
  }]);
  const order = await tool.execute("c2", {
    code: "const order = await tools.orders({ id: \"order_42\" }); return order.total;",
  }, undefined, undefined, host);
  assert.equal(order.content[0].text, "17");
  assert.deepEqual(calls, [{ id: "order_42" }]);
  assert.deepEqual(order.details.toolCalls, [{ name: "orders" }]);

  const leaked = await tool.execute("c3", { code: "return leaked" }, undefined, undefined, ctxWith([]));
  assert.equal(leaked.isError, true);
  assert.match(leaked.content[0].text, /Unknown identifier 'leaked'/);

  const imported = await tool.execute("c4", { code: "import fs from \"node:fs\"" }, undefined, undefined, ctxWith([]));
  assert.equal(imported.isError, true);
  assert.match(imported.content[0].text, /^SourceSyntaxError:/);
  assert.equal(imported.details.route.route, "codemode");

  const nested = await tool.execute("c5", {
    code: "return tools.codemode({ code: \"return 1\" })",
  }, undefined, undefined, host);
  assert.equal(nested.isError, true);
  assert.match(nested.content[0].text, /UnknownTool/);
});

test("prepareLoadout lists callable tools and omits itself", () => {
  const tool = registeredTool();
  const changes = tool.prepareLoadout({
    callable: [{ name: "read" }, { name: "codemode" }, { name: "codemode_o" }, { name: "grep" }],
  });
  assert.match(changes.descriptions.codemode_o, /Callable tools: read, grep/);
});
