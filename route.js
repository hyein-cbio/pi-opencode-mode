import { parse } from "acorn";

export const ROUTE_TOOLS = Object.freeze(["codemode", "codemode_o"]);
// Routing limits, not execution/output limits. Longer or uncertain programs stay native.
export const ROUTE_LIMITS = Object.freeze({ maxSourceBytes: 8192, maxLines: 100, maxNodes: 2000, maxDepth: 64 });

// Intentionally narrower than the interpreter. Unknown/new syntax stays on Pi;
// this is a static compatibility heuristic, not a semantic proof or authorization gate.
const SYNTAX = new Set([
  "Program", "ExpressionStatement", "EmptyStatement", "BlockStatement", "ReturnStatement",
  "VariableDeclaration", "VariableDeclarator", "IfStatement", "ForStatement", "ForOfStatement",
  "WhileStatement", "DoWhileStatement", "BreakStatement", "ContinueStatement", "ThrowStatement",
  "TryStatement", "CatchClause", "Identifier", "Literal", "ArrayExpression", "ObjectExpression",
  "Property", "SpreadElement", "RestElement", "ArrayPattern", "ObjectPattern", "AssignmentPattern",
  "BinaryExpression", "LogicalExpression", "UnaryExpression", "UpdateExpression", "AssignmentExpression",
  "ConditionalExpression", "SequenceExpression", "CallExpression", "MemberExpression", "ChainExpression",
  "AwaitExpression", "ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration",
  "NewExpression", "TemplateLiteral", "TemplateElement",
]);
const NATIVE_NAMES = new Set([
  "text", "image", "exit", "store", "load", "ALL_TOOLS", "searchTools", "describeTool",
  "describeNamespace", "models", "globalThis", "eval", "Function", "BigInt", "Proxy", "Reflect",
]);
const CONSTRUCTORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError"]);

function selected(route, reason) {
  return Object.freeze({
    decision: "selected", route, reasons: Object.freeze([reason]), executesSource: false,
  });
}

// Noncomputed property names are data, not globals; shorthand properties still read a binding.
function propertyName(node, parent, key) {
  return (parent?.type === "MemberExpression" && key === "property" && !parent.computed) ||
    (parent?.type === "Property" && key === "key" && !parent.computed && !parent.shorthand);
}

/** Pure preflight: never evaluates source, calls a tool, or retries a program. */
export function selectCodemodeRoute({ code, requested = "auto" } = {}) {
  const native = (reason) => selected("codemode", reason);
  if (requested === "codemode") return native("native-requested");
  if (requested !== "auto" && requested !== "codemode_o") return native("unknown-request");
  if (typeof code !== "string") return native("empty-source");
  if (code.length > ROUTE_LIMITS.maxSourceBytes || Buffer.byteLength(code, "utf8") > ROUTE_LIMITS.maxSourceBytes) {
    return native("source-too-large");
  }
  if (!code.trim()) return native("empty-source");
  if (code.split(/\r\n|[\n\r\u2028\u2029]/u).length > ROUTE_LIMITS.maxLines) return native("too-many-lines");

  let ast;
  let options = false;
  try {
    ast = parse(code, {
      ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
      onComment(_block, text) { if (/^\s*@options\s*:/u.test(text)) options = true; },
    });
  } catch {
    return native("parse-uncertain");
  }
  if (options) return native("pi-options");
  if (!ast.body.some((node) => node.type !== "EmptyStatement")) return native("empty-source");

  const pending = [{ node: ast, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, parent, key, depth } = pending.pop();
    if (++count > ROUTE_LIMITS.maxNodes || depth > ROUTE_LIMITS.maxDepth) return native("source-too-complex");
    if (!SYNTAX.has(node.type)) return native(`unsupported-syntax:${node.type}`);
    if (node.type === "Literal" && (node.regex || node.bigint !== undefined)) return native("unsupported-literal");
    if (node.generator || (node.type === "Property" && node.kind !== "init")) return native("unsupported-function");
    if (node.type === "NewExpression" && (node.callee.type !== "Identifier" || !CONSTRUCTORS.has(node.callee.name))) {
      return native("uncertain-constructor");
    }
    // Even shadowed Pi names conservatively stay native. No fragile regex scan of source.
    if (node.type === "Identifier" && NATIVE_NAMES.has(node.name) && !propertyName(node, parent, key)) {
      return native(`native-name:${node.name}`);
    }
    for (const [key, value] of Object.entries(node)) {
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (child && typeof child === "object" && typeof child.type === "string") {
          pending.push({ node: child, parent: node, key, depth: depth + 1 });
        }
      }
    }
  }
  return selected("codemode_o", "short-opencode-subset");
}
