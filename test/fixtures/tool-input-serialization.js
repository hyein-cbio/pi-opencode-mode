// Programs used against both the Pi bridge and the public upstream runtime.
// An empty input object is valid for this inert mock, so silent changes are observable.
export const customToJSONCases = [
  {
    name: "method-only input",
    code: 'return await tools.read({ toJSON() { return { path: "README.md" }; } });',
    legacy: { args: { path: "README.md" } },
    dropsMethods: { args: {} },
  },
  {
    name: "replacement of an existing field",
    code: 'return await tools.read({ path: "wrong", toJSON() { return { path: "README.md" }; } });',
    legacy: { args: { path: "README.md" } },
    dropsMethods: { args: { path: "wrong" } },
  },
  {
    name: "nested object, array, key and invocation count",
    code: `
      let count = 0;
      const option = { mode: "wrong", toJSON(key) { return { mode: "recursive", key, count: ++count }; } };
      await tools.read({ path: "README.md", options: option, array: [option] });
      return count;
    `,
    legacy: { value: 2, args: {
      path: "README.md", options: { mode: "recursive", key: "options", count: 1 },
      array: [{ mode: "recursive", key: "0", count: 2 }],
    } },
    dropsMethods: { value: 0, args: { path: "README.md", options: { mode: "wrong" }, array: [{ mode: "wrong" }] } },
  },
  {
    name: "original receiver (raw VM only; Pi preflight rejects this)",
    rawOnly: true,
    code: `
      let count = 0;
      const option = { mode: "wrong", toJSON(key) {
        return { mode: this === option && this.mode === "wrong" ? "recursive" : "bad receiver", key, count: ++count };
      } };
      await tools.read({ path: "README.md", options: option, array: [option] });
      return count;
    `,
    legacy: { value: 2, args: {
      path: "README.md", options: { mode: "recursive", key: "options", count: 1 },
      array: [{ mode: "recursive", key: "0", count: 2 }],
    } },
    dropsMethods: { value: 0, args: { path: "README.md", options: { mode: "wrong" }, array: [{ mode: "wrong" }] } },
  },
  {
    name: "empty replacement",
    code: 'return await tools.read({ path: "wrong", toJSON() { return {}; } });',
    legacy: { args: {} },
    dropsMethods: { args: { path: "wrong" } },
  },
  {
    name: "exception during serialization",
    code: 'return await tools.read({ path: "wrong", toJSON() { throw new Error("serialize failed"); } });',
    legacy: { error: { kind: "ExecutionFailure", message: /serialize failed/ } },
    dropsMethods: { args: { path: "wrong" } },
  },
];

export const commonInputCases = [
  {
    name: "function fields are omitted; array slots become null",
    code: 'return await tools.read({ path: "README.md", skip() {}, list: [() => 1] });',
    args: { path: "README.md", list: [null] },
  },
  {
    name: "nested promises are awaited",
    code: 'return await tools.read({ list: [Promise.resolve(3)], options: { n: Promise.resolve(4) } });',
    args: { list: [3], options: { n: 4 } },
  },
  {
    name: "rejected promise precludes dispatch",
    code: 'return await tools.read({ n: Promise.reject(new Error("rejected argument")) });',
    error: { kind: "ExecutionFailure", message: /rejected argument/ },
  },
  {
    name: "circular value precludes dispatch",
    code: 'const circular = {}; circular.self = circular; return await tools.read({ circular });',
    error: { kind: "InvalidDataValue", message: /circular/i },
  },
  {
    name: "non-JSON values follow the runtime boundary rules",
    code: `return await tools.read({
      missing: undefined, negZero: -0, inf: Infinity, list: [undefined, NaN, -Infinity],
      date: new Date(0), url: new URL("https://example.com/")
    });`,
    args: { negZero: -0, inf: null, list: [null, null, null], date: "1970-01-01T00:00:00.000Z", url: "https://example.com/" },
  },
];
