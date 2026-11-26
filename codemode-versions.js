import manifest from "./package.json" with { type: "json" };

// npm, the installer and the runtime all use the same two exact versions.
export const CODEMODE_PACKAGE = "@opencode/codemode";
export const CODEMODE_VERSIONS = Object.freeze(manifest.dependencies[CODEMODE_PACKAGE].split(" || "));
export const [baseline, verifiedLatest] = CODEMODE_VERSIONS;
