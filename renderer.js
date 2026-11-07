import { highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatSourcePreview } from "./source-preview.js";
import { PREFLIGHT_LIMITS } from "./route.js";

const CODE_PREVIEW_LINES = 10;
const OUTPUT_PREVIEW_LINES = 5;
const CALL_PREVIEW_COUNT = 8;
const CALL_STATES = new Map([
  ["running", ["…", "warning"]], ["ok", ["✓", "success"]],
  ["error", ["✗", "error"]], ["cancelled", ["⊘", "muted"]],
]);

// Match native Pi's row timer: seconds, then minutes/hours for longer runs.
export function formatDuration(ms) {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.floor(seconds);
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor(total / 60) % 60}m ${total % 60}s`;
}

// Use public TUI components; do not import Pi's private renderer/preview modules.
// Cap visual (wrapped) lines so one long JSON line cannot fill the whole screen.
class Preview {
  constructor(text, limit, theme, hint) {
    this.text = new Text(text, 0, 0);
    this.limit = limit;
    this.theme = theme;
    this.hint = hint;
  }
  render(width) {
    const lines = this.text.render(width);
    if (lines.length <= this.limit) return lines;
    const hint = `${this.theme.fg("muted", `... (${lines.length - this.limit} more lines,`)} ${this.hint("app.tools.expand", "to expand")}${this.theme.fg("muted", ")")}`;
    return [...lines.slice(0, this.limit), truncateToWidth(hint, width, "...")];
  }
  invalidate() { this.text.invalidate(); }
}

function outputComponent(text, limit, expanded, theme, hint) {
  return expanded ? new Text(text, 0, 0) : new Preview(text, limit, theme, hint);
}

function finiteDuration(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const same = (left, right) => left?.length === right.length && right.every((value, index) => Object.is(value, left[index]));

// Slot-local, bounded to the current children. Build expensive themed strings
// only when actually rendered; preserve Text's width cache on timer/call updates.
// Pi's theme can be a stable Proxy. invalidate(), not object identity alone,
// must discard embedded ANSI/highlight strings on palette/hot-reload changes.
class CachedContainer extends Container {
  parts = new Map();
  dirty = true;
  update(inputs, build) {
    if (!same(this.inputs, inputs)) this.dirty = true;
    this.inputs = inputs;
    this.build = build;
    return this;
  }
  render(width) {
    if (this.dirty) {
      const used = new Set();
      this.clear();
      this.build((key, inputs, create) => {
        used.add(key);
        let part = this.parts.get(key);
        if (!part || !same(part.inputs, inputs)) {
          part = { inputs, component: create() };
          this.parts.set(key, part);
        }
        this.addChild(part.component);
      });
      for (const key of this.parts.keys()) if (!used.has(key)) this.parts.delete(key);
      this.dirty = false;
    }
    return super.render(width);
  }
  invalidate() {
    this.parts.clear();
    this.dirty = true;
    super.invalidate();
  }
}

// Bound before encoding/scanning oversized or still-streaming source. Expansion
// retains the entire original, unhighlighted, without changing execution args.
function sourcePrefix(code) {
  const max = PREFLIGHT_LIMITS.maxSourceBytes;
  const bytes = Buffer.from(code.slice(0, max + 1), "utf8");
  if (bytes.length <= max && code.length <= max) return code;
  let end = Math.min(bytes.length, max);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

class CallList {
  constructor(calls, expanded, theme, hint) {
    this.calls = calls;
    this.expanded = expanded;
    this.theme = theme;
    this.hint = hint;
  }
  render(width) {
    const { expanded, theme } = this;
    const shown = expanded ? this.calls : this.calls.slice(-CALL_PREVIEW_COUNT);
    const lines = [];
    // Count all retained attempts, including failures hidden by the last-eight
    // preview. Handled failures do not change the script's success semantics.
    const failed = this.calls.filter((call) => call.status === "error").length;
    if (failed) lines.push(truncateToWidth(theme.fg("error", `${failed} failed`), width, "…"));
    if (shown.length < this.calls.length) {
      lines.push(truncateToWidth(theme.fg("muted", `... (${this.calls.length - shown.length} earlier calls, `) +
        this.hint("app.tools.expand", "to expand") + theme.fg("muted", ")"), width, "…"));
    }
    for (const call of shown) {
      const [icon, color] = CALL_STATES.get(call.status) ?? ["?", "muted"];
      const name = String(call.name ?? "unknown").replace(/[\r\n\t]/g, " ");
      const title = theme.fg(color, icon) + " " + theme.fg("toolTitle", name);
      const duration = finiteDuration(call.durationMs) ?
        theme.fg("dim", ` ${call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : formatDuration(call.durationMs)}`) : "";
      let args = typeof call.args === "string" ? call.args : "";
      if (!expanded) args = truncateToWidth(args.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t"),
        Math.max(0, width - visibleWidth(title) - visibleWidth(duration) - 1), "…");
      const line = title + (args ? " " + theme.fg("muted", args) : "") + duration;
      if (expanded) {
        lines.push(...new Text(line, 0, 0).render(width));
        if (typeof call.error === "string" && call.error) {
          lines.push(...new Text(theme.fg("error", "    " + call.error.replace(/\n/g, "\n    ")), 0, 0).render(width));
        }
      } else {
        lines.push(truncateToWidth(line, width, "…"));
      }
    }
    // These rows use foreground colors and intensity only. TUI truncation and
    // wrapping can insert SGR 0, which also erases Pi's outer panel background
    // before the ellipsis, duration and padding. Close just our text styles;
    // leave pending/success/error backgrounds owned by Pi's native shell.
    return lines.map((line) => line.replaceAll("\x1b[0m", "\x1b[22;39m"));
  }
  invalidate() {}
}

// Dependency injection keeps cache/work-count regressions deterministic in tests.
export function createOpenCodeRenderers({ highlightSource = highlightCode, formatSource = formatSourcePreview } = {}) {
  return {
    // Like native Pi, keep its state-colored outer Box.
    renderShell: "default",
    renderCall(args, theme, context) {
      const state = context.state;
      if (context.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
      const component = context.lastComponent instanceof CachedContainer ? context.lastComponent : new CachedContainer();
      const code = args?.code;
      // Older hosts without argsComplete retain the completed-source behavior.
      const streaming = context.argsComplete === false && !context.executionStarted;
      const hint = context.keyHint ?? keyHint;
      let formatted;
      let limited = false;
      if (typeof code === "string") {
        if (state.sourcePreview?.code !== code || state.sourcePreview.streaming !== streaming) {
          const prefix = sourcePrefix(code);
          const oversized = prefix !== code;
          state.sourcePreview = {
            code, streaming, limited: oversized,
            formatted: oversized || streaming ? prefix : formatSource(code),
          };
        }
        ({ formatted, limited } = state.sourcePreview);
      } else {
        delete state.sourcePreview;
      }
      const expanded = context.expanded;
      return component.update([code, formatted, limited, streaming, expanded, theme, hint], (part) => {
        part("title", [typeof code, theme], () => {
          const title = theme.fg("toolTitle", theme.bold("codemode_o")) + theme.fg("muted", " (OpenCode)");
          return new Text(typeof code === "string" ? title : `${title} ${theme.fg("error", "[invalid arg]")}`, 0, 0);
        });
        if (typeof code !== "string" || (!limited && !formatted.trim())) return;
        const changed = !limited && !streaming && formatted !== code;
        const notice = limited ? "Source preview limited; expand for original" :
          streaming ? "Source streaming; formatting when complete" : changed ? "Preview; expand for original" : "";
        if (notice) part("notice", [notice, theme], () => new Text(theme.fg("muted", notice), 0, 0));
        const shown = limited && expanded ? code : formatted;
        part("source", [shown, expanded, theme, hint, streaming, limited], () => {
          const styled = streaming || limited ? shown.replace(/\t/g, "   ") :
            highlightSource(shown.trimEnd().replace(/\t/g, "   "), "javascript").join("\n");
          return outputComponent(styled, CODE_PREVIEW_LINES, expanded, theme, hint);
        });
        if (changed && expanded) {
          part("spacer", [], () => new Spacer(1));
          part("originalLabel", [theme], () => new Text(theme.fg("muted", "Original source (execution and error locations)"), 0, 0));
          part("original", [code, theme], () => new Text(highlightSource(code.trimEnd().replace(/\t/g, "   "), "javascript").join("\n"), 0, 0));
        }
      });
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const component = context.lastComponent instanceof CachedContainer ? context.lastComponent : new CachedContainer();
      const hint = context.keyHint ?? keyHint;
      // Snapshot displayed fields: hooks may mutate an existing details object.
      // No host result bodies enter the call-list cache.
      const calls = (Array.isArray(result.details?.calls) ? result.details.calls : [])
        .filter((call) => call && typeof call === "object")
        .map(({ name, args, status, durationMs, error }) => ({ name, args, status, durationMs, error }));
      const callInputs = calls.flatMap((call) => [call.name, call.args, call.status, call.durationMs, call.error]);
      // Legacy/hook-replaced content remains authoritative. Never reconstruct
      // model-visible output from diagnostics, or clip it for a display cache.
      const output = isPartial ? "" : (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
      const warnings = result.details?.warnings?.length ?? 0;
      const truncated = result.details?.truncated;
      const color = context.isError || result.details?.ok === false ? "error" : "toolOutput";
      const duration = finiteDuration(context.durationMs) ? context.durationMs : result.details?.durationMs;
      let timer;
      if (!isPartial && finiteDuration(duration)) timer = `Took ${formatDuration(duration)}`;
      else if (isPartial && context.state.startedAt !== undefined) timer = `Elapsed ${formatDuration(Date.now() - context.state.startedAt)}`;
      return component.update([expanded, isPartial, theme, hint, output, warnings, truncated, color, timer, ...callInputs], (part) => {
        if (calls.length) {
          part("callSpacer", [], () => new Spacer(1));
          part("calls", [expanded, theme, hint, ...callInputs], () => new CallList(calls, expanded, theme, hint));
        }
        if (!isPartial) {
          const notices = [];
          if (warnings) notices.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
          if (truncated) notices.push("Output truncated; incomplete preview");
          if (notices.length) {
            part("noticeSpacer", [], () => new Spacer(1));
            part("notice", [notices.join(" · "), theme], () => new Text(theme.fg("warning", notices.join(" · ")), 0, 0));
          }
          if (output.length > 0) {
            part("outputSpacer", [], () => new Spacer(1));
            part("output", [output, color, expanded, theme, hint], () => {
              const styled = output.replace(/\t/g, "   ").split("\n").map((line) => theme.fg(color, line)).join("\n");
              return outputComponent(styled, OUTPUT_PREVIEW_LINES, expanded, theme, hint);
            });
          }
        }
        if (timer) {
          part("timerSpacer", [], () => new Spacer(1));
          part("timer", [timer, theme], () => new Text(theme.fg("muted", timer), 0, 0));
        }
      });
    },
  };
}

export const openCodeRenderers = createOpenCodeRenderers();
