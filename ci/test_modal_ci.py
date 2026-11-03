"""Offline regression tests for the Modal CI dispatcher and failure handling."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import modal_ci as ci


class ModalCITests(unittest.TestCase):
    def setUp(self):
        # Mocked commands should not look like actual npm runs in CI logs.
        output = patch("builtins.print")
        output.start()
        self.addCleanup(output.stop)

    def test_matrix_dispatch(self):
        for node, target in (("22.19.0", "test_node22"), ("24.x", "test_node24")):
            for pi in ci.PI_VERSIONS:
                with self.subTest(node=node, pi=pi), patch.object(ci, target) as function:
                    ci.run_tests(node, pi, "2.2.5")
                    function.remote.assert_called_once_with(pi, "2.2.5")

    def test_full_matrix_uses_one_shared_upstream_lookup(self):
        for upstream in (False, True):
            with self.subTest(upstream=upstream), patch.object(ci, "run_tests") as run:
                with patch.object(ci, "resolve_latest") as lookup, patch.object(ci, "report_latest") as report:
                    lookup.remote.return_value = "2.2.5"
                    ci.matrix(upstream=upstream)
                    self.assertEqual(lookup.remote.call_count, int(upstream))
                    self.assertEqual(report.call_count, int(upstream))
                self.assertEqual(sorted(call.args for call in run.call_args_list), sorted(
                    (node, pi, "2.2.5" if upstream else "")
                    for node in ci.NODE_IMAGES for pi in ci.PI_VERSIONS
                ))

    def test_matrix_finishes_other_cells_and_propagates_failure(self):
        def cell(node, pi, version):
            if (node, pi) == ("22.19.0", "0.99.0"):
                raise RuntimeError("cell failed")
        with patch.object(ci, "run_tests", side_effect=cell) as run:
            with self.assertRaisesRegex(RuntimeError, "22.19.0"):
                ci.matrix()
            self.assertEqual(run.call_count, 6)

    def test_matrix_lookup_failure_never_runs_pinned_fallback(self):
        with patch.object(ci, "resolve_latest") as lookup, patch.object(ci, "run_tests") as run:
            lookup.remote.side_effect = RuntimeError("npm failed")
            with self.assertRaises(RuntimeError):
                ci.matrix(upstream=True)
            run.assert_not_called()

    def test_reject_invalid_inputs_before_dispatch(self):
        for args in (("26.x", "1.4.0", ""), ("24.x", "0.1.0", ""),
                     ("24.x", "1.4.0", "latest"), ("24.x", "1.4.0", "2.2.5\n")):
            with self.subTest(args=args), self.assertRaises(ValueError):
                ci.run_tests(*args)

    def test_full_suite_and_pack_with_selected_version(self):
        for upstream in ("", "2.2.5"):
            with self.subTest(upstream=upstream), patch.object(ci.subprocess, "run") as run:
                with patch.dict(os.environ, {"PI_OPENCODE_UPSTREAM_VERSION": "stale"}):
                    ci._run_tests("1.4.0", upstream)
                self.assertEqual([call.args[0] for call in run.call_args_list], [
                    ["node", "--version"],
                    ["python", "-m", "unittest", "discover", "-s", "ci", "-p", "test_*.py"],
                    ["npm", "run", "test:pi-versions"],
                    ["npm", "pack", "--dry-run", "--json"],
                ])
                for call in run.call_args_list:
                    self.assertTrue(call.kwargs["check"])
                    self.assertEqual(call.kwargs["cwd"], "/workspace")
                    env = call.kwargs["env"]
                    self.assertEqual(env["PI_OPENCODE_TEST_VERSION"], "1.4.0")
                    self.assertEqual(env.get("PI_OPENCODE_UPSTREAM_VERSION"), upstream or None)

    def test_command_failure_propagates_and_stops_checks(self):
        for failing_index in range(4):
            failure = subprocess.CalledProcessError(1, "check")
            with self.subTest(index=failing_index), patch.object(
                ci.subprocess, "run", side_effect=[None] * failing_index + [failure],
            ) as run:
                with self.assertRaises(subprocess.CalledProcessError):
                    ci._run_tests("0.99.0")
                self.assertEqual(run.call_count, failing_index + 1)

    def test_dispatch_failure_propagates(self):
        with patch.object(ci, "test_node24") as function:
            function.remote.side_effect = RuntimeError("remote failed")
            with self.assertRaises(RuntimeError):
                ci.run_tests("24.x", "1.4.0")

    def test_latest_lookup_validation_and_registry(self):
        resolve = ci.resolve_latest.local
        for value in ('"2.2.5"', '"2.3.0-rc.1+build"'):
            with patch.object(ci.subprocess, "run", return_value=MagicMock(stdout=value)) as run:
                self.assertEqual(resolve(), ci.json.loads(value))
                command = run.call_args.args[0]
                self.assertIn("--registry=https://registry.npmjs.org/", command)
                self.assertIn("--prefer-online", command)
                self.assertTrue(run.call_args.kwargs["check"])
        for value in ('["2.2.5"]', '"latest"', '"2.2.5\\n"', '{}', 'not json'):
            with self.subTest(value=value), patch.object(
                ci.subprocess, "run", return_value=MagicMock(stdout=value),
            ), self.assertRaises(ValueError):
                resolve()

    def test_latest_failure_has_no_fallback_or_github_output(self):
        failure = subprocess.CalledProcessError(1, "npm view")
        with patch.object(ci.subprocess, "run", side_effect=failure):
            with self.assertRaises(subprocess.CalledProcessError):
                ci.resolve_latest.local()
        with patch.object(ci, "resolve_latest") as function, patch("builtins.open") as output:
            function.remote.side_effect = failure
            with self.assertRaises(subprocess.CalledProcessError):
                ci.latest()
            output.assert_not_called()

    def test_latest_writes_remote_result_for_github(self):
        with tempfile.TemporaryDirectory() as directory:
            output, summary = Path(directory) / "output", Path(directory) / "summary"
            output.write_text("existing=value\n")
            with patch.dict(os.environ, {"GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)}):
                with patch.object(ci, "resolve_latest") as function:
                    function.remote.return_value = "2.2.5"
                    ci.latest()
            self.assertEqual(output.read_text(), "existing=value\nversion=2.2.5\n")
            self.assertIn("@opencode/codemode@2.2.5", summary.read_text())

    def test_source_upload_allowlist(self):
        image = MagicMock()
        for method in ("env", "workdir", "add_local_file", "add_local_dir"):
            getattr(image, method).return_value = image
        with patch.object(ci.modal, "is_local", return_value=True):
            with patch.object(ci.modal.Image, "from_registry", return_value=image) as registry:
                self.assertIs(ci.make_image("22.19.0"), image)
        registry.assert_called_once_with("node:22.19.0-bookworm-slim", add_python="3.11")
        files = {str(call.args[0].relative_to(ci.ROOT)) for call in image.add_local_file.call_args_list}
        self.assertEqual(files, {
            *ci.json.loads((ci.ROOT / "package.json").read_text())["files"],
            "package.json", "package-lock.json", "ci/modal_ci.py", "ci/test_modal_ci.py",
        })
        image.add_local_dir.assert_called_once_with(ci.ROOT / "test", "/workspace/test")

    def test_remote_image_import_never_reads_local_upload_inputs(self):
        image = MagicMock()
        image.env.return_value = image
        image.workdir.return_value = image
        with patch.object(ci.modal, "is_local", return_value=False):
            with patch.object(ci.modal.Image, "from_registry", return_value=image):
                with patch.object(Path, "read_text", side_effect=AssertionError("local read")):
                    self.assertIs(ci.make_image("22.19.0"), image)
                    self.assertIs(ci.make_image("24.x"), image)
        image.add_local_file.assert_not_called()
        image.add_local_dir.assert_not_called()


if __name__ == "__main__":
    unittest.main()
