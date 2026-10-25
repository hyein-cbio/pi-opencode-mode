// Presentation metadata only: no result bodies, source inspection, or tool dispatch.
function clip(text, maxBytes) {
  const bytes = Buffer.from(text.slice(0, maxBytes + 1), "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes - 3;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + "…";
}

function previewArgs(input) {
  // Build a small snapshot before serialization; generated guest arguments can
  // be much larger than the script. Never retain or mutate the actual inputs.
  let nodes = 0;
  function visit(value, depth) {
    if (++nodes > 48 || depth > 4) return "[preview omitted]";
    if (typeof value === "string") return clip(value, 512);
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (Array.isArray(value)) {
      const items = value.slice(0, 8).map((item) => visit(item, depth + 1));
      if (value.length > 8) items.push("[more items]");
      return items;
    }
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      const copy = Object.create(null);
      for (const key of keys.slice(0, 8)) copy[clip(key, 128)] = visit(value[key], depth + 1);
      if (keys.length > 8) copy["[more properties]"] = keys.length - 8;
      return copy;
    }
    return "[preview unavailable]";
  }
  try { return clip(JSON.stringify(visit(input, 0)), 1024); }
  catch { return "[argument preview unavailable]"; }
}

export function createCallLog(onUpdate, maxCalls) {
  const records = [];
  const snapshot = () => records.map((record) => ({ ...record }));
  const publish = () => {
    // UI observers are best-effort, not part of host permissions or results.
    // A broken observer must not change execution or leave an unhandled rejection.
    try {
      const pending = onUpdate?.({ content: [], details: { calls: snapshot() } });
      pending?.catch?.(() => {});
    } catch { /* keep tool behavior independent of presentation */ }
  };
  return {
    snapshot, publish,
    async run(name, input, signal, invoke) {
      const record = records.length < maxCalls ? {
        name: clip(name, 128), args: previewArgs(input), status: "running",
      } : undefined;
      if (record) records.push(record);
      const startedAt = performance.now();
      publish();
      try {
        const value = await invoke();
        if (record) record.status = "ok";
        return value;
      } catch (error) {
        if (record) {
          record.status = signal?.aborted ? "cancelled" : "error";
          try { record.error = clip(error instanceof Error ? error.message : String(error), 512); }
          catch { record.error = "[error preview unavailable]"; }
        }
        throw error;
      } finally {
        if (record) record.durationMs = Math.max(0, performance.now() - startedAt);
        // invoke() settles only after the host and its cleanup/hooks settle.
        publish();
      }
    },
  };
}
