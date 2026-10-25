import { parse } from "acorn";
import { PREFLIGHT_LIMITS } from "./route.js";

const OPTIONS = { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
const shape = (ast) => JSON.stringify(ast, (key, value) =>
  key === "start" || key === "end" ? undefined : typeof value === "bigint" ? String(value) : value);

// A deliberately small, lossless layout pass, not a JS printer or input repair.
// It changes only whitespace at AST boundaries, keeping literals/comments and
// template interiors verbatim, and verifies the parsed structure afterward.
export function formatSourcePreview(code) {
  if (typeof code !== "string" || Buffer.byteLength(code, "utf8") > PREFLIGHT_LIMITS.maxSourceBytes ||
    code.split(/\r\n|[\r\n\u2028\u2029]/u).length > PREFLIGHT_LIMITS.maxLines) return code;
  try {
    const comments = [];
    const ast = parse(code, { ...OPTIONS, onComment: comments });
    const breaks = new Set();
    const scopes = [];
    const pending = [{ node: ast, depth: 0 }];
    let count = 0;
    while (pending.length) {
      const { node, depth } = pending.pop();
      if (++count > PREFLIGHT_LIMITS.maxNodes || depth > PREFLIGHT_LIMITS.maxDepth) return code;
      // Do not insert whitespace inside template text or interpolations.
      if (node.type === "TemplateLiteral") continue;
      if (node.type === "Program") {
        for (const statement of node.body.slice(1)) breaks.add(statement.start);
      }
      if (node.type === "BlockStatement" && node.body.length) {
        scopes.push({ start: node.start, end: node.end - 1 });
        for (const statement of node.body) breaks.add(statement.start);
        breaks.add(node.end - 1);
      }
      if (node.type === "ArrayExpression" && node.elements.length > 1) {
        scopes.push({ start: node.start, end: node.end - 1 });
        for (const element of node.elements) if (element) breaks.add(element.start);
        breaks.add(node.end - 1);
      }
      for (const value of Object.values(node)) {
        for (const child of Array.isArray(value) ? value : [value]) {
          if (child && typeof child.type === "string") pending.push({ node: child, depth: depth + 1 });
        }
      }
    }
    let formatted = code;
    for (const pos of [...breaks].sort((a, b) => b - a)) {
      let start = pos;
      while (start > 0 && /[ \t\r\n]/u.test(code[start - 1]) &&
        !comments.some((comment) => comment.start <= start - 1 && start - 1 < comment.end)) start--;
      const indent = scopes.filter((scope) => scope.start < pos && pos < scope.end).length;
      formatted = formatted.slice(0, start) + (start ? "\n" : "") + "  ".repeat(indent) + formatted.slice(pos);
    }
    // ASI and comment boundaries must not silently change the displayed meaning.
    return shape(parse(formatted, OPTIONS)) === shape(ast) ? formatted : code;
  } catch {
    // Invalid/incomplete/too-complex input remains visible exactly as supplied.
    return code;
  }
}
