from __future__ import annotations

import hashlib
import importlib.util
import json
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
STANDALONE_PATH = (
    SCRIPTS / "verify-real-test-gcloud-toolchain-standalone.py"
)
STANDALONE_BUILDER_PATH = (
    SCRIPTS / "build-real-test-gcloud-toolchain-standalone.py"
)
VERIFIER_SPEC = importlib.util.spec_from_file_location(
    "verify_real_test_gcloud_toolchain",
    VERIFIER_PATH,
)
assert VERIFIER_SPEC and VERIFIER_SPEC.loader
verifier = importlib.util.module_from_spec(VERIFIER_SPEC)
sys.modules[VERIFIER_SPEC.name] = verifier
VERIFIER_SPEC.loader.exec_module(verifier)

BUILDER_SPEC = importlib.util.spec_from_file_location(
    "build_real_test_gcloud_toolchain_standalone",
    STANDALONE_BUILDER_PATH,
)
assert BUILDER_SPEC and BUILDER_SPEC.loader
standalone_builder = importlib.util.module_from_spec(BUILDER_SPEC)
sys.modules[BUILDER_SPEC.name] = standalone_builder
BUILDER_SPEC.loader.exec_module(standalone_builder)


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
        self.startup_temporary = tempfile.mkdtemp(
            prefix=".gcloud-standalone-",
            dir=Path.home(),
        )
        os.chmod(self.startup_temporary, 0o700)
        probe = subprocess.run(
            [
                "/usr/bin/env",
                "-i",
                "LC_ALL=C",
                "LANG=C",
                "TZ=UTC",
                sys.executable,
                "-I",
                "-S",
                "-B",
                "-c",
                (
                    "import json,posix,sys;"
                    "print(json.dumps({"
                    "'environment':{"
                    "key.decode('utf-8'):value.decode('utf-8') "
                    "for key,value in posix.environ.items()},"
                    "'prefix':sys.prefix,'path':sys.path},"
                    "sort_keys=True,separators=(',',':')))"
                ),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={},
            check=False,
        )
        self.assertEqual(probe.returncode, 0)
        self.assertEqual(probe.stderr, b"")
        startup = json.loads(probe.stdout)
        self.assertEqual(len(startup["path"]), 3)
        self.assertFalse(os.path.lexists(startup["path"][0]))
        startup_manifest = (
            Path(self.startup_temporary) / "python-runtime.list"
        )
        startup_manifest.write_text(
            f"{startup['path'][1]}\n{startup['path'][2]}\n",
            encoding="ascii",
        )
        os.chmod(startup_manifest, 0o600)
        trusted_uids = {0, os.geteuid()}
        trusted_gids = {0, os.getegid()}
        for trusted_path in (
            *startup["path"][1:],
            str(startup_manifest),
        ):
            current = Path("/")
            for component in Path(trusted_path).parts[1:]:
                current /= component
                metadata = os.lstat(current)
                trusted_uids.add(metadata.st_uid)
                trusted_gids.add(metadata.st_gid)
        self.startup_contract = standalone_builder.StartupContract(
            python_prefix=startup["prefix"],
            initial_sys_path=tuple(startup["path"]),
            active_sys_path=tuple(startup["path"][1:]),
            environment=tuple(sorted(startup["environment"].items())),
            manifest_path=str(startup_manifest),
            trusted_uids=tuple(sorted(trusted_uids)),
            trusted_gids=tuple(sorted(trusted_gids)),
            forbidden_write_mask=0o002,
        )
        self.local_standalone = standalone_builder.build_artifact(
            SCRIPTS.parent,
            contract=self.startup_contract,
        )

    def tearDown(self) -> None:
        self.fixture.cleanup()
        shutil.rmtree(self.startup_temporary)
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

    def _standalone_namespace(
        self,
        content: bytes | None = None,
    ) -> dict[str, object]:
        source = content or STANDALONE_PATH.read_bytes()
        namespace: dict[str, object] = {
            "__file__": "<standalone-test>",
            "__name__": "_standalone_test",
        }
        exec(compile(source, "<standalone-test>", "exec"), namespace)
        namespace["_load_runtime_modules"]()
        return namespace

    def _run_standalone(
        self,
        arguments: tuple[str, ...] = ("diagnose",),
        *,
        content: bytes | None = None,
        cwd: Path | None = None,
        environment: dict[str, str] | None = None,
        isolated_flags: tuple[str, ...] = ("-I", "-S", "-B"),
    ) -> subprocess.CompletedProcess[bytes]:
        assignments = ["LC_ALL=C", "LANG=C", "TZ=UTC"]
        if environment:
            assignments.extend(
                f"{key}={value}" for key, value in environment.items()
            )
        return subprocess.run(
            [
                "/usr/bin/env",
                "-i",
                *assignments,
                sys.executable,
                *isolated_flags,
                "-",
                *arguments,
            ],
            input=content or self.local_standalone,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env={},
            check=False,
        )

    def _assert_loader_failure(
        self,
        content: bytes,
        reason: str | None = None,
    ) -> None:
        result = self._run_standalone(content=content)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"")
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["command"], "diagnose")
        self.assertEqual(receipt["gcloud_subprocesses"], 0)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertEqual(receipt["writes"], 0)
        if reason is None:
            self.assertIn(
                receipt["reason"],
                {
                    "core-identity",
                    "source-commit-identity",
                    "verifier-identity",
                },
            )
        else:
            self.assertEqual(receipt["reason"], reason)
        self.assertNotIn(b"Classify a package-managed", result.stdout)
        self.assertNotIn(b"Diagnose the frozen", result.stdout)
        self.assertNotIn(b"CORE_HEX", result.stdout)

    def test_standalone_inner_sources_match_trusted_git_blobs(self) -> None:
        namespace = self._standalone_namespace()
        self.assertEqual(
            namespace["SOURCE_COMMIT"],
            "be83c732aa574bca7898fd31cf200024804ac049",
        )
        cases = (
            (
                "CORE",
                "81d49151884b882bda05557d77362bcfa97603e1",
                19631,
                "cc415b7a139f0af7d140c279ca55d873b03e534684d22d1d86a7d818ba31fd57",
                SCRIPTS / "gcp_sdk_boundary.py",
            ),
            (
                "VERIFIER",
                "c7ca6fe40043590307b6b038e2e21bbf5c42ec26",
                15607,
                "06349ed2315825ac62e832b7015551af6f16e85227a136e81dc0d5275b8bd203",
                VERIFIER_PATH,
            ),
        )
        for label, oid, expected_size, expected_sha256, source_path in cases:
            with self.subTest(label=label):
                result = subprocess.run(
                    [
                        "/usr/bin/git",
                        "-C",
                        str(SCRIPTS.parent),
                        "cat-file",
                        "blob",
                        oid,
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                )
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stderr, b"")
                embedded = bytes.fromhex(namespace[f"{label}_HEX"])
                self.assertEqual(embedded, result.stdout)
                self.assertEqual(embedded, source_path.read_bytes())
                self.assertEqual(len(embedded), expected_size)
                self.assertEqual(
                    hashlib.sha256(embedded).hexdigest(),
                    expected_sha256,
                )
                self.assertEqual(
                    namespace["_blob_oid"](embedded),
                    oid,
                )

    def test_standalone_artifact_is_deterministic(self) -> None:
        generated = standalone_builder.build_artifact(SCRIPTS.parent)
        self.assertEqual(generated, STANDALONE_PATH.read_bytes())

    def test_production_startup_contract_is_exact(self) -> None:
        contract = standalone_builder.PRODUCTION_CONTRACT
        prefix = "/usr/lib/google-cloud-sdk/platform/bundledpythonunix"
        self.assertEqual(contract.python_prefix, prefix)
        self.assertEqual(
            contract.initial_sys_path,
            (
                f"{prefix}/lib/python314.zip",
                f"{prefix}/lib/python3.14",
                f"{prefix}/lib/python3.14/lib-dynload",
            ),
        )
        self.assertEqual(
            contract.active_sys_path,
            contract.initial_sys_path[1:],
        )
        self.assertEqual(
            contract.environment,
            (("LANG", "C"), ("LC_ALL", "C"), ("TZ", "UTC")),
        )
        self.assertEqual(
            contract.manifest_path,
            "/var/lib/dpkg/info/google-cloud-cli.list",
        )
        self.assertEqual(contract.trusted_uids, (0,))
        self.assertEqual(contract.trusted_gids, (0,))
        self.assertEqual(contract.forbidden_write_mask, 0o022)

    def test_standalone_builder_uses_fixed_git_environment(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=b"trusted",
            stderr=b"",
        )
        with mock.patch.object(
            standalone_builder.subprocess,
            "run",
            return_value=completed,
        ) as run:
            self.assertEqual(
                standalone_builder._git(SCRIPTS.parent, "status"),
                b"trusted",
            )
        self.assertEqual(
            run.call_args.kwargs["env"],
            {
                "GIT_CONFIG_GLOBAL": "/dev/null",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_NO_REPLACE_OBJECTS": "1",
                "GIT_OPTIONAL_LOCKS": "0",
                "GIT_TERMINAL_PROMPT": "0",
                "HOME": str(SCRIPTS.parent),
                "PATH": "/usr/bin:/bin",
                "LANG": "C",
                "LC_ALL": "C",
                "TMPDIR": "/tmp",
            },
        )
        self.assertIs(run.call_args.kwargs["stdin"], subprocess.DEVNULL)
        self.assertFalse(run.call_args.kwargs["check"])

    def test_standalone_rejects_inner_bit_tampering_without_source_leak(
        self,
    ) -> None:
        original = self.local_standalone
        for label in ("CORE", "VERIFIER"):
            with self.subTest(label=label):
                content = bytearray(original)
                marker = f'{label}_HEX = (\n    "'.encode("ascii")
                start = content.index(marker) + len(marker)
                content[start] = (
                    ord("3") if content[start] != ord("3") else ord("2")
                )
                self._assert_loader_failure(bytes(content))

    def test_standalone_rejects_metadata_tampering(self) -> None:
        original = self.local_standalone
        cases = (
            (
                b'SOURCE_COMMIT = "be83c732aa574bca7898fd31cf200024804ac049"',
                b'SOURCE_COMMIT = "ae83c732aa574bca7898fd31cf200024804ac049"',
            ),
            (b"CORE_SIZE = 19631", b"CORE_SIZE = 19630"),
            (
                b'CORE_SHA256 = "cc415b7a',
                b'CORE_SHA256 = "dc415b7a',
            ),
            (
                b'CORE_BLOB = "81d49151',
                b'CORE_BLOB = "91d49151',
            ),
            (b"VERIFIER_SIZE = 15607", b"VERIFIER_SIZE = 15606"),
            (
                b'VERIFIER_SHA256 = "06349ed2',
                b'VERIFIER_SHA256 = "16349ed2',
            ),
            (
                b'VERIFIER_BLOB = "c7ca6fe4',
                b'VERIFIER_BLOB = "d7ca6fe4',
            ),
        )
        for before, after in cases:
            with self.subTest(before=before):
                self.assertIn(before, original)
                self._assert_loader_failure(
                    original.replace(before, after, 1)
                )

    def test_standalone_load_order_and_module_metadata_are_fixed(self) -> None:
        namespace = self._standalone_namespace()
        original_compile = compile
        filenames: list[str] = []

        def recording_compile(
            source: object,
            filename: str,
            mode: str,
            *args: object,
            **kwargs: object,
        ) -> object:
            filenames.append(filename)
            return original_compile(source, filename, mode, *args, **kwargs)

        fake = type(sys)("gcp_sdk_boundary")
        fake.injected = True
        sys.modules["gcp_sdk_boundary"] = fake
        try:
            with mock.patch(
                "builtins.compile",
                side_effect=recording_compile,
            ):
                inner_verifier = namespace["_load_verified_modules"]()
            inner_core = sys.modules["gcp_sdk_boundary"]
            self.assertIsNot(inner_core, fake)
            self.assertEqual(
                filenames,
                [
                    namespace["_CORE_FILENAME"],
                    namespace["_VERIFIER_FILENAME"],
                ],
            )
            self.assertEqual(inner_core.__package__, "")
            self.assertIsNone(inner_core.__loader__)
            self.assertEqual(
                inner_core.__spec__.origin,
                namespace["_CORE_FILENAME"],
            )
            self.assertEqual(
                inner_verifier.__spec__.origin,
                namespace["_VERIFIER_FILENAME"],
            )
        finally:
            sys.modules["gcp_sdk_boundary"] = boundary
            sys.modules.pop(
                namespace["_VERIFIER_MODULE_NAME"],
                None,
            )

    def test_standalone_only_accepts_diagnose(self) -> None:
        for arguments in (
            (),
            ("behavior",),
            ("prepare",),
            ("diagnose", "extra"),
        ):
            with self.subTest(arguments=arguments):
                result = self._run_standalone(arguments)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr, b"")
                self.assertEqual(
                    json.loads(result.stdout)["reason"],
                    "standalone-argv-invalid",
                )

    def test_standalone_rejects_noncanonical_flags_environment_and_prefix(
        self,
    ) -> None:
        cases = (
            (
                self._run_standalone(
                    isolated_flags=("-I", "-B"),
                ),
                "standalone-startup-flags",
            ),
            (
                self._run_standalone(environment={"UNTRUSTED": "1"}),
                "standalone-startup-environment",
            ),
            (
                self._run_standalone(
                    content=self.local_standalone.replace(
                        (
                            f"_PYTHON_PREFIX = "
                            f"{self.startup_contract.python_prefix!r}"
                        ).encode("ascii"),
                        b"_PYTHON_PREFIX = '/untrusted-python'",
                        1,
                    )
                ),
                "standalone-startup-prefix",
            ),
        )
        for result, reason in cases:
            with self.subTest(reason=reason):
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr, b"")
                self.assertEqual(json.loads(result.stdout)["reason"], reason)

    def test_standalone_rejects_non_stdin_and_sys_path_drift(self) -> None:
        script = Path(self.startup_temporary) / "standalone.py"
        script.write_bytes(self.local_standalone)
        os.chmod(script, 0o500)
        non_stdin = subprocess.run(
            [
                "/usr/bin/env",
                "-i",
                "LC_ALL=C",
                "LANG=C",
                "TZ=UTC",
                sys.executable,
                "-I",
                "-S",
                "-B",
                str(script),
                "diagnose",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={},
            check=False,
        )
        self.assertEqual(non_stdin.returncode, 1)
        self.assertEqual(
            json.loads(non_stdin.stdout)["reason"],
            "standalone-startup-argv",
        )

        expected = (
            f"_INITIAL_SYS_PATH = "
            f"{self.startup_contract.initial_sys_path!r}"
        ).encode("ascii")
        changed = (
            f"_INITIAL_SYS_PATH = "
            f"{(*self.startup_contract.initial_sys_path, '/extra')!r}"
        ).encode("ascii")
        self.assertIn(expected, self.local_standalone)
        drift = self._run_standalone(
            content=self.local_standalone.replace(expected, changed, 1)
        )
        self.assertEqual(drift.returncode, 1)
        self.assertEqual(
            json.loads(drift.stdout)["reason"],
            "standalone-startup-sys-path",
        )

    def test_missing_zip_slot_accepts_only_exact_enoent(self) -> None:
        namespace = self._standalone_namespace(self.local_standalone)
        parent = Path(self.startup_temporary) / "missing-slot"
        parent.mkdir(mode=0o700)
        target = parent / "python314.zip"
        namespace["_MISSING_STDLIB_ZIP"] = str(target)
        namespace["_missing_zip_receipt"]()

        target.write_bytes(b"not-a-runtime-zip")
        with self.assertRaises(namespace["_IdentityError"]) as regular:
            namespace["_missing_zip_receipt"]()
        self.assertEqual(
            regular.exception.reason,
            "standalone-startup-zip-slot",
        )
        target.unlink()
        target.mkdir()
        with self.assertRaises(namespace["_IdentityError"]):
            namespace["_missing_zip_receipt"]()
        target.rmdir()
        os.symlink("absent-target", target)
        with self.assertRaises(namespace["_IdentityError"]):
            namespace["_missing_zip_receipt"]()
        target.unlink()

        original_stat = namespace["_POSIX"].stat

        def denied(
            path: str,
            *,
            dir_fd: int,
            follow_symlinks: bool,
        ) -> object:
            if path == target.name:
                raise PermissionError(13, "denied", path)
            return original_stat(
                path,
                dir_fd=dir_fd,
                follow_symlinks=follow_symlinks,
            )

        with mock.patch.object(namespace["_POSIX"], "stat", side_effect=denied):
            with self.assertRaises(namespace["_IdentityError"]) as denied_error:
                namespace["_missing_zip_receipt"]()
        self.assertEqual(
            denied_error.exception.reason,
            "standalone-startup-zip-slot",
        )

    def test_missing_zip_parent_symlink_is_rejected_no_follow(self) -> None:
        namespace = self._standalone_namespace(self.local_standalone)
        real = Path(self.startup_temporary) / "real-parent"
        real.mkdir(mode=0o700)
        linked = Path(self.startup_temporary) / "linked-parent"
        os.symlink(real.name, linked)
        namespace["_MISSING_STDLIB_ZIP"] = str(linked / "python314.zip")
        with self.assertRaises(namespace["_IdentityError"]) as captured:
            namespace["_missing_zip_receipt"]()
        self.assertEqual(
            captured.exception.reason,
            "standalone-startup-path-boundary",
        )

    def test_runtime_paths_require_manifest_membership_and_safe_metadata(
        self,
    ) -> None:
        namespace = self._standalone_namespace(self.local_standalone)
        runtime = Path(self.startup_temporary) / "runtime"
        library = runtime / "lib"
        stdlib = library / "python3.14"
        dynload = stdlib / "lib-dynload"
        dynload.mkdir(parents=True, mode=0o700)
        manifest = runtime / "google-cloud-cli.list"
        manifest.write_text(f"{stdlib}\n", encoding="ascii")
        os.chmod(manifest, 0o600)
        namespace["_MISSING_STDLIB_ZIP"] = str(
            library / "python314.zip"
        )
        namespace["_STDLIB_DIRECTORY"] = str(stdlib)
        namespace["_DYNLIB_DIRECTORY"] = str(dynload)
        namespace["_PACKAGE_MANIFEST"] = str(manifest)
        namespace["_TRUSTED_UIDS"] = (0, os.geteuid())
        namespace["_TRUSTED_GIDS"] = tuple(
            sorted(
                {
                    0,
                    os.getegid(),
                    *(os.lstat(path).st_gid for path in Path(runtime).parents),
                }
            )
        )
        namespace["_FORBIDDEN_WRITE_MASK"] = 0o022

        with self.assertRaises(namespace["_IdentityError"]) as missing:
            namespace["_filesystem_binding"]()
        self.assertEqual(
            missing.exception.reason,
            "standalone-startup-manifest",
        )
        manifest.write_text(
            f"{stdlib}\n{dynload}\n",
            encoding="ascii",
        )
        namespace["_filesystem_binding"]()

        os.chmod(stdlib, 0o770)
        with self.assertRaises(namespace["_IdentityError"]) as writable:
            namespace["_filesystem_binding"]()
        self.assertEqual(
            writable.exception.reason,
            "standalone-startup-path-boundary",
        )
        os.chmod(stdlib, 0o700)

        peer = runtime / "manifest-peer"
        os.link(manifest, peer)
        with self.assertRaises(namespace["_IdentityError"]) as hardlink:
            namespace["_filesystem_binding"]()
        self.assertEqual(
            hardlink.exception.reason,
            "standalone-startup-manifest",
        )

    def test_runtime_metadata_rejects_wrong_owner_and_group_write(self) -> None:
        namespace = self._standalone_namespace(self.local_standalone)
        metadata = mock.Mock(
            st_dev=1,
            st_ino=2,
            st_uid=0,
            st_gid=0,
            st_mode=stat.S_IFDIR | 0o755,
            st_nlink=2,
            st_size=0,
            st_ctime_ns=3,
        )
        namespace["_TRUSTED_UIDS"] = (0,)
        namespace["_TRUSTED_GIDS"] = (0,)
        namespace["_FORBIDDEN_WRITE_MASK"] = 0o022
        namespace["_validate_metadata"](
            metadata,
            namespace["_S_IFDIR"],
            "unsafe",
        )
        metadata.st_uid = 1
        with self.assertRaises(namespace["_IdentityError"]):
            namespace["_validate_metadata"](
                metadata,
                namespace["_S_IFDIR"],
                "unsafe",
            )
        metadata.st_uid = 0
        metadata.st_mode = stat.S_IFDIR | 0o775
        with self.assertRaises(namespace["_IdentityError"]):
            namespace["_validate_metadata"](
                metadata,
                namespace["_S_IFDIR"],
                "unsafe",
            )

    def test_missing_slot_and_importer_cache_are_removed_before_imports(
        self,
    ) -> None:
        namespace = self._standalone_namespace(self.local_standalone)
        before_path = list(sys.path)
        before_cache = dict(sys.path_importer_cache)
        try:
            sys.path[:] = list(self.startup_contract.initial_sys_path)
            sys.path_importer_cache[
                self.startup_contract.initial_sys_path[0]
            ] = None
            namespace["_activate_trusted_import_paths"]()
            self.assertEqual(
                tuple(sys.path),
                self.startup_contract.active_sys_path,
            )
            self.assertNotIn(
                self.startup_contract.initial_sys_path[0],
                sys.path_importer_cache,
            )
        finally:
            sys.path[:] = before_path
            sys.path_importer_cache.clear()
            sys.path_importer_cache.update(before_cache)

    def test_post_load_and_pre_exit_drift_are_fail_closed(self) -> None:
        post_load_marker = b"        verifier = _load_verified_modules()\n"
        self.assertIn(post_load_marker, self.local_standalone)
        post_load = self._run_standalone(
            content=self.local_standalone.replace(
                post_load_marker,
                post_load_marker
                + b"        sys.path.append('/post-load-drift')\n",
                1,
            )
        )
        self.assertEqual(
            json.loads(post_load.stdout)["reason"],
            "standalone-startup-post-load-drift",
        )

        pre_exit_marker = (
            b"        receipt = verifier.diagnose(verifier.production_config())\n"
        )
        self.assertIn(pre_exit_marker, self.local_standalone)
        pre_exit = self._run_standalone(
            content=self.local_standalone.replace(
                pre_exit_marker,
                pre_exit_marker
                + b"        sys.path.append('/pre-exit-drift')\n",
                1,
            )
        )
        self.assertEqual(
            json.loads(pre_exit.stdout)["reason"],
            "standalone-startup-pre-exit-drift",
        )

    def test_sitecustomize_control_loads_but_isolated_standalone_rejects_it(
        self,
    ) -> None:
        ambient = Path(self.startup_temporary) / "ambient"
        ambient.mkdir(mode=0o700)
        marker = Path(self.startup_temporary) / "sitecustomize-loaded"
        (ambient / "sitecustomize.py").write_text(
            f"open({str(marker)!r}, 'x').close()\n",
            encoding="ascii",
        )
        control = subprocess.run(
            [
                "/usr/bin/env",
                "-i",
                f"PYTHONPATH={ambient}",
                sys.executable,
                "-B",
                "-c",
                "pass",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={},
            check=False,
        )
        self.assertEqual(control.returncode, 0)
        self.assertTrue(marker.exists())
        marker.unlink()

        isolated = self._run_standalone(
            environment={"PYTHONPATH": str(ambient)}
        )
        self.assertEqual(isolated.returncode, 1)
        self.assertEqual(
            json.loads(isolated.stdout)["reason"],
            "standalone-startup-environment",
        )
        self.assertFalse(marker.exists())

    def test_standalone_runs_after_stdin_eof_without_gcloud(self) -> None:
        result = self._run_standalone()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"")
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["command"], "diagnose")
        self.assertEqual(receipt["writes"], 0)
        self.assertEqual(receipt["gcloud_subprocesses"], 0)
        self.assertNotEqual(
            receipt.get("reason"),
            "standalone-loader-failed",
        )
        self.assertFalse(os.path.exists("/tmp/gcloud-should-not-run"))

    def test_standalone_ignores_ambient_fake_module_and_pythonpath(
        self,
    ) -> None:
        ambient = self.fixture.root / "ambient"
        ambient.mkdir()
        (ambient / "gcp_sdk_boundary.py").write_text(
            "raise RuntimeError('ambient-fake-loaded')\n"
        )
        environment = dict(os.environ)
        environment["PYTHONPATH"] = str(ambient)
        result = self._run_standalone(environment=environment)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"")
        receipt = json.loads(result.stdout)
        self.assertNotEqual(
            receipt.get("reason"),
            "standalone-loader-failed",
        )
        self.assertNotIn(b"ambient-fake-loaded", result.stdout)

    def test_standalone_stdin_creates_no_files_or_pycache(self) -> None:
        readonly = self.fixture.root / "standalone-readonly"
        readonly.mkdir()
        os.chmod(readonly, 0o555)
        before = self._snapshot()
        try:
            result = self._run_standalone(cwd=readonly)
            after = self._snapshot()
            self.assertEqual(before, after)
        finally:
            os.chmod(readonly, 0o755)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"")
        self.assertFalse((readonly / "__pycache__").exists())

    def test_standalone_and_regular_diagnose_are_semantically_equal(
        self,
    ) -> None:
        namespace = self._standalone_namespace()
        before = self._snapshot()
        try:
            inner_verifier = namespace["_load_verified_modules"]()
            ordinary_timestamps = iter(f"t{index}" for index in range(12))
            standalone_timestamps = iter(
                f"t{index}" for index in range(12)
            )
            ordinary = verifier.diagnose(
                self.config,
                timestamp=lambda: next(ordinary_timestamps),
            )
            standalone = inner_verifier.diagnose(
                self.config,
                timestamp=lambda: next(standalone_timestamps),
            )
            self.assertEqual(standalone, ordinary)
            self.assertEqual(standalone["status"], "PASS")
            self.assertEqual(standalone["gcloud_subprocesses"], 0)
        finally:
            sys.modules["gcp_sdk_boundary"] = boundary
            sys.modules.pop(
                namespace["_VERIFIER_MODULE_NAME"],
                None,
            )
        self.assertEqual(before, self._snapshot())


if __name__ == "__main__":
    unittest.main()
