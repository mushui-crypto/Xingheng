from __future__ import annotations

import hashlib
import importlib.util
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

import gcp_sdk_boundary as boundary


SCRIPTS = Path(__file__).resolve().parent
VERIFIER_PATH = SCRIPTS / "verify-real-test-gcloud-toolchain.py"
VERIFIER_SPEC = importlib.util.spec_from_file_location(
    "verify_real_test_gcloud_toolchain",
    VERIFIER_PATH,
)
assert VERIFIER_SPEC and VERIFIER_SPEC.loader
verifier = importlib.util.module_from_spec(VERIFIER_SPEC)
sys.modules[VERIFIER_SPEC.name] = verifier
VERIFIER_SPEC.loader.exec_module(verifier)


class SdkFixture:
    sdk_root = "/usr/lib/google-cloud-sdk"

    def __init__(self) -> None:
        self.temporary = tempfile.mkdtemp(prefix="gcp-sdk-boundary-")
        os.chmod(self.temporary, 0o700)
        self.root = Path(self.temporary)
        self.sdk = self.root / self.sdk_root.lstrip("/")
        self.sdk.mkdir(parents=True, mode=0o755)
        self.uid = os.geteuid()
        self.gid = os.getegid()

    def cleanup(self) -> None:
        shutil.rmtree(self.temporary)

    def directory(self, relative: str, mode: int = 0o755) -> Path:
        path = self.sdk / relative
        path.mkdir(parents=True, exist_ok=True, mode=mode)
        os.chmod(path, mode)
        return path

    def file(
        self,
        relative: str,
        content: bytes = b"fixture\n",
        mode: int = 0o644,
    ) -> Path:
        path = self.sdk / relative
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        path.write_bytes(content)
        os.chmod(path, mode)
        return path

    def manifest(self, excluded: set[str] | None = None) -> boundary.ManifestSnapshot:
        excluded = excluded or set()
        values: list[str] = []
        for parent, directories, files in os.walk(self.sdk, followlinks=False):
            directories.sort()
            files.sort()
            for name in directories + files:
                relative = (Path(parent) / name).relative_to(self.sdk).as_posix()
                if relative not in excluded:
                    values.append(f"{self.sdk_root}/{relative}")
        content = ("\n".join(sorted(values)) + "\n").encode()
        return boundary.normalize_manifest(content, self.sdk_root)

    def scan(
        self,
        excluded: set[str] | None = None,
    ) -> boundary.BoundaryScan:
        return boundary.scan_sdk_boundary(
            self.temporary,
            self.manifest(excluded),
            owner_uid=self.uid,
            owner_gid=self.gid,
        )


class ManifestNormalizationTests(unittest.TestCase):
    def test_normalizes_sdk_relative_membership(self) -> None:
        snapshot = boundary.normalize_manifest(
            b"/usr/lib/google-cloud-sdk/bin/gcloud\n"
            b"/usr/lib/google-cloud-sdk/lib/module.py\n",
            "/usr/lib/google-cloud-sdk",
        )
        self.assertEqual(
            snapshot.relative_paths,
            frozenset({"bin/gcloud", "lib/module.py"}),
        )

    def test_rejects_invalid_manifest_paths(self) -> None:
        cases = [
            (b"\n", boundary.BoundaryReason.MANIFEST_EMPTY),
            (b"relative\n", boundary.BoundaryReason.MANIFEST_NON_ABSOLUTE),
            (
                b"/usr/lib/google-cloud-sdk/./bin/gcloud\n",
                boundary.BoundaryReason.MANIFEST_NOT_CANONICAL,
            ),
            (
                b"/usr/lib/google-cloud-sdk/../outside\n",
                boundary.BoundaryReason.MANIFEST_NOT_CANONICAL,
            ),
            (
                b"/usr/lib/other/file\n",
                boundary.BoundaryReason.MANIFEST_OUTSIDE_SDK,
            ),
            (
                b"/usr/lib/google-cloud-sdk/a\0b\n",
                boundary.BoundaryReason.MANIFEST_NUL,
            ),
            (
                b"/usr/lib/google-cloud-sdk/a\n"
                b"/usr/lib/google-cloud-sdk/a\n",
                boundary.BoundaryReason.MANIFEST_DUPLICATE,
            ),
        ]
        for content, reason in cases:
            with self.subTest(reason=reason):
                with self.assertRaises(boundary.BoundaryError) as captured:
                    boundary.normalize_manifest(
                        content,
                        "/usr/lib/google-cloud-sdk",
                    )
                self.assertEqual(captured.exception.reason, reason)


class BoundaryClassificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = SdkFixture()

    def tearDown(self) -> None:
        self.fixture.cleanup()

    def test_manifest_directory_regular_and_internal_symlink_are_present(self) -> None:
        self.fixture.directory("bin")
        self.fixture.file("bin/gcloud")
        self.fixture.directory("lib")
        os.symlink("../bin/gcloud", self.fixture.sdk / "lib/gcloud-link")
        os.symlink(
            "/usr/lib/google-cloud-sdk/bin/gcloud",
            self.fixture.sdk / "lib/gcloud-absolute-link",
        )
        scan = self.fixture.scan()
        self.assertEqual(scan.unsafe.count, 0)
        reasons = {entry.relative_path: entry.reason for entry in scan.entries}
        self.assertEqual(
            reasons["lib/gcloud-link"],
            boundary.BoundaryReason.MANIFEST_PRESENT,
        )
        self.assertEqual(
            reasons["lib/gcloud-absolute-link"],
            boundary.BoundaryReason.MANIFEST_PRESENT,
        )

    def test_unmanifested_internal_symlink_is_unsafe(self) -> None:
        self.fixture.directory("bin")
        self.fixture.file("bin/gcloud")
        self.fixture.directory("lib")
        os.symlink("../bin/gcloud", self.fixture.sdk / "lib/gcloud-link")
        scan = self.fixture.scan({"lib/gcloud-link"})
        reasons = {entry.relative_path: entry.reason for entry in scan.entries}
        self.assertEqual(
            reasons["lib/gcloud-link"],
            boundary.BoundaryReason.UNMANIFESTED_SYMLINK,
        )

    def test_external_and_broken_symlinks_are_unsafe(self) -> None:
        self.fixture.directory("lib")
        os.symlink("../../../../outside", self.fixture.sdk / "lib/external")
        os.symlink("missing", self.fixture.sdk / "lib/broken")
        scan = self.fixture.scan()
        self.assertEqual(scan.external.count, 1)
        self.assertEqual(scan.broken.count, 1)
        self.assertEqual(scan.unsafe.count, 2)

    def test_unmanifested_pycache_directory_and_direct_pyc_are_allowed(self) -> None:
        self.fixture.directory("lib")
        self.fixture.directory("lib/__pycache__")
        self.fixture.file("lib/__pycache__/module.cpython-314.pyc")
        scan = self.fixture.scan(
            {"lib/__pycache__", "lib/__pycache__/module.cpython-314.pyc"}
        )
        self.assertEqual(scan.unsafe.count, 0)
        self.assertEqual(scan.allowed.count, 2)

    def test_nested_and_disguised_pycache_objects_are_unsafe(self) -> None:
        self.fixture.directory("lib")
        self.fixture.directory("lib/__pycache__")
        self.fixture.directory("lib/__pycache__/nested")
        self.fixture.file("lib/__pycache__/nested/module.pyc")
        self.fixture.directory("lib/fake__pycache__")
        excluded = {
            "lib/__pycache__",
            "lib/__pycache__/nested",
            "lib/__pycache__/nested/module.pyc",
            "lib/fake__pycache__",
        }
        scan = self.fixture.scan(excluded)
        self.assertGreaterEqual(scan.unsafe.count, 3)

    def test_unmanifested_source_shared_object_script_and_temp_are_unsafe(self) -> None:
        self.fixture.directory("lib")
        names = {"x.py", "x.pyi", "x.so", "script", "x.tmp"}
        for name in names:
            self.fixture.file(f"lib/{name}", mode=0o644)
        scan = self.fixture.scan({f"lib/{name}" for name in names})
        self.assertEqual(scan.unsafe.count, len(names))

    def test_writable_hardlink_and_special_objects_are_unsafe(self) -> None:
        self.fixture.directory("lib")
        self.fixture.file("lib/writable", mode=0o666)
        source = self.fixture.file("lib/hardlink-source")
        os.link(source, self.fixture.sdk / "lib/hardlink-peer")
        os.mkfifo(self.fixture.sdk / "lib/fifo", 0o600)
        scan = self.fixture.scan()
        reasons = {entry.relative_path: entry.reason for entry in scan.entries}
        self.assertEqual(
            reasons["lib/writable"],
            boundary.BoundaryReason.ENTRY_WRITABLE,
        )
        self.assertEqual(
            reasons["lib/hardlink-source"],
            boundary.BoundaryReason.REGULAR_HARDLINK,
        )
        self.assertEqual(
            reasons["lib/fifo"],
            boundary.BoundaryReason.SPECIAL_OBJECT,
        )

    def test_missing_manifest_entry_is_unsafe(self) -> None:
        self.fixture.directory("lib")
        manifest = boundary.normalize_manifest(
            b"/usr/lib/google-cloud-sdk/lib\n"
            b"/usr/lib/google-cloud-sdk/lib/missing.py\n",
            self.fixture.sdk_root,
        )
        scan = boundary.scan_sdk_boundary(
            self.fixture.temporary,
            manifest,
            owner_uid=self.fixture.uid,
            owner_gid=self.fixture.gid,
        )
        reasons = {entry.relative_path: entry.reason for entry in scan.entries}
        self.assertEqual(
            reasons["lib/missing.py"],
            boundary.BoundaryReason.MANIFEST_ENTRY_MISSING,
        )

    def test_owner_reason_is_stable(self) -> None:
        metadata = os.stat_result(
            (
                stat.S_IFREG | 0o644,
                0,
                0,
                1,
                self.fixture.uid + 1,
                self.fixture.gid,
                1,
                0,
                0,
                0,
            )
        )
        reason = boundary._classify(
            "lib/file",
            metadata,
            True,
            None,
            None,
            self.fixture.uid,
            self.fixture.gid,
        )
        self.assertEqual(reason, boundary.BoundaryReason.ENTRY_OWNER)

    def test_unsafe_filesystem_root_stops_parent_chain(self) -> None:
        self.fixture.file("bin/gcloud")
        manifest = self.fixture.manifest()
        os.chmod(self.fixture.temporary, 0o777)
        with self.assertRaises(boundary.BoundaryError) as captured:
            boundary.scan_sdk_boundary(
                self.fixture.temporary,
                manifest,
                owner_uid=self.fixture.uid,
                owner_gid=self.fixture.gid,
            )
        self.assertEqual(
            captured.exception.reason,
            boundary.BoundaryReason.ROOT_CHAIN_UNSAFE,
        )

    def test_summary_is_stable_and_detects_symmetric_difference(self) -> None:
        self.fixture.directory("lib")
        self.fixture.file("lib/module.py")
        manifest = self.fixture.manifest()
        first = boundary.scan_sdk_boundary(
            self.fixture.temporary,
            manifest,
            owner_uid=self.fixture.uid,
            owner_gid=self.fixture.gid,
        )
        second = boundary.scan_sdk_boundary(
            self.fixture.temporary,
            manifest,
            owner_uid=self.fixture.uid,
            owner_gid=self.fixture.gid,
        )
        self.assertEqual(first.all_entries, second.all_entries)
        self.fixture.directory("lib/__pycache__")
        current = boundary.scan_sdk_boundary(
            self.fixture.temporary,
            manifest,
            owner_uid=self.fixture.uid,
            owner_gid=self.fixture.gid,
        )
        comparison = boundary.compare_scans(first, current)
        self.assertTrue(comparison.concurrent_drift)
        self.assertEqual(
            comparison.first_symmetric_diff["relative_path"],
            "lib",
        )

    def test_same_metadata_atomic_replacement_changes_identity_summary(self) -> None:
        self.fixture.directory("lib")
        target = self.fixture.file("lib/module.py", b"AAAA")
        manifest = self.fixture.manifest()
        reference = boundary.scan_sdk_boundary(
            self.fixture.temporary,
            manifest,
            owner_uid=self.fixture.uid,
            owner_gid=self.fixture.gid,
        )
        before = os.lstat(target)
        replacement = target.with_name(".module.py.replacement")
        replacement.write_bytes(b"BBBB")
        os.chmod(replacement, stat.S_IMODE(before.st_mode))
        os.replace(replacement, target)
        after = os.lstat(target)
        self.assertNotEqual(before.st_ino, after.st_ino)
        self.assertEqual(
            (
                stat.S_IFMT(before.st_mode),
                before.st_uid,
                before.st_gid,
                stat.S_IMODE(before.st_mode),
                before.st_nlink,
                before.st_size,
            ),
            (
                stat.S_IFMT(after.st_mode),
                after.st_uid,
                after.st_gid,
                stat.S_IMODE(after.st_mode),
                after.st_nlink,
                after.st_size,
            ),
        )
        current = boundary.scan_sdk_boundary(
            self.fixture.temporary,
            manifest,
            owner_uid=self.fixture.uid,
            owner_gid=self.fixture.gid,
        )
        comparison = boundary.compare_scans(reference, current)
        self.assertNotEqual(reference.all_entries, current.all_entries)
        self.assertTrue(comparison.concurrent_drift)
        self.assertIsNotNone(comparison.first_symmetric_diff)

    def test_manifest_receipt_change_marks_concurrent_drift(self) -> None:
        self.fixture.file("bin/gcloud")
        scan = self.fixture.scan()
        receipt = boundary.FileReceipt(
            "manifest",
            1,
            2,
            self.fixture.uid,
            self.fixture.gid,
            0o644,
            1,
            1,
            1,
            "0" * 64,
        )
        comparison = boundary.compare_scans(
            scan,
            scan,
            reference_manifest=receipt,
            current_manifest=replace(receipt, sha256="1" * 64),
        )
        self.assertTrue(comparison.concurrent_drift)
        self.assertIsNone(comparison.first_symmetric_diff)


class ToolchainVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = SdkFixture()
        self.fixture.directory("bin")
        gcloud = self.fixture.file(
            "bin/gcloud",
            b"#!/bin/sh\n/usr/bin/touch /tmp/gcloud-should-not-run\n",
            0o755,
        )
        self.fixture.directory("platform/bundledpythonunix/bin")
        python = self.fixture.file(
            "platform/bundledpythonunix/bin/python3.14",
            b"#!/bin/sh\nexit 0\n",
            0o755,
        )
        dash = self.fixture.root / "usr/bin/dash"
        dash.parent.mkdir(parents=True, exist_ok=True)
        dash.write_bytes(b"#!/bin/sh\nexit 0\n")
        os.chmod(dash, 0o755)
        dpkg_query = self.fixture.root / "usr/bin/dpkg-query"
        dpkg_query.write_text(
            "#!/bin/sh\n"
            "case \"$3\" in\n"
            "google-cloud-cli) printf '%s' 'google-cloud-cli|test|fixture|ii' ;;\n"
            "dash) printf '%s' 'dash|test|fixture|ii' ;;\n"
            "*) exit 1 ;;\n"
            "esac\n"
        )
        os.chmod(dpkg_query, 0o755)
        dpkg = self.fixture.root / "usr/bin/dpkg"
        dpkg.write_text("#!/bin/sh\nexit 0\n")
        os.chmod(dpkg, 0o755)
        (self.fixture.root / "bin").mkdir(exist_ok=True)

        manifest_values: list[str] = []
        for parent, directories, files in os.walk(self.fixture.sdk):
            directories.sort()
            files.sort()
            for name in directories + files:
                relative = (Path(parent) / name).relative_to(
                    self.fixture.sdk
                ).as_posix()
                manifest_values.append(f"{self.fixture.sdk_root}/{relative}")
        list_content = ("\n".join(sorted(manifest_values)) + "\n").encode()
        md5_content = b"fixture-md5\n"
        info = self.fixture.root / "var/lib/dpkg/info"
        info.mkdir(parents=True)
        package_list = info / "google-cloud-cli.list"
        package_list.write_bytes(list_content)
        package_md5sums = info / "google-cloud-cli.md5sums"
        package_md5sums.write_bytes(md5_content)

        def frozen(path: Path, logical: str) -> object:
            content = path.read_bytes()
            return verifier.FrozenTool(
                logical,
                len(content),
                hashlib.sha256(content).hexdigest(),
            )

        self.config = verifier.ToolchainConfig(
            filesystem_root=self.fixture.temporary,
            sdk_root=self.fixture.sdk_root,
            package_list="/var/lib/dpkg/info/google-cloud-cli.list",
            package_md5sums="/var/lib/dpkg/info/google-cloud-cli.md5sums",
            package_list_lines=len(list_content.splitlines()),
            package_list_sha256=hashlib.sha256(list_content).hexdigest(),
            package_md5sums_lines=1,
            package_md5sums_sha256=hashlib.sha256(md5_content).hexdigest(),
            tools=(
                frozen(gcloud, "/usr/lib/google-cloud-sdk/bin/gcloud"),
                frozen(dash, "/usr/bin/dash"),
                frozen(
                    python,
                    "/usr/lib/google-cloud-sdk/platform/"
                    "bundledpythonunix/bin/python3.14",
                ),
            ),
            dpkg_query="/usr/bin/dpkg-query",
            dpkg="/usr/bin/dpkg",
            gcloud_package="google-cloud-cli|test|fixture|ii",
            dash_package="dash|test|fixture|ii",
            owner_uid=self.fixture.uid,
            owner_gid=self.fixture.gid,
        )

    def tearDown(self) -> None:
        self.fixture.cleanup()
        try:
            os.unlink("/tmp/gcloud-should-not-run")
        except FileNotFoundError:
            pass

    def _snapshot(self) -> dict[str, tuple[object, ...]]:
        value = {}
        for parent, directories, files in os.walk(self.fixture.root):
            directories.sort()
            files.sort()
            for name in directories + files:
                path = Path(parent) / name
                metadata = os.lstat(path)
                object_type = (
                    "dir"
                    if stat.S_ISDIR(metadata.st_mode)
                    else "file"
                    if stat.S_ISREG(metadata.st_mode)
                    else "other"
                )
                digest = (
                    hashlib.sha256(path.read_bytes()).hexdigest()
                    if object_type == "file"
                    else ""
                )
                value[str(path.relative_to(self.fixture.root))] = (
                    object_type,
                    metadata.st_dev,
                    metadata.st_ino,
                    stat.S_IMODE(metadata.st_mode),
                    metadata.st_nlink,
                    metadata.st_size,
                    metadata.st_ctime_ns,
                    digest,
                )
        return value

    def _replace_receipt_file(self, logical_path: str) -> None:
        target = Path(self.config.actual(logical_path))
        metadata = os.lstat(target)
        replacement = target.with_name(f".{target.name}.replacement")
        replacement.write_bytes(target.read_bytes())
        os.chmod(replacement, stat.S_IMODE(metadata.st_mode))
        os.replace(replacement, target)

    def test_diagnose_is_read_only_and_never_executes_gcloud(self) -> None:
        before = self._snapshot()
        timestamps = iter(f"t{index}" for index in range(12))
        receipt = verifier.diagnose(
            self.config,
            timestamp=lambda: next(timestamps),
        )
        self.assertEqual(receipt["status"], "PASS")
        self.assertEqual(receipt["writes"], 0)
        self.assertEqual(receipt["gcloud_subprocesses"], 0)
        self.assertFalse(receipt["concurrent_drift"])
        self.assertEqual(before, self._snapshot())
        self.assertFalse(os.path.exists("/tmp/gcloud-should-not-run"))

    def test_post_verify_pre_reference_receipt_drift_fails_closed(self) -> None:
        original_scan = verifier.scan_sdk_boundary
        calls = 0

        def scan_with_drift(*args: object, **kwargs: object) -> object:
            nonlocal calls
            if calls == 0:
                self._replace_receipt_file(self.config.package_md5sums)
            calls += 1
            return original_scan(*args, **kwargs)

        with mock.patch.object(
            verifier,
            "scan_sdk_boundary",
            side_effect=scan_with_drift,
        ):
            receipt = verifier.diagnose(self.config)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertTrue(receipt["concurrent_drift"])
        self.assertEqual(receipt["drift_phase"], "post-reference")

    def test_post_current_receipt_drift_fails_closed(self) -> None:
        original_scan = verifier.scan_sdk_boundary
        calls = 0

        def scan_with_drift(*args: object, **kwargs: object) -> object:
            nonlocal calls
            result = original_scan(*args, **kwargs)
            calls += 1
            if calls == 2:
                self._replace_receipt_file(self.config.package_md5sums)
            return result

        with mock.patch.object(
            verifier,
            "scan_sdk_boundary",
            side_effect=scan_with_drift,
        ):
            receipt = verifier.diagnose(self.config)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertTrue(receipt["concurrent_drift"])
        self.assertEqual(receipt["drift_phase"], "post-current")

    def test_pre_return_receipt_drift_fails_closed(self) -> None:
        original_capture = verifier._capture_static_binding
        calls = 0

        def capture_with_drift(config: object) -> object:
            nonlocal calls
            calls += 1
            if calls == 4:
                self._replace_receipt_file(self.config.package_md5sums)
            return original_capture(config)

        with mock.patch.object(
            verifier,
            "_capture_static_binding",
            side_effect=capture_with_drift,
        ):
            receipt = verifier.diagnose(self.config)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertTrue(receipt["concurrent_drift"])
        self.assertEqual(receipt["drift_phase"], "pre-return")

    def test_behavior_is_explicitly_blocked_without_writes(self) -> None:
        before = self._snapshot()
        receipt = verifier.behavior(self.config)
        self.assertEqual(receipt["status"], "BLOCKED")
        self.assertEqual(receipt["writes"], 0)
        self.assertEqual(receipt["gcloud_subprocesses"], 0)
        self.assertEqual(before, self._snapshot())

    def test_cli_import_does_not_create_pycache(self) -> None:
        isolated = Path(self.fixture.temporary) / "verifier-cli"
        isolated.mkdir()
        verifier_copy = isolated / VERIFIER_PATH.name
        core_copy = isolated / "gcp_sdk_boundary.py"
        shutil.copyfile(VERIFIER_PATH, verifier_copy)
        shutil.copyfile(SCRIPTS / "gcp_sdk_boundary.py", core_copy)
        environment = dict(os.environ)
        environment.pop("PYTHONDONTWRITEBYTECODE", None)
        result = subprocess.run(
            [sys.executable, str(verifier_copy), "behavior"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertFalse((isolated / "__pycache__").exists())


if __name__ == "__main__":
    unittest.main()
