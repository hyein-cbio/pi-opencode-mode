// TODO: Before execution, choose Pi's built-in `codemode` or OpenCode `codemode_o`.
// Use codemode_o only for a short program in the OpenCode subset. Otherwise stay on native Pi codemode.
// This scaffold does not inspect source, call a tool, or change the extension's execute path.

export const ROUTE_TOOLS = Object.freeze(["codemode", "codemode_o"]);

export function selectCodemodeRoute() {
  return Object.freeze({
    decision: "unrouted",
    route: null,
    reasons: Object.freeze(["todo-routing-disabled"]),
    executesSource: false,
  });
}
