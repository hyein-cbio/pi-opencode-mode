# pi-opencode-mode

Pi extension that registers `codemode` with OpenCode CodeMode v2 (`@opencode/codemode` 2.1.0). A program calls pi tools that are already callable:

```js
const text = await tools.read({ path: "README.md" });
return text.length;
```

Pi omits its replaceable built-in `codemode` when this extension registers the same tool name. There is no QuickJS path, store, model catalog, or Luau runtime here.

Load it from this directory with `pi -e /path/to/pi-opencode-mode`.

`@earendil-works/pi-coding-agent` >= 0.99.0 is the peer dependency. 0.99.0 is the first release whose tool context can call other tools and whose replaceable built-in `codemode` exists. The loader also accepts this file on 0.87.1, and a program that does not call tools can return a value there, but that SDK has no `executeTool` context and no built-in codemode to replace.
