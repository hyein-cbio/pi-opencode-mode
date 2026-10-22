import { CodeMode, Tool, toolError } from "@opencode/codemode";
import { Effect } from "effect";
import { Type } from "typebox";

const TOOL_NAME = "codemode_o";
// Pi's built-in `codemode` stays registered. Guest programs cannot call either code tool.
const HIDDEN_FROM_GUEST = new Set(["codemode", TOOL_NAME]);
// TODO: route.js may later choose between those tools. execute() does not call it.
const LIMITS = { timeoutMs: 30_000, maxToolCalls: 64, maxOutputBytes: 65_536 };
const BASE = [
  "Confined OpenCode CodeMode v2, not Pi's QuickJS codemode.",
  "Write a JavaScript-like program. Use return, or a final expression. undefined becomes null.",
  "Call pi tools that are already callable as await tools.<name>({ ... }).",
  "No import, process, require, eval, Function, filesystem, network, or timers except through those tools.",
  `Each run is fresh. Limits: ${LIMITS.timeoutMs}ms before interruption (host cleanup is awaited), ${LIMITS.maxToolCalls} tool calls, ${LIMITS.maxOutputBytes} final UTF-8 text bytes including logs and diagnostics.`,
  "Warnings and truncation are visible; truncated data is a preview, not complete JSON. Host cancellation requires cooperative tools.",
].join(" ");

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function textOf(result) {
  const parts = [];
  for (const block of result?.content ?? []) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

async function callPiTool(ctx, name, input, signal) {
  signal?.throwIfAborted();
  if (typeof ctx?.executeTool !== "function") {
    throw new Error("This pi context cannot call tools from codemode");
  }
  const outcome = await ctx.executeTool(name, input ?? {}, { signal });
  if (outcome?.isError) throw new Error(textOf(outcome.result) || `Tool failed: ${name}`);
  if (outcome?.result?.structuredContent !== undefined) return outcome.result.structuredContent;
  const blocks = outcome?.result?.content ?? [];
  if (blocks.some((block) => block?.type && block.type !== "text")) {
    throw new Error(`Non-text result from ${name} is not supported`);
  }
  return textOf(outcome?.result);
}

function codeModeTools(ctx, signal) {
  const tools = {};
  for (const tool of ctx?.tools ?? []) {
    const name = tool?.name;
    if (typeof name !== "string" || name.length === 0 || HIDDEN_FROM_GUEST.has(name)) continue;
    tools[name] = Tool.make({
      description: typeof tool.description === "string" && tool.description ? tool.description : name,
      input: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object" },
      output: { description: "JSON value" },
      execute: (input) => {
        let pending;
        return Effect.ensuring(Effect.tryPromise({
          try: (interruption) => {
            const combined = signal ? AbortSignal.any([signal, interruption]) : interruption;
            pending = callPiTool(ctx, name, input, combined);
            return pending;
          },
          catch: (error) => toolError(message(error)),
        }), Effect.promise(async () => {
          // tryPromise interrupts immediately. Drain host cleanup too, so Pi's
          // permission/result hooks and nested-call audit finish before the root.
          await pending?.catch(() => {});
        }));
      },
    });
  }
  return tools;
}

// Bound before encoding arbitrary diagnostics; never allocate a buffer for an
// unbounded host error. Cut only at UTF-8 boundaries (including astral text).
function prefix(text, maxBytes) {
  const bytes = Buffer.from(text.slice(0, maxBytes + 1), "utf8");
  let end = Math.min(bytes.length, maxBytes);
  if (end < bytes.length) {
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function diagnostics(result) {
  const budget = 8192;
  let used = 0;
  let truncated = false;
  function bound(diagnostic) {
    const kind = prefix(diagnostic.kind, 64);
    const message = prefix(diagnostic.message, 1024);
    const suggestions = diagnostic.suggestions?.slice(0, 3).map((text) => prefix(text, 128));
    truncated ||= kind !== diagnostic.kind || message !== diagnostic.message ||
      (diagnostic.suggestions !== undefined && (diagnostic.suggestions.length > 3 ||
        suggestions.some((text, index) => text !== diagnostic.suggestions[index])));
    return { kind, message, ...(diagnostic.location ? { location: diagnostic.location } : {}), ...(suggestions ? { suggestions } : {}) };
  }
  const error = result.ok ? undefined : bound(result.error);
  used += error ? Buffer.byteLength(JSON.stringify(error)) : 0;
  const warnings = [];
  const original = result.warnings ?? [];
  for (const warning of original) {
    const kept = bound(warning);
    const size = Buffer.byteLength(JSON.stringify(kept)) + 1;
    if (used + size > budget - 256) break;
    used += size;
    warnings.push(kept);
  }
  truncated ||= warnings.length < original.length;
  if (truncated) warnings.push({ kind: "Truncated", message: "Diagnostic text or additional warnings truncated by the diagnostic limit." });
  return { error, warnings, truncated };
}

function renderResult(result) {
  const diagnostic = diagnostics(result);
  // Diagnostics precede data: full-size values/logs cannot hide warnings or errors.
  const notices = [
    ...(diagnostic.error ? [`${diagnostic.error.kind}: ${diagnostic.error.message}\n`] : []),
    ...diagnostic.warnings.map((warning) => `Warning ${warning.kind}: ${warning.message}\n`),
  ].join("");
  // Upstream has already bounded value/log data. JSON escaping can expand that
  // bounded input (at most 6x); apply the final guard AFTER this encoding.
  const body = [...(result.logs ?? []), ...(result.ok ? [JSON.stringify(result.value) ?? "null"] : [])].join("\n");
  const truncated = result.truncated === true || diagnostic.truncated ||
    Buffer.byteLength(notices) + Buffer.byteLength(body) > LIMITS.maxOutputBytes;
  const header = notices + (truncated ? "[Output truncated; data below is a preview, not a complete JSON value.]\n" : "");
  const text = header + prefix(body, LIMITS.maxOutputBytes - Buffer.byteLength(header));
  return {
    content: [{ type: "text", text }],
    details: {
      ok: result.ok, toolCalls: result.toolCalls,
      ...(diagnostic.error ? { error: diagnostic.error } : {}),
      ...(diagnostic.warnings.length ? { warnings: diagnostic.warnings } : {}),
      ...(truncated ? { truncated: true } : {}),
    },
    ...(result.ok ? {} : { isError: true }),
  };
}

export function createOpenCodeModeExtension() {
  return function openCodeModeExtension(pi) {
    pi.registerTool({
      name: TOOL_NAME,
      label: "codemode_o (OpenCode)",
      description: BASE,
      promptSnippet: "Run confined OpenCode CodeMode that calls other pi tools",
      promptGuidelines: [
        "Use codemode_o for a short confined OpenCode CodeMode program. Pi's built-in codemode remains available and is not selected here.",
      ],
      parameters: Type.Object({
        code: Type.String({ description: "OpenCode CodeMode source." }),
      }),
      exposure: "model-only",
      defaultActive: true,
      prepareLoadout(loadout) {
        const names = [];
        for (const tool of loadout?.callable ?? []) {
          if (typeof tool?.name === "string" && !HIDDEN_FROM_GUEST.has(tool.name)) names.push(tool.name);
        }
        return { descriptions: { [TOOL_NAME]: `${BASE}\nCallable tools: ${names.join(", ") || "(none)"}` } };
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const code = typeof params?.code === "string" ? params.code : "";
        try {
          const runtime = CodeMode.make({ tools: codeModeTools(ctx, signal), limits: LIMITS });
          const result = await Effect.runPromise(runtime.execute(code), signal ? { signal } : undefined);
          return renderResult(result);
        } catch (error) {
          return renderResult({
            ok: false,
            error: { kind: "ExecutionFailure", message: signal?.aborted ? "Script interrupted" : message(error) },
            toolCalls: [],
          });
        }
      },
    });
  };
}

export default createOpenCodeModeExtension();
