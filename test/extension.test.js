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
  assert.equal(pkg.dependencies["@opencode/codemode"], "2.1.4");
});

test("registration supplies conditional preference without routing or prompt hooks", () => {
  // This stub deliberately provides no lifecycle or activation APIs.
  const tool = registeredTool();
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bselectCodemodeRoute\b/, "execution must not use the legacy selector");
  const guidelines = tool.promptGuidelines.join("\n");
  assert.ok(guidelines.length <= 600, "keep model guidance concise");
  assert.match(guidelines, /Choose from task context/);
  assert.match(guidelines, /Prefer codemode_o for short, self-contained programs within its syntax\/limits/);
  assert.match(guidelines, /Call either tool directly \(model-only\)/);
  assert.match(guidelines, /Use native codemode upfront/);
  assert.match(guidelines, /Pi globals\/@options\/models, images, MCP \(readiness\), long-running work, or uncertain compatibility/);
  assert.match(guidelines, /Preflight validates, never routes/);
  assert.match(guidelines, /NativeCodemodeRequired means no source ran/);
  assert.match(guidelines, /use native if active, otherwise report it is needed/);
  assert.match(guidelines, /Never automatically replay execution failures; effects are not rolled back/);
  assert.equal(tool.exposure, "model-only");
  assert.equal(tool.defaultActive, true);
  assert.ok(tool.promptSnippet && !tool.promptSnippet.includes("\n"));
  for (const description of [tool.description, tool.prepareLoadout({ callable: [] }).descriptions.codemode_o]) {
    assert.match(description, /Prefer codemode_o for short, self-contained programs/);
    assert.match(description, /native codemode directly only if active/);
    assert.match(description, /Never automatically replay after an execution failure/);
  }
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
