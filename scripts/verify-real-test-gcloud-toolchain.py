#!/usr/bin/python3
"""Diagnose the frozen real-test gcloud toolchain without changing the host."""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import argparse
import hashlib
import json
import os
import stat
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from gcp_sdk_boundary import (
    BoundaryError,
    FileReceipt,
    compare_scans,
    normalize_manifest,
    read_file_receipt,
    scan_sdk_boundary,
)


GCLOUD = "/usr/lib/google-cloud-sdk/bin/gcloud"
DASH = "/usr/bin/dash"
BUNDLED_PYTHON = (
    "/usr/lib/google-cloud-sdk/platform/bundledpythonunix/bin/python3.14"
)
SDK_ROOT = "/usr/lib/google-cloud-sdk"
PACKAGE_LIST = "/var/lib/dpkg/info/google-cloud-cli.list"
PACKAGE_MD5SUMS = "/var/lib/dpkg/info/google-cloud-cli.md5sums"
BASE_ENV = {
    "HOME": "/root",
    "PATH": "/usr/bin:/bin",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "TZ": "UTC",
}


@dataclass(frozen=True)
class FrozenTool:
    path: str
    size: int
    sha256: str


@dataclass(frozen=True)
class ToolchainConfig:
    filesystem_root: str
    sdk_root: str
    package_list: str
    package_md5sums: str
    package_list_lines: int
    package_list_sha256: str
    package_md5sums_lines: int
    package_md5sums_sha256: str
    tools: tuple[FrozenTool, ...]
    dpkg_query: str
    dpkg: str
    gcloud_package: str
    dash_package: str
    owner_uid: int
    owner_gid: int

    def actual(self, absolute_path: str) -> str:
        if not absolute_path.startswith("/"):
            raise ValueError("toolchain path must be absolute")
        if self.filesystem_root == "/":
            return absolute_path
        return os.path.join(self.filesystem_root, absolute_path.lstrip("/"))


@dataclass(frozen=True)
class StaticBinding:
    manifest_content: bytes
    manifest_receipt: FileReceipt
    receipt: dict[str, object]
    identity_sha256: str

    def public(self) -> dict[str, object]:
        return {
            "identity_sha256": self.identity_sha256,
            "manifest_receipt": self.manifest_receipt.public(),
            "receipt": self.receipt,
        }


class ConcurrentDriftError(RuntimeError):
    def __init__(self, phase: str, detail: str) -> None:
        super().__init__(f"concurrent-drift:{phase}:{detail}")
        self.phase = phase


def production_config() -> ToolchainConfig:
    return ToolchainConfig(
        filesystem_root="/",
        sdk_root=SDK_ROOT,
        package_list=PACKAGE_LIST,
        package_md5sums=PACKAGE_MD5SUMS,
        package_list_lines=38256,
        package_list_sha256=(
            "89a9ad89d55616b6e50230d09fda21dbbb841a2e084e75ed0f2eaf5881ca69c6"
        ),
        package_md5sums_lines=31498,
        package_md5sums_sha256=(
            "1b50bcaa236e3602aeed8aeed59f376a5976f610e36470d4aa75edb058006f37"
        ),
        tools=(
            FrozenTool(
                GCLOUD,
                5962,
                "8628b9f971d07c5e52fd2c6d469ee4a0940c75eb51820d628c3dd068981bd260",
            ),
            FrozenTool(
                DASH,
                125640,
                "f5adb8bf0100ed0f8c7782ca5f92814e9229525a4b4e0d401cf3bea09ac960a6",
            ),
            FrozenTool(
                BUNDLED_PYTHON,
                19234856,
                "6fd816d7f83818698781299628960c28abbdd869da5b19bc6d6bf2ce1d965bd4",
            ),
        ),
        dpkg_query="/usr/bin/dpkg-query",
        dpkg="/usr/bin/dpkg",
        gcloud_package="google-cloud-cli|576.0.0-0|amd64|ii",
        dash_package="dash|0.5.12-2|amd64|ii",
        owner_uid=0,
        owner_gid=0,
    )


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_tool(config: ToolchainConfig, frozen: FrozenTool) -> dict[str, object]:
    actual = config.actual(frozen.path)
    before = os.lstat(actual)
    fd = os.open(actual, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        digest = hashlib.sha256()
        first_line = bytearray()
        while True:
            chunk = os.read(fd, 64 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            if len(first_line) < 10:
                first_line.extend(chunk[: 10 - len(first_line)])
    finally:
        os.close(fd)
    after = os.lstat(actual)
    if (
        (before.st_dev, before.st_ino) != (metadata.st_dev, metadata.st_ino)
        or (
            after.st_dev,
            after.st_ino,
            after.st_uid,
            after.st_gid,
            after.st_mode,
            after.st_nlink,
            after.st_size,
        )
        != (
            metadata.st_dev,
            metadata.st_ino,
            metadata.st_uid,
            metadata.st_gid,
            metadata.st_mode,
            metadata.st_nlink,
            metadata.st_size,
        )
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != config.owner_uid
        or metadata.st_gid != config.owner_gid
        or stat.S_IMODE(metadata.st_mode) != 0o755
        or metadata.st_nlink != 1
        or metadata.st_size != frozen.size
        or digest.hexdigest() != frozen.sha256
    ):
        raise RuntimeError(f"tool-receipt-drift: {frozen.path}")
    if frozen.path == GCLOUD and bytes(first_line) != b"#!/bin/sh\n":
        raise RuntimeError("gcloud-shebang-drift")
    return {
        "path": frozen.path,
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "mode": f"{stat.S_IMODE(metadata.st_mode):04o}",
        "nlink": metadata.st_nlink,
        "size": metadata.st_size,
        "ctime_ns": metadata.st_ctime_ns,
        "sha256": frozen.sha256,
    }


def _run_readonly(
    config: ToolchainConfig,
    argv: list[str],
) -> subprocess.CompletedProcess[bytes]:
    canonical_gcloud = config.actual(GCLOUD)
    if canonical_gcloud in argv:
        raise RuntimeError("diagnose-gcloud-subprocess-forbidden")
    return subprocess.run(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            "HOME": config.actual("/root"),
            "PATH": os.pathsep.join(
                [config.actual("/usr/bin"), config.actual("/bin")]
            ),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "TZ": "UTC",
        },
        timeout=60,
        check=False,
    )


def _validate_receipt(
    config: ToolchainConfig,
    path: str,
    lines: int,
    sha256: str,
) -> tuple[bytes, FileReceipt]:
    content, receipt = read_file_receipt(path)
    if (
        len(content.splitlines()) != lines
        or receipt.sha256 != sha256
        or receipt.uid != config.owner_uid
        or receipt.gid != config.owner_gid
        or receipt.mode & 0o022
    ):
        raise RuntimeError("package-manifest-receipt-drift")
    return content, receipt


def _validate_static_toolchain(
    config: ToolchainConfig,
) -> tuple[bytes, FileReceipt, dict[str, object]]:
    tools = [_validate_tool(config, tool) for tool in config.tools]
    list_content, list_receipt = _validate_receipt(
        config,
        config.actual(config.package_list),
        config.package_list_lines,
        config.package_list_sha256,
    )
    _, md5_receipt = _validate_receipt(
        config,
        config.actual(config.package_md5sums),
        config.package_md5sums_lines,
        config.package_md5sums_sha256,
    )
    package_format = "${Package}|${Version}|${Architecture}|${db:Status-Abbrev}"
    packages = []
    for name, expected in (
        ("google-cloud-cli", config.gcloud_package),
        ("dash", config.dash_package),
    ):
        result = _run_readonly(
            config,
            [
                config.actual(config.dpkg_query),
                "-W",
                f"-f={package_format}",
                name,
            ],
        )
        value = result.stdout.decode("ascii").strip()
        if result.returncode != 0 or result.stderr or value != expected:
            raise RuntimeError(f"package-receipt-drift: {name}")
        packages.append(value)
    verified = _run_readonly(
        config,
        [config.actual(config.dpkg), "--verify", "google-cloud-cli"],
    )
    if verified.returncode != 0 or verified.stdout or verified.stderr:
        raise RuntimeError("dpkg-verify-failed")
    sdk_root = os.lstat(config.actual(config.sdk_root))
    if (
        not stat.S_ISDIR(sdk_root.st_mode)
        or sdk_root.st_uid != config.owner_uid
        or sdk_root.st_gid != config.owner_gid
        or sdk_root.st_mode & 0o022
    ):
        raise RuntimeError("sdk-root-receipt-drift")
    return list_content, list_receipt, {
        "tools": tools,
        "packages": packages,
        "package_list": list_receipt.public(),
        "package_md5sums": md5_receipt.public(),
        "dpkg_verify": "empty",
        "sdk_root": {
            "path": config.sdk_root,
            "dev": sdk_root.st_dev,
            "ino": sdk_root.st_ino,
            "uid": sdk_root.st_uid,
            "gid": sdk_root.st_gid,
            "mode": f"{stat.S_IMODE(sdk_root.st_mode):04o}",
            "nlink": sdk_root.st_nlink,
            "size": sdk_root.st_size,
            "ctime_ns": sdk_root.st_ctime_ns,
        },
    }


def _capture_static_binding(config: ToolchainConfig) -> StaticBinding:
    manifest_content, manifest_receipt, receipt = _validate_static_toolchain(config)
    encoded = json.dumps(
        {
            "manifest_content_sha256": hashlib.sha256(manifest_content).hexdigest(),
            "manifest_receipt": manifest_receipt.public(),
            "receipt": receipt,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return StaticBinding(
        manifest_content,
        manifest_receipt,
        receipt,
        hashlib.sha256(encoded).hexdigest(),
    )


def _rebind_static(
    config: ToolchainConfig,
    baseline: StaticBinding,
    phase: str,
) -> StaticBinding:
    try:
        current = _capture_static_binding(config)
    except (BoundaryError, OSError, RuntimeError, UnicodeError) as error:
        raise ConcurrentDriftError(phase, str(error)) from error
    if (
        current.identity_sha256 != baseline.identity_sha256
        or current.manifest_content != baseline.manifest_content
    ):
        raise ConcurrentDriftError(phase, "static-binding-changed")
    return current


def diagnose(
    config: ToolchainConfig,
    *,
    timestamp: Callable[[], str] = _timestamp,
) -> dict[str, object]:
    receipt: dict[str, object] = {
        "command": "diagnose",
        "writes": 0,
        "gcloud_subprocesses": 0,
    }
    try:
        static_started = timestamp()
        baseline = _capture_static_binding(config)
        manifest = normalize_manifest(baseline.manifest_content, config.sdk_root)
        static_finished = timestamp()

        reference_started = timestamp()
        reference = scan_sdk_boundary(
            config.filesystem_root,
            manifest,
            owner_uid=config.owner_uid,
            owner_gid=config.owner_gid,
        )
        reference_finished = timestamp()

        post_reference_started = timestamp()
        post_reference = _rebind_static(config, baseline, "post-reference")
        post_reference_finished = timestamp()

        current_started = timestamp()
        current = scan_sdk_boundary(
            config.filesystem_root,
            manifest,
            owner_uid=config.owner_uid,
            owner_gid=config.owner_gid,
        )
        current_finished = timestamp()

        post_current_started = timestamp()
        post_current = _rebind_static(config, baseline, "post-current")
        post_current_finished = timestamp()

        comparison = compare_scans(
            reference,
            current,
            reference_manifest=baseline.manifest_receipt,
            current_manifest=post_current.manifest_receipt,
        )

        pre_return_started = timestamp()
        pre_return = _rebind_static(config, baseline, "pre-return")
        pre_return_finished = timestamp()
        receipt.update(
            {
                "status": (
                    "PASS"
                    if current.unsafe.count == 0
                    and not comparison.concurrent_drift
                    else "FAIL"
                ),
                "bindings": {
                    "baseline": baseline.public(),
                    "post_reference": post_reference.public(),
                    "post_current": post_current.public(),
                    "pre_return": pre_return.public(),
                },
                "manifest": {
                    "relative_count": len(manifest.relative_paths),
                    "set_sha256": manifest.set_sha256,
                    "reference_receipt": baseline.manifest_receipt.public(),
                    "current_receipt": post_current.manifest_receipt.public(),
                },
                "reference": reference.public(),
                "current": current.public(),
                "concurrent_drift": comparison.concurrent_drift,
                "first_symmetric_diff": comparison.first_symmetric_diff,
                "windows": {
                    "static": [static_started, static_finished],
                    "reference": [reference_started, reference_finished],
                    "post_reference": [
                        post_reference_started,
                        post_reference_finished,
                    ],
                    "current": [current_started, current_finished],
                    "post_current": [
                        post_current_started,
                        post_current_finished,
                    ],
                    "pre_return": [pre_return_started, pre_return_finished],
                },
            }
        )
    except ConcurrentDriftError as error:
        receipt.update(
            {
                "status": "FAIL",
                "reason": "concurrent-drift",
                "concurrent_drift": True,
                "drift_phase": error.phase,
                "first_symmetric_diff": None,
                "error": str(error),
            }
        )
    except (BoundaryError, OSError, RuntimeError, UnicodeError) as error:
        receipt.update(
            {
                "status": "FAIL",
                "error": str(error),
                "reason": (
                    error.reason.value
                    if isinstance(error, BoundaryError)
                    else "toolchain-diagnose-failed"
                ),
            }
        )
    return receipt


def behavior(config: ToolchainConfig) -> dict[str, object]:
    return {
        "command": "behavior",
        "status": "BLOCKED",
        "reason": "behavior-not-authorized-or-implemented",
        "writes": 0,
        "gcloud_subprocesses": 0,
        "boundary_core": "gcp_sdk_boundary",
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("diagnose")
    subcommands.add_parser("behavior")
    args = parser.parse_args(argv)
    config = production_config()
    receipt = diagnose(config) if args.command == "diagnose" else behavior(config)
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0 if receipt["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
