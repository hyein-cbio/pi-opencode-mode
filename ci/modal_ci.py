"""Run all Node/Pi CI checks and the upstream npm lookup on Modal."""

from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import re
import subprocess

import modal


ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = "/workspace"
MINIMUM_NODE = "22.19.0"
LATEST_NODE = "24.x"  # The latest CodeMode's psychoscript dependency requires Node >= 24.
NODE_IMAGES = {
    MINIMUM_NODE: "node:22.19.0-bookworm-slim",
    LATEST_NODE: "node:24-bookworm-slim",
}
PI_VERSIONS = ("0.99.0", "1.5.0")  # Minimum and locked Pi/TUI pairs.
EXACT_VERSION = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", re.ASCII)
app = modal.App("pi-opencode-mode-ci")


def make_image(node_version):
    image = (
        modal.Image.from_registry(NODE_IMAGES[node_version], add_python="3.11")
        .env({"CI": "true", "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/", "NPM_CONFIG_ENGINE_STRICT": "true"})
        .workdir(WORKSPACE)
    )
    # Modal re-imports this module at /root/modal_ci.py in the container. Local
    # upload inputs must only be inspected on the dispatching machine.
    if not modal.is_local():
        return image
    # Upload only inputs for the clean-copy harness, never .env, .git, .pi,
    # node_modules, or local credentials. The dispatcher self-tests run separately.
    package = json.loads((ROOT / "package.json").read_text())
    for path in [*package["files"], "package.json", "package-lock.json"]:
        image = image.add_local_file(ROOT / path, f"{WORKSPACE}/{path}")
    image = image.add_local_dir(ROOT / "test", f"{WORKSPACE}/test")
    return image


node22_image = make_image(MINIMUM_NODE)
node24_image = make_image(LATEST_NODE)


def validate_versions(pi_version, codemode_version):
    if pi_version not in PI_VERSIONS:
        raise ValueError(f"Not a Pi CI endpoint: {pi_version}")
    if codemode_version and not EXACT_VERSION.fullmatch(codemode_version):
        raise ValueError("CodeMode override must be an exact stable npm version")


def _run_tests(pi_version, codemode_version=""):
    validate_versions(pi_version, codemode_version)
    env = {**os.environ, "PI_OPENCODE_TEST_VERSION": pi_version}
    # An inherited override must not change a locked baseline cell.
    env.pop("PI_OPENCODE_CODEMODE_VERSION", None)
    if codemode_version:
        env["PI_OPENCODE_CODEMODE_VERSION"] = codemode_version
    subprocess.run(["npm", "run", "test:pi-versions"], cwd=WORKSPACE, env=env, check=True)


test_node22 = app.function(
    name="test_node22", image=node22_image, cpu=1, memory=2048, timeout=600, retries=0,
)(_run_tests)
test_node24 = app.function(
    name="test_node24", image=node24_image, cpu=1, memory=2048, timeout=600, retries=0,
)(_run_tests)


@app.local_entrypoint()
def run_tests(node_version: str, pi_version: str, codemode_version: str = ""):
    """Dispatch one matrix cell; no Node commands run locally."""
    validate_versions(pi_version, codemode_version)
    functions = {MINIMUM_NODE: test_node22, LATEST_NODE: test_node24}
    if node_version not in functions:
        raise ValueError(f"Unsupported Node version: {node_version}")
    functions[node_version].remote(pi_version, codemode_version)


@app.function(image=node24_image, cpu=1, memory=512, timeout=120, retries=0)
def resolve_latest(check_package: bool = False):
    result = subprocess.run(
        ["npm", "view", "@opencode/codemode@latest", "version", "--json",
         "--registry=https://registry.npmjs.org/", "--prefer-online"],
        cwd=WORKSPACE, check=True, capture_output=True, text=True,
    )
    version = json.loads(result.stdout)
    if not isinstance(version, str) or not EXACT_VERSION.fullmatch(version):
        raise ValueError(f"npm latest did not resolve to an exact stable version: {version!r}")
    if check_package:
        # Packaging does not depend on the cell's installed runtime or Pi version.
        subprocess.run(["npm", "pack", "--dry-run", "--json"], cwd=WORKSPACE, check=True)
    print(f"Resolved @opencode/codemode@latest to {version}", flush=True)
    return version


def report_latest(version):
    """Only copy the remote result into GitHub's output/summary files locally."""
    for variable, content in (
        ("GITHUB_OUTPUT", f"version={version}\n"),
        ("GITHUB_STEP_SUMMARY",
         f"Testing npm latest on Modal: **@opencode/codemode@{version}** "
         f"on Node {LATEST_NODE} with Pi/TUI {' and '.join(PI_VERSIONS)}.\n"),
    ):
        if path := os.environ.get(variable):
            with open(path, "a") as stream:
                stream.write(content)
    print(f"Resolved @opencode/codemode@latest to {version}", flush=True)


@app.local_entrypoint()
def latest():
    report_latest(resolve_latest.remote())


@app.local_entrypoint()
def matrix(latest_only: bool = False):
    """Check the locked baseline and npm latest, or only npm latest on schedule."""
    manifest = json.loads((ROOT / "package.json").read_text())
    baseline = manifest["dependencies"]["@opencode/codemode"].split(" || ")[0]
    version = resolve_latest.remote(check_package=not latest_only)
    report_latest(version)
    cells = [] if latest_only else [(node, pi, "") for node in NODE_IMAGES for pi in PI_VERSIONS]
    if latest_only or version != baseline:
        cells += [(LATEST_NODE, pi, version) for pi in PI_VERSIONS]
    failures = []
    # A full run is one wave of at most six isolated dependency installs.
    with ThreadPoolExecutor(max_workers=6) as pool:
        pending = {pool.submit(run_tests, *cell): cell for cell in cells}
        for future in as_completed(pending):
            node, pi, version = pending[future]
            lane = f"CodeMode {version} (npm latest)" if version else f"CodeMode {baseline} (locked)"
            label = f"Node {node} / Pi {pi} / {lane}"
            try:
                future.result()
            except Exception as error:
                failures.append(label)
                print(f"FAIL {label}: {error}", flush=True)
            else:
                print(f"PASS {label}", flush=True)
    if failures:
        raise RuntimeError(f"Modal compatibility failures: {failures}")
