import { getLineInfo, parse } from "acorn";

export const ROUTE_TOOLS = Object.freeze(["codemode", "codemode_o"]);
// Compatibility limits, not a tool-selection policy or execution/output limits.
export const PREFLIGHT_LIMITS = Object.freeze({ maxSourceBytes: 8192, maxLines: 100, maxNodes: 2000, maxDepth: 64 });
// Retained for consumers of the original pure helper.
export const ROUTE_LIMITS = PREFLIGHT_LIMITS;

// Intentionally narrower than the interpreter. Unknown/new syntax is rejected;
// this is a static compatibility check, not routing, semantic proof, or authorization.
// Keep for...in out: CodeMode 2.1.4 skips inherited keys and visits deleted keys.
const SYNTAX = new Set([
  "Program", "ExpressionStatement", "EmptyStatement", "BlockStatement", "ReturnStatement",
  "VariableDeclaration", "VariableDeclarator", "IfStatement", "ForStatement", "ForOfStatement",
  "WhileStatement", "DoWhileStatement", "BreakStatement", "ContinueStatement", "ThrowStatement",
  "SwitchStatement", "SwitchCase",
  "TryStatement", "CatchClause", "Identifier", "Literal", "ArrayExpression", "ObjectExpression",
  "Property", "SpreadElement", "RestElement", "ArrayPattern", "ObjectPattern", "AssignmentPattern",
  "BinaryExpression", "LogicalExpression", "UnaryExpression", "UpdateExpression", "AssignmentExpression",
  "ConditionalExpression", "SequenceExpression", "CallExpression", "MemberExpression", "ChainExpression",
  "AwaitExpression", "ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration",
  "NewExpression", "TemplateLiteral", "TemplateElement", "TaggedTemplateExpression",
]);
const NATIVE_NAMES = new Set([
  "text", "image", "exit", "store", "load", "ALL_TOOLS", "searchTools", "describeTool",
  "describeNamespace", "models", "globalThis", "eval", "Function", "BigInt", "Proxy", "Reflect",
]);
const CONSTRUCTORS = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError",
  "Date", "RegExp", "Map", "Set", "URL",
]);

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

function parserDiagnostic(error, code) {
  const offset = (value) => Number.isInteger(value) && value >= 0 && value <= code.length;
  // Acorn source errors carry a valid source offset. A bare SyntaxError from
  // inside the parser is not enough evidence to blame the input.
  const syntax = error instanceof SyntaxError && offset(error.pos);
  const original = typeof error?.message === "string" ? error.message :
    typeof error === "string" ? error : "Parser failed without a message";
  // Bound before retaining diagnostics. 128 Unicode code points use at most
  // 512 UTF-8 bytes, leaving room for location and recovery guidance later.
  const clipped = Array.from(original.slice(0, 1024)).slice(0, 128).join("");
  const message = clipped + (clipped.length < original.length ? "… [parser message truncated]" : "");
  const location = (value) => {
    const { line, column } = getLineInfo(code, value);
    return Object.freeze({ line, column });
  };
  return Object.freeze({
    kind: syntax ? "SourceSyntaxError" : "PreflightParserError",
    message, parser: "acorn", sourceType: "script",
    ...(offset(error?.pos) ? { pos: error.pos, location: location(error.pos) } : {}),
    ...(offset(error?.raisedAt) ? { raisedAt: error.raisedAt, detectedLocation: location(error.raisedAt) } : {}),
    ...(syntax && original.startsWith("Unterminated string constant") &&
      offset(error.raisedAt) && /[\r\n]/u.test(code.charAt(error.raisedAt)) ? {
        hint: "Escape newlines inside quoted JS strings as \\n (\\\\n inside a JSON code string).",
      } : {}),
  });
}

/** Checks only compatibility; never executes source or selects a tool.
 * The optional parser dependency supports offline failure injection; tool input cannot set it.
 */
export function checkOpenCodeCompatibility(code, parseSource = parse) {
  const rejected = (reason, diagnostic) => Object.freeze({
    supported: false, reasons: Object.freeze([reason]), executesSource: false,
    ...(diagnostic ? { diagnostic } : {}),
  });
  if (typeof code !== "string") return rejected("empty-source");
  if (code.length > PREFLIGHT_LIMITS.maxSourceBytes || Buffer.byteLength(code, "utf8") > PREFLIGHT_LIMITS.maxSourceBytes) {
    return rejected("source-too-large");
  }
  if (!code.trim()) return rejected("empty-source");
  if (code.split(/\r\n|[\n\r\u2028\u2029]/u).length > PREFLIGHT_LIMITS.maxLines) return rejected("too-many-lines");

  let ast;
  let options = false;
  try {
    ast = parseSource(code, {
      ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
      onComment(_block, text) { if (/^\s*@options\s*:/u.test(text)) options = true; },
    });
  } catch (error) {
    const diagnostic = parserDiagnostic(error, code);
    return rejected(diagnostic.kind === "SourceSyntaxError" ? "invalid-script-syntax" : "internal-parser-error", diagnostic);
  }
  if (options) return rejected("pi-options");
  if (!ast.body.some((node) => node.type !== "EmptyStatement")) return rejected("empty-source");

  const pending = [{ node: ast, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, parent, key, depth } = pending.pop();
    if (++count > PREFLIGHT_LIMITS.maxNodes || depth > PREFLIGHT_LIMITS.maxDepth) return rejected("source-too-complex");
    if (!SYNTAX.has(node.type)) return rejected(`unsupported-syntax:${node.type}`);
    // Admit only the verified String.raw tag, not arbitrary tagged calls. Walk
    // its substitutions normally: raw text does not make interpolation inert.
    if (node.type === "TaggedTemplateExpression" && !(
      node.tag.type === "MemberExpression" && !node.tag.computed &&
      node.tag.object.type === "Identifier" && node.tag.object.name === "String" &&
      node.tag.property.type === "Identifier" && node.tag.property.name === "raw"
    )) return rejected("unsupported-syntax:TaggedTemplateExpression");
    // OpenCode supports regex literals; Acorn has already validated their syntax.
    // Keep BigInt outside our compatibility subset.
    if (node.type === "Literal" && node.bigint !== undefined) return rejected("unsupported-literal");
    if (node.generator || (node.type === "Property" && node.kind !== "init")) return rejected("unsupported-function");
    if (node.type === "NewExpression" && (node.callee.type !== "Identifier" || !CONSTRUCTORS.has(node.callee.name))) {
      return rejected("uncertain-constructor");
    }
    // Even shadowed Pi names are conservatively rejected. No fragile regex scan of source.
    if (node.type === "Identifier" && NATIVE_NAMES.has(node.name) && !propertyName(node, parent, key)) {
      return rejected(`native-name:${node.name}`);
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
  return Object.freeze({
    supported: true, reasons: Object.freeze(["short-opencode-subset"]), executesSource: false,
  });
}

/**
 * @deprecated Historical advisory API only; not used by the extension execution path.
 * Tool selection belongs to the LLM's context, not this static compatibility check.
 */
export function selectCodemodeRoute({ code, requested = "auto" } = {}) {
  if (requested === "codemode") return selected("codemode", "native-requested");
  if (requested !== "auto" && requested !== "codemode_o") return selected("codemode", "unknown-request");
  const result = checkOpenCodeCompatibility(code);
  return selected(result.supported ? "codemode_o" : "codemode", result.reasons[0]);
}
