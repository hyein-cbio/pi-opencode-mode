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
NODE_IMAGES = {
    "22.19.0": "node:22.19.0-bookworm-slim",
    "24.x": "node:24-bookworm-slim",
}
PI_VERSIONS = ("0.99.0", "1.3.0", "1.4.0")
EXACT_VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", re.ASCII)
app = modal.App("pi-opencode-mode-ci")


def make_image(node_version):
    image = (
        modal.Image.from_registry(NODE_IMAGES[node_version], add_python="3.11")
        .env({"CI": "true", "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/"})
        .workdir(WORKSPACE)
    )
    # Modal re-imports this module at /root/modal_ci.py in the container. Local
    # upload inputs must only be inspected on the dispatching machine.
    if not modal.is_local():
        return image
    # The clean-copy harness installs dependencies itself. Upload only its inputs
    # and CI self-tests, never .env, .git, .pi, node_modules, or local credentials.
    package = json.loads((ROOT / "package.json").read_text())
    for path in [*package["files"], "package.json", "package-lock.json"]:
        image = image.add_local_file(ROOT / path, f"{WORKSPACE}/{path}")
    image = image.add_local_dir(ROOT / "test", f"{WORKSPACE}/test")
    for path in ("modal_ci.py", "test_modal_ci.py"):
        image = image.add_local_file(ROOT / "ci" / path, f"{WORKSPACE}/ci/{path}")
    return image


node22_image = make_image("22.19.0")
node24_image = make_image("24.x")


def validate_versions(pi_version, upstream_version):
    if pi_version not in PI_VERSIONS:
        raise ValueError(f"Unsupported Pi version: {pi_version}")
    if upstream_version and not EXACT_VERSION.fullmatch(upstream_version):
        raise ValueError("Upstream version must be an exact npm version")


def _run_tests(pi_version, upstream_version=""):
    validate_versions(pi_version, upstream_version)
    env = {**os.environ, "PI_OPENCODE_TEST_VERSION": pi_version}
    # A release-pinned run must not accidentally inherit a candidate version.
    env.pop("PI_OPENCODE_UPSTREAM_VERSION", None)
    if upstream_version:
        env["PI_OPENCODE_UPSTREAM_VERSION"] = upstream_version
    for command in (
        ["node", "--version"],
        ["python", "-m", "unittest", "discover", "-s", "ci", "-p", "test_*.py"],
        ["npm", "run", "test:pi-versions"],
        ["npm", "pack", "--dry-run", "--json"],
    ):
        print(f"+ {' '.join(command)}", flush=True)
        # A failed test or pack must fail modal run and the GitHub check.
        subprocess.run(command, cwd=WORKSPACE, env=env, check=True)


test_node22 = app.function(
    name="test_node22", image=node22_image, cpu=1, memory=2048, timeout=600, retries=0,
)(_run_tests)
test_node24 = app.function(
    name="test_node24", image=node24_image, cpu=1, memory=2048, timeout=600, retries=0,
)(_run_tests)


@app.local_entrypoint()
def run_tests(node_version: str, pi_version: str, upstream_version: str = ""):
    """Dispatch one existing GitHub matrix cell; no Node commands run locally."""
    validate_versions(pi_version, upstream_version)
    functions = {"22.19.0": test_node22, "24.x": test_node24}
    if node_version not in functions:
        raise ValueError(f"Unsupported Node version: {node_version}")
    functions[node_version].remote(pi_version, upstream_version)


@app.function(image=node24_image, cpu=1, memory=512, timeout=120, retries=0)
def resolve_latest():
    result = subprocess.run(
        ["npm", "view", "@opencode/codemode@latest", "version", "--json",
         "--registry=https://registry.npmjs.org/", "--prefer-online"],
        cwd=WORKSPACE, check=True, capture_output=True, text=True,
    )
    version = json.loads(result.stdout)
    if not isinstance(version, str) or not EXACT_VERSION.fullmatch(version):
        raise ValueError(f"npm returned an invalid version: {version!r}")
    print(f"Resolved @opencode/codemode@latest to {version}", flush=True)
    return version


def report_latest(version):
    """Only copy the remote result into GitHub's output/summary files locally."""
    for variable, content in (
        ("GITHUB_OUTPUT", f"version={version}\n"),
        ("GITHUB_STEP_SUMMARY",
         f"Testing npm latest on Modal: **@opencode/codemode@{version}** "
         "across all six Node/Pi combinations.\n"),
    ):
        if path := os.environ.get(variable):
            with open(path, "a") as stream:
                stream.write(content)
    print(f"Resolved @opencode/codemode@latest to {version}", flush=True)


@app.local_entrypoint()
def latest():
    report_latest(resolve_latest.remote())


@app.local_entrypoint()
def matrix(upstream: bool = False):
    """One ephemeral app per workflow, with all six cells running on Modal."""
    version = resolve_latest.remote() if upstream else ""
    if upstream:
        report_latest(version)
    failures = []
    # Creating one app per cell can hit Modal's app-creation rate limit. Remote
    # function calls share this app, but each call gets its own isolated inputs.
    with ThreadPoolExecutor(max_workers=6) as pool:
        pending = {
            pool.submit(run_tests, node, pi, version): (node, pi)
            for node in NODE_IMAGES for pi in PI_VERSIONS
        }
        for future in as_completed(pending):
            node, pi = pending[future]
            try:
                future.result()
            except Exception as error:
                # A cell failure must not prevent the other five from finishing.
                failures.append((node, pi))
                print(f"FAIL Node {node} / Pi {pi}: {error}", flush=True)
            else:
                print(f"PASS Node {node} / Pi {pi}", flush=True)
    if failures:
        raise RuntimeError(f"Modal compatibility failures: {failures}")
