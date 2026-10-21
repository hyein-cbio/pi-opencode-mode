import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ROUTE_TOOLS, selectCodemodeRoute } from "../route.js";

test("routing scaffold selects nothing and is not used by execution", () => {
  assert.deepEqual(ROUTE_TOOLS, ["codemode", "codemode_o"]);
  assert.deepEqual(selectCodemodeRoute({ requested: "codemode_o", code: "return 1" }), {
    decision: "unrouted",
    route: null,
    reasons: ["todo-routing-disabled"],
    executesSource: false,
  });
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.equal(source.includes("selectCodemodeRoute"), false);
  assert.equal(source.includes("from \"./route.js\""), false);
});
