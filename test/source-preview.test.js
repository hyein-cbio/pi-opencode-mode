import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "acorn";
import { formatSourcePreview } from "../source-preview.js";
import { escapedSource, rawNewlineSource } from "./fixtures/preflight-source.js";

const options = { ecmaVersion: "latest", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
function literalsAndComments(code) {
  const raw = [];
  const ast = parse(code, { ...options, onComment: (_block, _text, start, end) => raw.push(code.slice(start, end)) });
  const nodes = [ast];
  while (nodes.length) {
    const node = nodes.pop();
    if (node.type === "Literal" || node.type === "TemplateLiteral") {
      raw.push(code.slice(node.start, node.end));
      continue;
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child.type === "string") nodes.push(child);
      }
    }
  }
  return raw;
}

test("one-line tool batches and loop bodies get structural line breaks", () => {
  const code = 'const results = await Promise.allSettled([tools.read({path:"A",offset:null,limit:null}),tools.read({path:"B"}),tools.bash({command:"not executed"})]); for(let i=0;i<results.length;i++){console.log({source:i,result:results[i]});}';
  const formatted = formatSourcePreview(code);
  assert.equal(formatted, 'const results = await Promise.allSettled([\n  tools.read({path:"A",offset:null,limit:null}),\n  tools.read({path:"B"}),\n  tools.bash({command:"not executed"})\n]);\nfor(let i=0;i<results.length;i++){\n  console.log({source:i,result:results[i]});\n}');
  assert.equal(formatSourcePreview(formatted), formatted, "layout is idempotent");
  assert.equal(code.includes("\n"), false, "input remains the original one-line source");
});

test("heredoc, escapes, regex, Korean and template interiors remain verbatim", () => {
  for (const source of [
    escapedSource,
    'const x = ["한😀\\n", "root / payload << EOF"]; return x;',
    'const x = [/a[,;{}]b/g, "\\\\\\\""]; return x;',
    'const x = [1, `line one\n${[1,2].map(x=>{return x;})}\nline three`]; return x;',
    'const x = [1, /* keep  \n comment */ 2]; // trailing spaces   \nreturn x;',
    'const x = [1, // trailing spaces   \n2]; return x;',
  ]) {
    const formatted = formatSourcePreview(source);
    assert.deepEqual(literalsAndComments(formatted), literalsAndComments(source));
    assert.equal(formatSourcePreview(formatted), formatted);
  }
});

test("invalid, incomplete, oversized and too-deep source fall back without repair", () => {
  for (const code of [rawNewlineSource, 'return "\n";', 'return "\r\n";', 'await tools.read({',
    "return 1;".padEnd(8193), "\n".repeat(100) + "return 1;",
    "return " + "[".repeat(80) + "1" + "]".repeat(80)]) {
    assert.equal(formatSourcePreview(code), code);
  }
});

test("ASI, comments, sparse arrays and nested blocks keep their parsed meaning", () => {
  for (const code of [
    'return\n[1,2];', 'let a=1\na\n++a;',
    'const a=[,1,,2,]; return a;',
    'if(true){for(let i=0;i<2;i++){console.log([i,1]);}}else{throw new Error("x");}',
    'const f=()=>{return {x:1};}; const x=[f(),1];',
    'const x=[1,/*,;{}*/2]; return x;',
    'const x=[1,2]; // keep\nreturn x;',
    'const x=[1n,2n]; return x;',
  ]) {
    const shape = (source) => JSON.stringify(parse(source, options), (key, value) =>
      key === "start" || key === "end" ? undefined : typeof value === "bigint" ? String(value) : value);
    assert.equal(shape(formatSourcePreview(code)), shape(code));
  }
});
