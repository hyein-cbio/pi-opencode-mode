import { CodeMode, Tool, toolError } from "@opencode/codemode";
import { Effect } from "effect";
import { Type } from "typebox";

const TOOL_NAME = "codemode";
const LIMITS = { timeoutMs: 30_000, maxToolCalls: 64, maxOutputBytes: 65_536 };
const BASE = [
  "Confined OpenCode CodeMode v2, not Pi's QuickJS codemode.",
  "Write a JavaScript-like program. Use return, or a final expression. undefined becomes null.",
  "Call pi tools that are already callable as await tools.<name>({ ... }).",
  "No import, process, require, eval, Function, filesystem, network, or timers except through those tools.",
  `Each run is fresh. Limits: ${LIMITS.timeoutMs}ms, ${LIMITS.maxToolCalls} tool calls, ${LIMITS.maxOutputBytes} output bytes.`,
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
    if (typeof name !== "string" || name.length === 0 || name === TOOL_NAME) continue;
    tools[name] = Tool.make({
      description: typeof tool.description === "string" && tool.description ? tool.description : name,
      input: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object" },
      output: { description: "JSON value" },
      execute: (input) => Effect.tryPromise({
        try: () => callPiTool(ctx, name, input, signal),
        catch: (error) => toolError(message(error)),
      }),
    });
  }
  return tools;
}

export function createOpenCodeModeExtension() {
  return function openCodeModeExtension(pi) {
    pi.registerTool({
      name: TOOL_NAME,
      label: "codemode (OpenCode)",
      description: BASE,
      promptSnippet: "Run confined OpenCode CodeMode that calls other pi tools",
      promptGuidelines: [
        "Use codemode to compute or to chain already callable pi tools inside one confined OpenCode CodeMode program.",
      ],
      parameters: Type.Object({
        code: Type.String({ description: "OpenCode CodeMode source." }),
      }),
      exposure: "model-only",
      defaultActive: true,
      prepareLoadout(loadout) {
        const names = [];
        for (const tool of loadout?.callable ?? []) {
          if (typeof tool?.name === "string" && tool.name !== TOOL_NAME) names.push(tool.name);
        }
        return { descriptions: { [TOOL_NAME]: `${BASE}\nCallable tools: ${names.join(", ") || "(none)"}` } };
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const code = typeof params?.code === "string" ? params.code : "";
        try {
          const runtime = CodeMode.make({ tools: codeModeTools(ctx, signal), limits: LIMITS });
          const result = await Effect.runPromise(runtime.execute(code), signal ? { signal } : undefined);
          const text = result.ok
            ? JSON.stringify(result.value)
            : `${result.error.kind}: ${result.error.message}`;
          const logs = result.logs?.length ? `${result.logs.join("\n")}\n` : "";
          return {
            content: [{ type: "text", text: logs + text }],
            details: { ok: result.ok, toolCalls: result.toolCalls, ...(result.ok ? {} : { error: result.error }) },
            ...(result.ok ? {} : { isError: true }),
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: signal?.aborted ? "Script interrupted" : message(error) }],
            details: { ok: false },
            isError: true,
          };
        }
      },
    });
  };
}

export default createOpenCodeModeExtension();
