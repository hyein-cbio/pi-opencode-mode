// Source data only. Tests must use in-memory tools, never run this shell text.
export const command = "python3 - <<'PY'\nfrom pathlib import Path\nroot = Path('fixture')\nbundle = root / 'payload'\nprint('한글 / << are string data')\nPY";
export const escapedSource = `return await Promise.allSettled([tools.bash({command:${JSON.stringify(command)},timeout:10}),tools.update_progress({steps:[{text:"인계 자료 확인",status:"completed"}]})]);`;
export const rawNewlineSource = escapedSource.replaceAll("\\n", "\n");
