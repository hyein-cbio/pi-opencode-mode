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
        output = patch("builtins.print")
        output.start()
        self.addCleanup(output.stop)

    def test_dispatch(self):
        for node, target in (("22.19.0", "test_node22"), ("24.x", "test_node24")):
            with self.subTest(node=node), patch.object(ci, target) as function:
                ci.run_tests(node, "0.99.0")
                ci.run_tests(node, "1.5.0", "9.8.7")
                self.assertEqual([call.args for call in function.remote.call_args_list],
                                 [("0.99.0", ""), ("1.5.0", "9.8.7")])

    def test_endpoints_match_the_lockfile_and_minimum_pi(self):
        manifest = ci.json.loads((ci.ROOT / "package.json").read_text())
        versions = manifest["dependencies"]["@opencode/codemode"].split(" || ")
        self.assertEqual(len(versions), 2)
        packages = ci.json.loads((ci.ROOT / "package-lock.json").read_text())["packages"]
        self.assertEqual(packages["node_modules/@opencode/codemode"]["version"], versions[0])
        for name in ("pi-coding-agent", "pi-tui"):
            package = f"@earendil-works/{name}"
            self.assertTrue(manifest["peerDependencies"][package].startswith(f">={ci.PI_VERSIONS[0]} "))
            self.assertEqual(packages[f"node_modules/{package}"]["version"], ci.PI_VERSIONS[1])

    def test_matrix_resolves_once_and_uses_node24_only_for_latest(self):
        baseline = [(node, pi, "") for node in ("22.19.0", "24.x") for pi in ("0.99.0", "1.5.0")]
        latest = [("24.x", pi, "9.8.7") for pi in ("0.99.0", "1.5.0")]
        for latest_only in (False, True):
            with self.subTest(latest_only=latest_only), patch.object(ci, "run_tests") as run:
                with patch.object(ci, "resolve_latest") as resolve, patch.object(ci, "report_latest") as report:
                    resolve.remote.return_value = "9.8.7"
                    ci.matrix(latest_only=latest_only)
                resolve.remote.assert_called_once_with(check_package=not latest_only)
                report.assert_called_once_with("9.8.7")
                self.assertCountEqual([call.args for call in run.call_args_list],
                                      latest if latest_only else baseline + latest)

    def test_full_matrix_does_not_retest_the_same_version_when_latest_equals_baseline(self):
        with patch.object(ci, "run_tests") as run, patch.object(ci, "resolve_latest") as resolve:
            resolve.remote.return_value = "2.3.0"
            ci.matrix()
            self.assertEqual(run.call_count, 4)
            self.assertTrue(all(call.args[2] == "" for call in run.call_args_list))

    def test_matrix_finishes_other_cells_and_propagates_failure(self):
        def cell(node, pi, codemode):
            if (node, pi, codemode) in (("22.19.0", "0.99.0", ""), ("24.x", "1.5.0", "9.8.7")):
                raise RuntimeError("cell failed")
        with patch.object(ci, "run_tests", side_effect=cell) as run, patch.object(ci, "resolve_latest") as resolve:
            resolve.remote.return_value = "9.8.7"
            with self.assertRaises(RuntimeError) as failure:
                ci.matrix()
            self.assertEqual(run.call_count, 6)
            self.assertIn("Node 22.19.0 / Pi 0.99.0 / CodeMode 2.3.0 (locked)", str(failure.exception))
            self.assertIn("Node 24.x / Pi 1.5.0 / CodeMode 9.8.7 (npm latest)", str(failure.exception))

    def test_lookup_failure_does_not_report_or_fall_back_to_the_locked_version(self):
        for entry in (ci.matrix, ci.latest):
            with patch.object(ci, "resolve_latest") as resolve, patch.object(ci, "run_tests") as run:
                with patch.object(ci, "report_latest") as report:
                    resolve.remote.side_effect = RuntimeError("npm failed")
                    with self.assertRaisesRegex(RuntimeError, "npm failed"):
                        entry()
                run.assert_not_called()
                report.assert_not_called()

    def test_reject_invalid_inputs_before_dispatch(self):
        for args in (("26.x", "1.5.0"), ("24.x", "0.1.0"), ("24.x", "1.5.0", "latest"),
                     ("24.x", "1.5.0", "2.3.0\n"), ("24.x", "1.5.0", "2.3.0-rc.1"),
                     ("24.x", "1.5.0", "2.3.0+custom")):
            with self.subTest(args=args), self.assertRaises(ValueError):
                ci.run_tests(*args)

    def test_cell_environment_and_failure_propagation(self):
        for codemode in ("", "9.8.7"):
            with self.subTest(codemode=codemode), patch.object(ci.subprocess, "run") as run:
                with patch.dict(os.environ, {"PI_OPENCODE_CODEMODE_VERSION": "stale"}):
                    ci._run_tests("1.5.0", codemode)
                call = run.call_args
                self.assertEqual(call.args[0], ["npm", "run", "test:pi-versions"])
                self.assertTrue(call.kwargs["check"])
                self.assertEqual(call.kwargs["cwd"], "/workspace")
                self.assertEqual(call.kwargs["env"]["PI_OPENCODE_TEST_VERSION"], "1.5.0")
                self.assertEqual(call.kwargs["env"].get("PI_OPENCODE_CODEMODE_VERSION"), codemode or None)
        failure = subprocess.CalledProcessError(1, "npm test")
        with patch.object(ci.subprocess, "run", side_effect=failure) as run, self.assertRaises(subprocess.CalledProcessError):
            ci._run_tests("0.99.0")
        self.assertEqual(run.call_count, 1)

    def test_latest_lookup_validation_and_pack_once(self):
        for pack in (False, True):
            with patch.object(ci.subprocess, "run", return_value=MagicMock(stdout='"9.8.7"')) as run:
                self.assertEqual(ci.resolve_latest.local(check_package=pack), "9.8.7")
                command = run.call_args_list[0].args[0]
                self.assertIn("@opencode/codemode@latest", command)
                self.assertIn("--registry=https://registry.npmjs.org/", command)
                self.assertIn("--prefer-online", command)
                self.assertTrue(all(call.kwargs["check"] for call in run.call_args_list))
                self.assertEqual(run.call_count, 2 if pack else 1)
                if pack:
                    self.assertEqual(run.call_args.args[0], ["npm", "pack", "--dry-run", "--json"])
        for value in ('["9.8.7"]', '"latest"', '"9.8.7\\n"', '"9.8.7-rc.1"', '{}', 'not json'):
            with self.subTest(value=value), patch.object(
                ci.subprocess, "run", return_value=MagicMock(stdout=value),
            ) as run, self.assertRaises(ValueError):
                ci.resolve_latest.local(check_package=True)
            self.assertEqual(run.call_count, 1)

    def test_latest_writes_remote_result_for_github(self):
        with tempfile.TemporaryDirectory() as directory:
            output, summary = Path(directory) / "output", Path(directory) / "summary"
            output.write_text("existing=value\n")
            with patch.dict(os.environ, {"GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)}):
                with patch.object(ci, "resolve_latest") as function:
                    function.remote.return_value = "9.8.7"
                    ci.latest()
            self.assertEqual(output.read_text(), "existing=value\nversion=9.8.7\n")
            self.assertIn("@opencode/codemode@9.8.7", summary.read_text())
            self.assertIn("Node 24.x with Pi/TUI 0.99.0 and 1.5.0", summary.read_text())

    def test_source_upload_allowlist(self):
        image = MagicMock()
        for method in ("env", "workdir", "add_local_file", "add_local_dir"):
            getattr(image, method).return_value = image
        with patch.object(ci.modal, "is_local", return_value=True):
            with patch.object(ci.modal.Image, "from_registry", return_value=image) as registry:
                self.assertIs(ci.make_image("22.19.0"), image)
        registry.assert_called_once_with("node:22.19.0-bookworm-slim", add_python="3.11")
        self.assertEqual(image.env.call_args.args[0]["NPM_CONFIG_ENGINE_STRICT"], "true")
        files = {str(call.args[0].relative_to(ci.ROOT)) for call in image.add_local_file.call_args_list}
        self.assertEqual(files, {
            *ci.json.loads((ci.ROOT / "package.json").read_text())["files"], "package.json", "package-lock.json",
        })
        self.assertIn("codemode-versions.js", files)
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
