import { highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

const CODE_PREVIEW_LINES = 10;
const OUTPUT_PREVIEW_LINES = 5;

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
  constructor(text, limit, theme) {
    this.text = new Text(text, 0, 0);
    this.limit = limit;
    this.theme = theme;
  }
  render(width) {
    const lines = this.text.render(width);
    if (lines.length <= this.limit) return lines;
    const hint = `${this.theme.fg("muted", `... (${lines.length - this.limit} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${this.theme.fg("muted", ")")}`;
    return [...lines.slice(0, this.limit), truncateToWidth(hint, width, "...")];
  }
  invalidate() { this.text.invalidate(); }
}

function outputComponent(text, limit, expanded, theme) {
  return expanded ? new Text(text, 0, 0) : new Preview(text, limit, theme);
}

function finiteDuration(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export const openCodeRenderers = {
  renderCall(args, theme, context) {
    const state = context.state;
    if (context.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
    const component = context.lastComponent ?? new Container();
    component.clear();
    const title = theme.fg("toolTitle", theme.bold("codemode_o")) + theme.fg("muted", " (OpenCode)");
    const code = args?.code;
    component.addChild(new Text(typeof code === "string" ? title : `${title} ${theme.fg("error", "[invalid arg]")}`, 0, 0));
    if (typeof code === "string" && code.trim()) {
      const normalized = code.replace(/\r/g, "").trimEnd().replace(/\t/g, "   ");
      const highlighted = highlightCode(normalized, "javascript").join("\n");
      component.addChild(outputComponent(highlighted, CODE_PREVIEW_LINES, context.expanded, theme));
    }
    return component;
  },
  renderResult(result, { expanded, isPartial }, theme, context) {
    const component = context.lastComponent ?? new Container();
    component.clear();
    if (!isPartial) {
      // Old sessions and hook-replaced results may not have our details. Render
      // their content as-is; never reconstruct output from diagnostic metadata.
      const output = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
      const notices = [];
      const warnings = result.details?.warnings?.length ?? 0;
      if (warnings) notices.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
      if (result.details?.truncated) notices.push("Output truncated; incomplete preview");
      if (notices.length) {
        component.addChild(new Spacer(1));
        component.addChild(new Text(theme.fg("warning", notices.join(" · ")), 0, 0));
      }
      if (output) {
        const color = context.isError || result.details?.ok === false ? "error" : "toolOutput";
        const styled = output.replace(/\t/g, "   ").split("\n").map((line) => theme.fg(color, line)).join("\n");
        component.addChild(new Spacer(1));
        component.addChild(outputComponent(styled, OUTPUT_PREVIEW_LINES, expanded, theme));
      }
    }
    // Pi's recorded duration includes its hooks; our monotonic duration is the
    // fallback for older SDKs and restored results. Both include host cleanup.
    const duration = finiteDuration(context.durationMs) ? context.durationMs : result.details?.durationMs;
    let timer;
    if (!isPartial && finiteDuration(duration)) {
      timer = `Took ${formatDuration(duration)}`;
    } else if (isPartial && context.state.startedAt !== undefined) {
      timer = `Elapsed ${formatDuration(Date.now() - context.state.startedAt)}`;
    }
    if (timer) {
      component.addChild(new Spacer(1));
      component.addChild(new Text(theme.fg("muted", timer), 0, 0));
    }
    return component;
  },
};
