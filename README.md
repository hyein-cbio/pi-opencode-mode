# pi-opencode-mode

Pi extension that registers `codemode_o` with OpenCode CodeMode v2 (`@opencode/codemode` 2.1.0). Pi's built-in `codemode` stays in place. A program calls pi tools that are already callable:

```js
const text = await tools.read({ path: "README.md" });
return text.length;
```

`route.js` is a TODO scaffold for choosing `codemode` or `codemode_o` before execution. The extension does not call it, so a `codemode_o` call runs OpenCode directly. There is no QuickJS path, store, model catalog, or Luau runtime in this package.

Load it from this directory with `pi -e /path/to/pi-opencode-mode`.

`@earendil-works/pi-coding-agent` >= 0.99.0 is the peer dependency. 0.99.0 is the first release whose tool context can call other tools and whose built-in `codemode` exists. The loader also accepts this file on 0.87.1, and a program that does not call tools can return a value there, but that SDK has no `executeTool` context and no built-in `codemode`.
