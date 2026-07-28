#!/usr/bin/python3
"""Prepare the frozen real-test WIF source without installing or probing it."""

from __future__ import annotations

import ctypes
import errno
import hashlib
import json
import os
import stat
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable

sys.dont_write_bytecode = True

SCRIPT_DIRECTORY = os.path.dirname(os.path.realpath(__file__))
if SCRIPT_DIRECTORY not in sys.path:
    sys.path.insert(0, SCRIPT_DIRECTORY)

from gcp_sdk_boundary import (
    BoundaryError,
    ManifestSnapshot,
    normalize_manifest,
    scan_sdk_boundary,
)


VERSION = "20260728T062225Z"
PROVIDER = (
    "projects/185789474550/locations/global/workloadIdentityPools/"
    "xingheng-rwa-real-test/providers/rwa-api-x509"
)
AUDIENCE = f"//iam.googleapis.com/{PROVIDER}"
LOGICAL_ROOT = "/run/secrets/gcp-wif"
STAGE = f"/var/lib/xingheng-real-test/gcp-wif-build/{VERSION}"
SOURCE = "/root/xingheng-real-test-wif-source"
AUDIENCE_FILE = "/root/xingheng-real-test-wif-audience"
CERT_NAME = f"leaf-{VERSION}.cert.pem"
KEY_NAME = f"leaf-{VERSION}.key.pem"
GCLOUD_VERSION = "576.0.0"
GCLOUD_COMPONENTS = {
    "Google Cloud SDK": "576.0.0",
    "alpha": "2026.07.10",
    "beta": "2026.07.10",
    "bq": "2.1.34",
    "bundled-python3-unix": "3.14.6",
    "core": "2026.07.10",
    "gcloud-crc32c": "1.0.0",
    "gsutil": "5.37",
    "preview": "2026.07.10",
}
GCLOUD_PATH = "/usr/lib/google-cloud-sdk/bin/gcloud"
DASH_PATH = "/usr/bin/dash"
BUNDLED_PYTHON_PATH = (
    "/usr/lib/google-cloud-sdk/platform/bundledpythonunix/bin/python3.14"
)
SDK_ROOT = "/usr/lib/google-cloud-sdk"
PYTHON_CACHE_PATH = "/root/.xingheng-real-test-gcloud-pycache-d2b1"
GCLOUD_CONFIG_PATH = "/root/.xingheng-real-test-gcloud-config-d2b1"
GCLOUD_PACKAGE = "google-cloud-cli|576.0.0-0|amd64|ii"
DASH_PACKAGE = "dash|0.5.12-2|amd64|ii"
GCLOUD_LIST_LINES = 38256
GCLOUD_LIST_SHA256 = (
    "89a9ad89d55616b6e50230d09fda21dbbb841a2e084e75ed0f2eaf5881ca69c6"
)
GCLOUD_MD5SUMS_LINES = 31498
GCLOUD_MD5SUMS_SHA256 = (
    "1b50bcaa236e3602aeed8aeed59f376a5976f610e36470d4aa75edb058006f37"
)
GCLOUD_SHEBANG = b"#!/bin/sh\n"
SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:mtls"
TOKEN_URL = "https://sts.mtls.googleapis.com/v1/token"
EXPECTED_PUBLIC_KEY_SHA256 = (
    "764d265a2b83f0d2eccd5c46a81bb03a6596e16e8973b128b8295297ad3aaf17"
)
MAX_JSON_BYTES = 64 * 1024
MAX_TOOL_OUTPUT_BYTES = 128 * 1024


class PreparationError(RuntimeError):
    """A fail-closed preparation error safe to summarize without material."""


@dataclass(frozen=True)
class FrozenFile:
    dev: int
    ino: int
    size: int
    sha256: str
    mode: int = 0o400
    nlink: int = 1


@dataclass(frozen=True)
class PrepareConfig:
    filesystem_root: str
    gcloud_path: str
    dash_path: str
    bundled_python_path: str
    sdk_root: str
    pycache_path: str
    gcloud_config_path: str
    dpkg_query_path: str
    dpkg_path: str
    package_list_path: str
    package_md5sums_path: str
    gcloud_uid: int
    gcloud: FrozenFile
    dash: FrozenFile
    bundled_python: FrozenFile
    gcloud_package: str
    dash_package: str
    package_list_lines: int
    package_list_sha256: str
    package_md5sums_lines: int
    package_md5sums_sha256: str
    python_version: str
    sdk_probe_module: str
    gcloud_components: dict[str, str]
    openssl_path: str
    openssl_uid: int
    owner_uid: int
    owner_gid: int
    stage: str
    source: str
    audience_file: str
    key_name: str
    cert_name: str
    stage_dev: int
    stage_ino: int
    key: FrozenFile
    cert: FrozenFile
    public_key_sha256: str
    gcloud_version: str = GCLOUD_VERSION

    def actual(self, absolute_path: str) -> str:
        if not absolute_path.startswith("/"):
            raise PreparationError("configured path is not absolute")
        if self.filesystem_root == "/":
            return absolute_path
        return os.path.join(self.filesystem_root, absolute_path.lstrip("/"))


@dataclass
class CreatedObject:
    parent: str
    name: str
    dev: int
    ino: int
    sha256: str | None


@dataclass(frozen=True)
class FileSnapshot:
    path: str
    dev: int
    ino: int
    size: int
    mode: int
    sha256: str


@dataclass(frozen=True)
class ToolchainBaseline:
    gcloud: FileSnapshot
    dash: FileSnapshot
    bundled_python: FileSnapshot
    dpkg_query: FileSnapshot
    dpkg: FileSnapshot
    sdk_root_dev: int
    sdk_root_ino: int
    sdk_root_mode: int
    sdk_cache_count: int
    sdk_cache_set_sha256: str
    sdk_boundary_count: int
    sdk_boundary_set_sha256: str


@dataclass(frozen=True)
class DirectoryReceipt:
    parent: str
    name: str
    dev: int
    ino: int


RenameNoReplace = Callable[[int, str, str], None]


def production_config() -> PrepareConfig:
    return PrepareConfig(
        filesystem_root="/",
        gcloud_path=GCLOUD_PATH,
        dash_path=DASH_PATH,
        bundled_python_path=BUNDLED_PYTHON_PATH,
        sdk_root=SDK_ROOT,
        pycache_path=PYTHON_CACHE_PATH,
        gcloud_config_path=GCLOUD_CONFIG_PATH,
        dpkg_query_path="/usr/bin/dpkg-query",
        dpkg_path="/usr/bin/dpkg",
        package_list_path="/var/lib/dpkg/info/google-cloud-cli.list",
        package_md5sums_path="/var/lib/dpkg/info/google-cloud-cli.md5sums",
        gcloud_uid=0,
        gcloud=FrozenFile(
            dev=0,
            ino=0,
            size=5962,
            sha256="8628b9f971d07c5e52fd2c6d469ee4a0940c75eb51820d628c3dd068981bd260",
            mode=0o755,
        ),
        dash=FrozenFile(
            dev=0,
            ino=0,
            size=125640,
            sha256="f5adb8bf0100ed0f8c7782ca5f92814e9229525a4b4e0d401cf3bea09ac960a6",
            mode=0o755,
        ),
        bundled_python=FrozenFile(
            dev=0,
            ino=0,
            size=19234856,
            sha256="6fd816d7f83818698781299628960c28abbdd869da5b19bc6d6bf2ce1d965bd4",
            mode=0o755,
        ),
        gcloud_package=GCLOUD_PACKAGE,
        dash_package=DASH_PACKAGE,
        package_list_lines=GCLOUD_LIST_LINES,
        package_list_sha256=GCLOUD_LIST_SHA256,
        package_md5sums_lines=GCLOUD_MD5SUMS_LINES,
        package_md5sums_sha256=GCLOUD_MD5SUMS_SHA256,
        python_version="3.14.6",
        sdk_probe_module="googlecloudsdk.core.config",
        gcloud_components=GCLOUD_COMPONENTS,
        openssl_path="/usr/bin/openssl",
        openssl_uid=0,
        owner_uid=0,
        owner_gid=0,
        stage=STAGE,
        source=SOURCE,
        audience_file=AUDIENCE_FILE,
        key_name=KEY_NAME,
        cert_name=CERT_NAME,
        stage_dev=2049,
        stage_ino=946299,
        key=FrozenFile(
            dev=2049,
            ino=946301,
            size=1704,
            sha256="b995347dc21a46b7f1adec98564eb71109b6c6ea07c88a22fd57222c844a22a8",
        ),
        cert=FrozenFile(
            dev=2049,
            ino=946305,
            size=1879,
            sha256="b0c4ad3a5b72d2294abd6fcf91bf474408b50b91de7393470c6c980de0d6ac35",
        ),
        public_key_sha256=EXPECTED_PUBLIC_KEY_SHA256,
    )


def _validate_fixed_contract(config: PrepareConfig) -> None:
    if config.filesystem_root == "/":
        expected = production_config()
        if config != expected:
            raise PreparationError("production preparation contract is not frozen")
    if (
        os.path.basename(config.stage) != VERSION
        or config.key_name != KEY_NAME
        or config.cert_name != CERT_NAME
        or config.source != SOURCE
        or config.audience_file != AUDIENCE_FILE
    ):
        raise PreparationError("real-test preparation paths are not frozen")
    if config.key_name in {"adc.json", "certificate_config.json"}:
        raise PreparationError("private key name conflicts with configuration")
    if config.cert_name in {"adc.json", "certificate_config.json"}:
        raise PreparationError("certificate name conflicts with configuration")


def _validate_directory(
    stat_result: os.stat_result,
    uid: int,
    gid: int,
    *,
    mode: int | None = None,
) -> None:
    if (
        not stat.S_ISDIR(stat_result.st_mode)
        or stat.S_ISLNK(stat_result.st_mode)
        or stat_result.st_uid != uid
        or stat_result.st_gid != gid
        or stat_result.st_mode & 0o022
        or (mode is not None and stat.S_IMODE(stat_result.st_mode) != mode)
    ):
        raise PreparationError("directory boundary is invalid")


def _open_directory_chain(
    config: PrepareConfig,
    absolute_path: str,
    *,
    final_dev: int | None = None,
    final_ino: int | None = None,
    final_mode: int | None = None,
) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root_fd = os.open(config.filesystem_root, flags)
    try:
        _validate_directory(os.fstat(root_fd), config.owner_uid, config.owner_gid)
        current_fd = root_fd
        for component in [part for part in absolute_path.split("/") if part]:
            next_fd = os.open(component, flags, dir_fd=current_fd)
            if current_fd != root_fd:
                os.close(current_fd)
            current_fd = next_fd
            _validate_directory(os.fstat(current_fd), config.owner_uid, config.owner_gid)
        final = os.fstat(current_fd)
        if (
            (final_dev is not None and final.st_dev != final_dev)
            or (final_ino is not None and final.st_ino != final_ino)
            or (final_mode is not None and stat.S_IMODE(final.st_mode) != final_mode)
        ):
            raise PreparationError("frozen directory receipt changed")
        if current_fd == root_fd:
            root_fd = -1
        return current_fd
    except BaseException:
        if "current_fd" in locals() and current_fd != root_fd:
            os.close(current_fd)
        raise
    finally:
        if root_fd >= 0:
            os.close(root_fd)


def _hash_fd(fd: int) -> str:
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while True:
        chunk = os.read(fd, 64 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    os.lseek(fd, 0, os.SEEK_SET)
    return digest.hexdigest()


def _open_frozen_file(
    parent_fd: int,
    name: str,
    expected: FrozenFile,
    uid: int,
    gid: int,
) -> int:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        opened = os.fstat(fd)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_dev != expected.dev
            or opened.st_ino != expected.ino
            or opened.st_size != expected.size
            or stat.S_IMODE(opened.st_mode) != expected.mode
            or opened.st_uid != uid
            or opened.st_gid != gid
            or opened.st_nlink != expected.nlink
            or _hash_fd(fd) != expected.sha256
        ):
            raise PreparationError("frozen input receipt changed")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _validate_parent_chain(config: PrepareConfig, absolute_path: str) -> None:
    if not absolute_path.startswith("/"):
        raise PreparationError("toolchain path is not absolute")
    current = config.filesystem_root
    _validate_directory(
        os.lstat(current),
        config.owner_uid,
        config.owner_gid,
    )
    for component in [part for part in os.path.dirname(absolute_path).split("/") if part]:
        current = os.path.join(current, component)
        boundary = os.lstat(current)
        _validate_directory(boundary, config.owner_uid, config.owner_gid)


def _validate_regular(
    config: PrepareConfig,
    absolute_path: str,
    uid: int,
    expected: FrozenFile | None = None,
    *,
    executable: bool,
) -> FileSnapshot:
    _validate_parent_chain(config, absolute_path)
    path = config.actual(absolute_path)
    tool = os.lstat(path)
    if (
        not stat.S_ISREG(tool.st_mode)
        or stat.S_ISLNK(tool.st_mode)
        or tool.st_uid != uid
        or tool.st_gid != config.owner_gid
        or tool.st_nlink != 1
        or tool.st_mode & 0o022
        or (executable and not tool.st_mode & 0o100)
    ):
        raise PreparationError("tool binary boundary is invalid")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        digest = _hash_fd(fd)
    finally:
        os.close(fd)
    if (opened.st_dev, opened.st_ino) != (tool.st_dev, tool.st_ino):
        raise PreparationError("tool changed while opening")
    if expected is not None and (
        (expected.dev not in {0, opened.st_dev})
        or (expected.ino not in {0, opened.st_ino})
        or opened.st_size != expected.size
        or stat.S_IMODE(opened.st_mode) != expected.mode
        or opened.st_nlink != expected.nlink
        or digest != expected.sha256
    ):
        raise PreparationError("frozen tool receipt changed")
    return FileSnapshot(
        absolute_path,
        opened.st_dev,
        opened.st_ino,
        opened.st_size,
        stat.S_IMODE(opened.st_mode),
        digest,
    )


def _run_process(
    argv: list[str],
    *,
    env: dict[str, str],
    input_bytes: bytes | None = None,
    pass_fds: tuple[int, ...] = (),
    timeout: int = 60,
) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(
        argv,
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        pass_fds=pass_fds,
        check=False,
        timeout=timeout,
    )
    if len(result.stdout) > MAX_TOOL_OUTPUT_BYTES or len(result.stderr) > MAX_TOOL_OUTPUT_BYTES:
        raise PreparationError("tool output exceeded the audit boundary")
    return result


def _base_env() -> dict[str, str]:
    return {
        "HOME": "/root",
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": "UTC",
    }


def _openssl_env() -> dict[str, str]:
    return {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": "UTC",
    }


def _gcloud_env(config: PrepareConfig) -> dict[str, str]:
    return {
        **_base_env(),
        "CLOUDSDK_PYTHON": config.actual(config.bundled_python_path),
        "CLOUDSDK_CONFIG": config.actual(config.gcloud_config_path),
        "CLOUDSDK_CORE_DISABLE_FILE_LOGGING": "true",
        "CLOUDSDK_CORE_DISABLE_PROMPTS": "1",
        "CLOUDSDK_CORE_DISABLE_USAGE_REPORTING": "true",
        "CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPYCACHEPREFIX": config.actual(config.pycache_path),
    }


def _run_gcloud(
    config: PrepareConfig,
    arguments: list[str],
    *,
    timeout: int = 60,
) -> subprocess.CompletedProcess[bytes]:
    return _run_process(
        [
            config.actual(config.dash_path),
            config.actual(config.gcloud_path),
            *arguments,
        ],
        env=_gcloud_env(config),
        timeout=timeout,
    )


def _read_receipt_file(
    config: PrepareConfig,
    absolute_path: str,
    expected_lines: int,
    expected_sha256: str,
) -> tuple[bytes, set[str]]:
    snapshot = _validate_regular(
        config,
        absolute_path,
        config.owner_uid,
        executable=False,
    )
    if snapshot.sha256 != expected_sha256:
        raise PreparationError("package manifest receipt changed")
    path = config.actual(absolute_path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (snapshot.dev, snapshot.ino):
            raise PreparationError("package manifest changed while opening")
        content = bytearray()
        while True:
            chunk = os.read(fd, 64 * 1024)
            if not chunk:
                break
            content.extend(chunk)
    finally:
        os.close(fd)
    content = bytes(content)
    if hashlib.sha256(content).hexdigest() != expected_sha256:
        raise PreparationError("package manifest changed while reading")
    lines = content.splitlines()
    if len(lines) != expected_lines:
        raise PreparationError("package manifest line count changed")
    return content, {os.fsdecode(line) for line in lines if line}


def _sdk_manifest(
    config: PrepareConfig,
    manifest_content: bytes,
) -> ManifestSnapshot:
    try:
        return normalize_manifest(manifest_content, config.sdk_root)
    except BoundaryError as error:
        raise PreparationError(
            f"SDK manifest boundary is invalid ({error.reason.value})"
        ) from error


def _sdk_cache_baseline(
    config: PrepareConfig,
    manifest: ManifestSnapshot,
) -> tuple[int, str, int, str]:
    try:
        boundary = scan_sdk_boundary(
            config.filesystem_root,
            manifest,
            owner_uid=config.owner_uid,
            owner_gid=config.owner_gid,
        )
    except (BoundaryError, OSError) as error:
        reason = (
            error.reason.value
            if isinstance(error, BoundaryError)
            else "sdk-boundary-open-failed"
        )
        raise PreparationError(f"SDK boundary validation failed ({reason})") from error
    if boundary.unsafe.count:
        first = boundary.first_unsafe
        reason = first.reason.value if first is not None else "sdk-boundary-unsafe"
        raise PreparationError(f"SDK boundary contains an unsafe object ({reason})")
    return (
        boundary.allowed.count,
        boundary.allowed.sha256,
        boundary.all_entries.count,
        boundary.all_entries.sha256,
    )


def _validate_package(
    config: PrepareConfig,
    package: str,
    name: str,
) -> None:
    result = _run_process(
        [
            config.actual(config.dpkg_query_path),
            "-W",
            "-f=${Package}|${Version}|${Architecture}|${db:Status-Abbrev}",
            name,
        ],
        env=_base_env(),
        timeout=20,
    )
    if result.returncode != 0 or result.stdout.decode("ascii").strip() != package:
        raise PreparationError("package receipt changed")


def _validate_toolchain(
    config: PrepareConfig,
    prior: ToolchainBaseline | None = None,
) -> ToolchainBaseline:
    gcloud = _validate_regular(
        config,
        config.gcloud_path,
        config.gcloud_uid,
        config.gcloud,
        executable=True,
    )
    gcloud_fd = os.open(
        config.actual(config.gcloud_path),
        os.O_RDONLY | os.O_NOFOLLOW,
    )
    try:
        opened = os.fstat(gcloud_fd)
        shebang = os.read(gcloud_fd, len(GCLOUD_SHEBANG))
    finally:
        os.close(gcloud_fd)
    if (
        (opened.st_dev, opened.st_ino) != (gcloud.dev, gcloud.ino)
        or shebang != GCLOUD_SHEBANG
    ):
        raise PreparationError("canonical gcloud shebang changed")
    dash = _validate_regular(
        config,
        config.dash_path,
        config.owner_uid,
        config.dash,
        executable=True,
    )
    bundled_python = _validate_regular(
        config,
        config.bundled_python_path,
        config.owner_uid,
        config.bundled_python,
        executable=True,
    )
    dpkg_query = _validate_regular(
        config,
        config.dpkg_query_path,
        config.owner_uid,
        executable=True,
    )
    dpkg = _validate_regular(
        config,
        config.dpkg_path,
        config.owner_uid,
        executable=True,
    )
    _validate_package(config, config.gcloud_package, "google-cloud-cli")
    _validate_package(config, config.dash_package, "dash")
    manifest_content, _ = _read_receipt_file(
        config,
        config.package_list_path,
        config.package_list_lines,
        config.package_list_sha256,
    )
    manifest = _sdk_manifest(config, manifest_content)
    _read_receipt_file(
        config,
        config.package_md5sums_path,
        config.package_md5sums_lines,
        config.package_md5sums_sha256,
    )
    verified = _run_process(
        [config.actual(config.dpkg_path), "--verify", "google-cloud-cli"],
        env=_base_env(),
        timeout=60,
    )
    if verified.returncode != 0 or verified.stdout or verified.stderr:
        raise PreparationError("google-cloud-cli package verification failed")
    cache_count, cache_hash, boundary_count, boundary_hash = _sdk_cache_baseline(
        config,
        manifest,
    )
    sdk_root = os.lstat(config.actual(config.sdk_root))
    baseline = ToolchainBaseline(
        gcloud,
        dash,
        bundled_python,
        dpkg_query,
        dpkg,
        sdk_root.st_dev,
        sdk_root.st_ino,
        stat.S_IMODE(sdk_root.st_mode),
        cache_count,
        cache_hash,
        boundary_count,
        boundary_hash,
    )
    if prior is not None and baseline != prior:
        raise PreparationError("trusted toolchain baseline changed")
    return baseline


def _create_isolation_directory(
    root_fd: int,
    absolute_path: str,
    config: PrepareConfig,
    receipts: list[DirectoryReceipt],
) -> tuple[int, DirectoryReceipt]:
    name = os.path.basename(absolute_path)
    _ensure_missing(root_fd, name)
    os.mkdir(name, 0o700, dir_fd=root_fd)
    os.fsync(root_fd)
    metadata = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
    receipt = DirectoryReceipt("root", name, metadata.st_dev, metadata.st_ino)
    receipts.append(receipt)
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    try:
        opened = os.fstat(fd)
        _validate_directory(opened, config.owner_uid, config.owner_gid, mode=0o700)
        if (opened.st_dev, opened.st_ino) != (receipt.dev, receipt.ino):
            raise PreparationError("isolation directory changed while opening")
    except BaseException:
        os.close(fd)
        raise
    return fd, receipt


def _validate_empty_directory(
    root_fd: int,
    fd: int,
    receipt: DirectoryReceipt,
) -> None:
    opened = os.fstat(fd)
    current = os.stat(receipt.name, dir_fd=root_fd, follow_symlinks=False)
    if (
        (opened.st_dev, opened.st_ino) != (receipt.dev, receipt.ino)
        or (current.st_dev, current.st_ino) != (receipt.dev, receipt.ino)
        or stat.S_IMODE(opened.st_mode) != 0o700
        or stat.S_IMODE(current.st_mode) != 0o700
        or os.listdir(fd)
    ):
        raise PreparationError("isolation directory changed or is not empty")


def _cleanup_isolation(
    root_fd: int | None,
    directory_fd: int | None,
    receipt: DirectoryReceipt | None,
) -> bool:
    if receipt is None:
        return True
    try:
        if root_fd is None:
            return False
        opened_here = directory_fd is None
        if directory_fd is None:
            directory_fd = os.open(
                receipt.name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=root_fd,
            )
        _validate_empty_directory(root_fd, directory_fd, receipt)
        current = os.stat(receipt.name, dir_fd=root_fd, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (receipt.dev, receipt.ino):
            return False
        os.close(directory_fd)
        os.rmdir(receipt.name, dir_fd=root_fd)
        os.fsync(root_fd)
        try:
            os.stat(receipt.name, dir_fd=root_fd, follow_symlinks=False)
        except FileNotFoundError:
            return True
        return False
    except (OSError, PreparationError):
        if "opened_here" in locals() and opened_here and directory_fd is not None:
            try:
                os.close(directory_fd)
            except OSError:
                pass
        return False


def _probe_python_runtime(
    config: PrepareConfig,
    manifest_paths: frozenset[str],
) -> dict[str, str]:
    code = (
        "import importlib,importlib.util,json,os,site,sys;"
        f"sys.path.insert(0,{config.actual(config.sdk_root + '/lib')!r});"
        "m=importlib.import_module(sys.argv[1]);"
        "s=os.path.realpath(m.__file__);"
        "c=importlib.util.cache_from_source(s);"
        "print(json.dumps({'prefix':sys.pycache_prefix,"
        "'dontwrite':sys.dont_write_bytecode,'usersite':site.ENABLE_USER_SITE,"
        "'usersite_path':site.getusersitepackages(),'sys_path':sys.path,"
        "'source':s,'cache':c,'version':'.'.join(map(str,sys.version_info[:3]))}))"
    )
    result = _run_process(
        [
            config.actual(config.bundled_python_path),
            "-c",
            code,
            config.sdk_probe_module,
        ],
        env=_gcloud_env(config),
        timeout=30,
    )
    if result.returncode != 0:
        raise PreparationError("bundled Python isolation probe failed")
    try:
        value = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PreparationError("bundled Python isolation probe is invalid") from error
    expected_prefix = config.actual(config.pycache_path)
    source = value.get("source")
    cache = value.get("cache")
    usersite_path = value.get("usersite_path")
    logical_source = (
        os.path.relpath(
            source,
            os.path.realpath(config.actual(config.sdk_root)),
        ).replace(os.sep, "/")
        if isinstance(source, str)
        else ""
    )
    checks = {
        "prefix": value.get("prefix") == expected_prefix,
        "dontwrite": value.get("dontwrite") is True,
        "usersite": value.get("usersite") is False,
        "usersite-path": usersite_path not in value.get("sys_path", []),
        "version": value.get("version") == config.python_version,
        "module-manifest": logical_source in manifest_paths,
        "cache-path": (
            isinstance(cache, str)
            and os.path.commonpath([expected_prefix, cache]) == expected_prefix
        ),
    }
    failed = [name for name, passed in checks.items() if not passed]
    if failed:
        raise PreparationError(
            f"bundled Python isolation semantics changed: {','.join(failed)}"
        )
    return {"source": logical_source, "cache": cache}


def _validate_gcloud_version(
    config: PrepareConfig,
) -> dict[str, str]:
    result = _run_gcloud(config, ["version", "--format=json"], timeout=20)
    if result.returncode != 0:
        raise PreparationError(
            f"gcloud version validation failed (exit={result.returncode})"
        )
    try:
        value = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PreparationError("gcloud version output is invalid") from error
    if value != config.gcloud_components:
        raise PreparationError("gcloud component exact-set is not frozen")
    return value


def _fd_path(fd: int) -> str:
    if os.path.isdir("/proc/self/fd"):
        return f"/proc/self/fd/{fd}"
    return f"/dev/fd/{fd}"


def _public_key_sha256(config: PrepareConfig, key_fd: int, cert_fd: int) -> str:
    key_result = _run_process(
        [
            config.actual(config.openssl_path),
            "pkey",
            "-in",
            _fd_path(key_fd),
            "-pubout",
            "-outform",
            "DER",
        ],
        env=_openssl_env(),
        pass_fds=(key_fd,),
    )
    if key_result.returncode != 0:
        raise PreparationError("private key public component validation failed")
    cert_result = _run_process(
        [
            config.actual(config.openssl_path),
            "x509",
            "-in",
            _fd_path(cert_fd),
            "-pubkey",
            "-noout",
        ],
        env=_openssl_env(),
        pass_fds=(cert_fd,),
    )
    if cert_result.returncode != 0:
        raise PreparationError("certificate public component validation failed")
    cert_der = _run_process(
        [config.actual(config.openssl_path), "pkey", "-pubin", "-outform", "DER"],
        env=_openssl_env(),
        input_bytes=cert_result.stdout,
    )
    if cert_der.returncode != 0:
        raise PreparationError("certificate public component decoding failed")
    key_hash = hashlib.sha256(key_result.stdout).hexdigest()
    cert_hash = hashlib.sha256(cert_der.stdout).hexdigest()
    if key_hash != cert_hash or key_hash != config.public_key_sha256:
        raise PreparationError("certificate and private key public components differ")
    return key_hash


def _ensure_missing(parent_fd: int, name: str) -> None:
    try:
        os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise PreparationError("output path already exists")


def _write_all(fd: int, content: bytes) -> None:
    remaining = memoryview(content)
    while remaining:
        written = os.write(fd, remaining)
        if written <= 0:
            raise PreparationError("file write did not make progress")
        remaining = remaining[written:]


def _create_from_bytes(
    parent_fd: int,
    parent_label: str,
    name: str,
    content: bytes,
    uid: int,
    gid: int,
    created: list[CreatedObject],
) -> CreatedObject:
    fd = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o400,
        dir_fd=parent_fd,
    )
    opened = os.fstat(fd)
    receipt = CreatedObject(parent_label, name, opened.st_dev, opened.st_ino, None)
    created.append(receipt)
    try:
        os.fchown(fd, uid, gid)
        os.fchmod(fd, 0o400)
        _write_all(fd, content)
        os.fsync(fd)
        opened = os.fstat(fd)
        digest = hashlib.sha256(content).hexdigest()
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_uid != uid
            or opened.st_gid != gid
            or stat.S_IMODE(opened.st_mode) != 0o400
            or opened.st_nlink != 1
            or opened.st_size != len(content)
        ):
            raise PreparationError("created file boundary is invalid")
        receipt.sha256 = digest
        return receipt
    finally:
        os.close(fd)


def _copy_from_fd(
    source_fd: int,
    parent_fd: int,
    parent_label: str,
    name: str,
    expected_sha256: str,
    uid: int,
    gid: int,
    created: list[CreatedObject],
) -> CreatedObject:
    destination_fd = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o400,
        dir_fd=parent_fd,
    )
    opened = os.fstat(destination_fd)
    receipt = CreatedObject(
        parent_label,
        name,
        opened.st_dev,
        opened.st_ino,
        None,
    )
    created.append(receipt)
    digest = hashlib.sha256()
    try:
        os.fchown(destination_fd, uid, gid)
        os.fchmod(destination_fd, 0o400)
        os.lseek(source_fd, 0, os.SEEK_SET)
        while True:
            chunk = os.read(source_fd, 64 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            _write_all(destination_fd, chunk)
        os.lseek(source_fd, 0, os.SEEK_SET)
        os.fsync(destination_fd)
        opened = os.fstat(destination_fd)
        if (
            digest.hexdigest() != expected_sha256
            or not stat.S_ISREG(opened.st_mode)
            or opened.st_uid != uid
            or opened.st_gid != gid
            or stat.S_IMODE(opened.st_mode) != 0o400
            or opened.st_nlink != 1
        ):
            raise PreparationError("copied file boundary is invalid")
        receipt.sha256 = digest.hexdigest()
        return receipt
    finally:
        os.close(destination_fd)


def _rename_noreplace(parent_fd: int, source: str, destination: str) -> None:
    if sys.platform != "linux":
        raise PreparationError("RENAME_NOREPLACE requires Linux")
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise PreparationError("renameat2 is unavailable")
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    if renameat2(
        parent_fd,
        os.fsencode(source),
        parent_fd,
        os.fsencode(destination),
        1,
    ) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), destination)


def _link_noreplace_for_tests(parent_fd: int, source: str, destination: str) -> None:
    os.link(
        source,
        destination,
        src_dir_fd=parent_fd,
        dst_dir_fd=parent_fd,
        follow_symlinks=False,
    )
    os.unlink(source, dir_fd=parent_fd)


def _publish(
    parent_fd: int,
    temporary: CreatedObject,
    final_name: str,
    rename_noreplace: RenameNoReplace,
) -> CreatedObject:
    rename_noreplace(parent_fd, temporary.name, final_name)
    final = os.stat(final_name, dir_fd=parent_fd, follow_symlinks=False)
    if (
        final.st_dev != temporary.dev
        or final.st_ino != temporary.ino
        or not stat.S_ISREG(final.st_mode)
        or final.st_nlink != 1
    ):
        raise PreparationError("published file receipt changed")
    temporary.name = final_name
    os.fsync(parent_fd)
    return temporary


def _read_bounded_json(
    parent_fd: int,
    parent_label: str,
    name: str,
    uid: int,
    gid: int,
    created: list[CreatedObject],
) -> dict[str, object]:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        opened = os.fstat(fd)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_uid != uid
            or opened.st_gid != gid
            or opened.st_nlink != 1
            or opened.st_size < 2
            or opened.st_size > MAX_JSON_BYTES
            or opened.st_mode & 0o077
        ):
            raise PreparationError("generated JSON boundary is invalid")
        content = bytearray()
        while True:
            chunk = os.read(fd, 8192)
            if not chunk:
                break
            content.extend(chunk)
        receipt = CreatedObject(
            parent_label,
            name,
            opened.st_dev,
            opened.st_ino,
            hashlib.sha256(content).hexdigest(),
        )
        existing = next(
            (
                item
                for item in created
                if item.parent == parent_label and item.name == name
            ),
            None,
        )
        if existing is None:
            created.append(receipt)
        elif (existing.dev, existing.ino) != (receipt.dev, receipt.ino):
            raise PreparationError("generated JSON receipt changed")
        else:
            existing.sha256 = receipt.sha256
    finally:
        os.close(fd)
    try:
        value = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PreparationError("generated JSON is invalid") from error
    finally:
        content[:] = b"\0" * len(content)
    if not isinstance(value, dict):
        raise PreparationError("generated JSON root is invalid")
    return value


def _exact_keys(value: object, expected: set[str], label: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != expected:
        raise PreparationError(f"{label} structure is invalid")
    return value


def _validate_generated_json(
    adc: dict[str, object],
    certificate_config: dict[str, object],
    source_path: str,
    cert_name: str,
    key_name: str,
) -> None:
    adc = _exact_keys(
        adc,
        {"type", "audience", "subject_token_type", "token_url", "credential_source"},
        "generated ADC",
    )
    if (
        adc["type"] != "external_account"
        or adc["audience"] != AUDIENCE
        or adc["subject_token_type"] != SUBJECT_TOKEN_TYPE
        or adc["token_url"] != TOKEN_URL
    ):
        raise PreparationError("generated ADC identity contract is invalid")
    credential_source = _exact_keys(
        adc["credential_source"],
        {"certificate"},
        "generated credential source",
    )
    certificate = _exact_keys(
        credential_source["certificate"],
        {"certificate_config_location"},
        "generated certificate source",
    )
    expected_generated_config = os.path.join(
        source_path,
        ".certificate_config.generated.json",
    )
    if certificate["certificate_config_location"] != expected_generated_config:
        raise PreparationError("generated certificate source path is invalid")

    certificate_config = _exact_keys(
        certificate_config,
        {"cert_configs"},
        "generated certificate config",
    )
    cert_configs = _exact_keys(
        certificate_config["cert_configs"],
        {"workload"},
        "generated certificate configs",
    )
    workload = _exact_keys(
        cert_configs["workload"],
        {"cert_path", "key_path"},
        "generated workload config",
    )
    if (
        workload["cert_path"] != os.path.join(source_path, cert_name)
        or workload["key_path"] != os.path.join(source_path, key_name)
    ):
        raise PreparationError("generated workload paths are invalid")


def _safe_json_bytes(value: dict[str, object]) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def _verify_final_file(
    parent_fd: int,
    name: str,
    receipt: CreatedObject,
    uid: int,
    gid: int,
) -> str:
    before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if (
        before.st_dev != receipt.dev
        or before.st_ino != receipt.ino
        or not stat.S_ISREG(before.st_mode)
        or before.st_uid != uid
        or before.st_gid != gid
        or stat.S_IMODE(before.st_mode) != 0o400
        or before.st_nlink != 1
    ):
        raise PreparationError("final file metadata changed")
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise PreparationError("final file changed while opening")
        digest = _hash_fd(fd)
    finally:
        os.close(fd)
    if receipt.sha256 is not None and digest != receipt.sha256:
        raise PreparationError("final file content changed")
    return digest


def _unlink_receipt(parent_fd: int, receipt: CreatedObject) -> None:
    current = os.stat(receipt.name, dir_fd=parent_fd, follow_symlinks=False)
    if (current.st_dev, current.st_ino) != (receipt.dev, receipt.ino):
        raise PreparationError("cleanup receipt mismatch")
    os.unlink(receipt.name, dir_fd=parent_fd)
    os.fsync(parent_fd)


def _capture_generated(
    source_fd: int,
    name: str,
    created: list[CreatedObject],
) -> None:
    if any(item.parent == "source" and item.name == name for item in created):
        return
    try:
        current = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
        raise PreparationError("generated cleanup boundary is invalid")
    created.append(CreatedObject("source", name, current.st_dev, current.st_ino, None))


def _cleanup(
    root_fd: int | None,
    source_fd: int | None,
    source_receipt: tuple[int, int] | None,
    created: list[CreatedObject],
) -> bool:
    try:
        for receipt in reversed(created):
            parent_fd = source_fd if receipt.parent == "source" else root_fd
            if parent_fd is None:
                return False
            try:
                _unlink_receipt(parent_fd, receipt)
            except FileNotFoundError:
                continue
        if root_fd is not None and source_receipt is not None:
            source = os.stat(
                os.path.basename(SOURCE),
                dir_fd=root_fd,
                follow_symlinks=False,
            )
            if (source.st_dev, source.st_ino) != source_receipt:
                return False
            os.rmdir(os.path.basename(SOURCE), dir_fd=root_fd)
            os.fsync(root_fd)
        return True
    except (OSError, PreparationError):
        return False


def prepare_source(
    config: PrepareConfig,
    *,
    require_root: bool = True,
    rename_noreplace: RenameNoReplace = _rename_noreplace,
) -> dict[str, object]:
    _validate_fixed_contract(config)
    if require_root and os.geteuid() != 0:
        raise PreparationError("real-test WIF source preparation requires root")
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise PreparationError("required no-follow flags are unavailable")

    os.umask(0o077)
    stage_fd: int | None = None
    key_fd: int | None = None
    cert_fd: int | None = None
    root_fd: int | None = None
    source_fd: int | None = None
    pycache_fd: int | None = None
    gcloud_config_fd: int | None = None
    source_receipt: tuple[int, int] | None = None
    pycache_receipt: DirectoryReceipt | None = None
    gcloud_config_receipt: DirectoryReceipt | None = None
    isolation_receipts: list[DirectoryReceipt] = []
    created: list[CreatedObject] = []
    source_path = config.actual(config.source)
    generated_names = [
        ".adc.generated.json",
        ".certificate_config.generated.json",
    ]

    try:
        toolchain = _validate_toolchain(config)
        openssl = _validate_regular(
            config,
            config.openssl_path,
            config.openssl_uid,
            executable=True,
        )
        root_fd = _open_directory_chain(config, "/root", final_mode=0o700)
        source_name = os.path.basename(config.source)
        audience_name = os.path.basename(config.audience_file)
        _ensure_missing(root_fd, source_name)
        _ensure_missing(root_fd, audience_name)
        _ensure_missing(root_fd, os.path.basename(config.pycache_path))
        _ensure_missing(root_fd, os.path.basename(config.gcloud_config_path))

        pycache_fd, pycache_receipt = _create_isolation_directory(
            root_fd,
            config.pycache_path,
            config,
            isolation_receipts,
        )
        gcloud_config_fd, gcloud_config_receipt = _create_isolation_directory(
            root_fd,
            config.gcloud_config_path,
            config,
            isolation_receipts,
        )
        manifest_content, _ = _read_receipt_file(
            config,
            config.package_list_path,
            config.package_list_lines,
            config.package_list_sha256,
        )
        manifest = _sdk_manifest(config, manifest_content)
        python_probe = _probe_python_runtime(config, manifest.relative_paths)
        _validate_empty_directory(root_fd, pycache_fd, pycache_receipt)
        _validate_empty_directory(root_fd, gcloud_config_fd, gcloud_config_receipt)
        version_json = _validate_gcloud_version(config)
        _validate_empty_directory(root_fd, pycache_fd, pycache_receipt)
        _validate_empty_directory(root_fd, gcloud_config_fd, gcloud_config_receipt)
        _validate_toolchain(config, toolchain)

        stage_fd = _open_directory_chain(
            config,
            config.stage,
            final_dev=config.stage_dev,
            final_ino=config.stage_ino,
            final_mode=0o700,
        )
        key_fd = _open_frozen_file(
            stage_fd,
            config.key_name,
            config.key,
            config.owner_uid,
            config.owner_gid,
        )
        cert_fd = _open_frozen_file(
            stage_fd,
            config.cert_name,
            config.cert,
            config.owner_uid,
            config.owner_gid,
        )
        if (
            _validate_regular(
                config,
                config.openssl_path,
                config.openssl_uid,
                executable=True,
            )
            != openssl
        ):
            raise PreparationError("OpenSSL tool receipt changed")
        public_key_sha256 = _public_key_sha256(config, key_fd, cert_fd)

        _ensure_missing(root_fd, source_name)
        _ensure_missing(root_fd, audience_name)
        os.mkdir(source_name, 0o700, dir_fd=root_fd)
        os.fsync(root_fd)
        source_before_open = os.stat(
            source_name,
            dir_fd=root_fd,
            follow_symlinks=False,
        )
        source_receipt = (source_before_open.st_dev, source_before_open.st_ino)
        source_fd = os.open(
            source_name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=root_fd,
        )
        source_stat = os.fstat(source_fd)
        _validate_directory(
            source_stat,
            config.owner_uid,
            config.owner_gid,
            mode=0o700,
        )
        if (source_stat.st_dev, source_stat.st_ino) != source_receipt:
            raise PreparationError("source directory changed while opening")

        key_temporary = _copy_from_fd(
            key_fd,
            source_fd,
            "source",
            f".{config.key_name}.d2b1.tmp",
            config.key.sha256,
            config.owner_uid,
            config.owner_gid,
            created,
        )
        key_final = _publish(
            source_fd,
            key_temporary,
            config.key_name,
            rename_noreplace,
        )
        cert_temporary = _copy_from_fd(
            cert_fd,
            source_fd,
            "source",
            f".{config.cert_name}.d2b1.tmp",
            config.cert.sha256,
            config.owner_uid,
            config.owner_gid,
            created,
        )
        cert_final = _publish(
            source_fd,
            cert_temporary,
            config.cert_name,
            rename_noreplace,
        )
        os.close(key_fd)
        key_fd = None
        os.close(cert_fd)
        cert_fd = None

        for generated_name in generated_names:
            _ensure_missing(source_fd, generated_name)
        generated_adc_path = os.path.join(source_path, generated_names[0])
        generated_config_path = os.path.join(source_path, generated_names[1])
        create_arguments = [
            "iam",
            "workload-identity-pools",
            "create-cred-config",
            PROVIDER,
            f"--credential-cert-path={os.path.join(source_path, config.cert_name)}",
            f"--credential-cert-private-key-path={os.path.join(source_path, config.key_name)}",
            f"--credential-cert-configuration-output-file={generated_config_path}",
            f"--output-file={generated_adc_path}",
            "--quiet",
        ]
        if any(
            argument.startswith("--credential-cert-trust-chain-path")
            or argument.startswith("--service-account")
            for argument in create_arguments
        ):
            raise PreparationError("gcloud identity argv is not direct-root")
        create_argv = [
            config.actual(config.dash_path),
            config.actual(config.gcloud_path),
            *create_arguments,
        ]
        create_argv_sha256 = hashlib.sha256(
            b"\0".join(argument.encode("utf-8") for argument in create_argv)
        ).hexdigest()
        generated = _run_gcloud(config, create_arguments)
        for generated_name in generated_names:
            _capture_generated(source_fd, generated_name, created)
        if generated.returncode != 0:
            raise PreparationError("gcloud create-cred-config failed")
        _validate_empty_directory(root_fd, pycache_fd, pycache_receipt)
        _validate_empty_directory(root_fd, gcloud_config_fd, gcloud_config_receipt)
        _validate_toolchain(config, toolchain)
        _validate_gcloud_version(config)
        _validate_empty_directory(root_fd, pycache_fd, pycache_receipt)
        _validate_empty_directory(root_fd, gcloud_config_fd, gcloud_config_receipt)
        _validate_toolchain(config, toolchain)
        if set(os.listdir(source_fd)) != {
            config.key_name,
            config.cert_name,
            *generated_names,
        }:
            raise PreparationError("gcloud created an unexpected source object")

        adc = _read_bounded_json(
            source_fd,
            "source",
            generated_names[0],
            config.owner_uid,
            config.owner_gid,
            created,
        )
        generated_config = _read_bounded_json(
            source_fd,
            "source",
            generated_names[1],
            config.owner_uid,
            config.owner_gid,
            created,
        )
        _validate_generated_json(
            adc,
            generated_config,
            source_path,
            config.cert_name,
            config.key_name,
        )
        for generated_name in reversed(generated_names):
            receipt = next(
                item
                for item in reversed(created)
                if item.parent == "source" and item.name == generated_name
            )
            _unlink_receipt(source_fd, receipt)
            created.remove(receipt)

        final_adc = {
            "type": "external_account",
            "audience": AUDIENCE,
            "subject_token_type": SUBJECT_TOKEN_TYPE,
            "token_url": TOKEN_URL,
            "credential_source": {
                "certificate": {
                    "certificate_config_location": (
                        f"{LOGICAL_ROOT}/certificate_config.json"
                    ),
                },
            },
        }
        final_config = {
            "cert_configs": {
                "workload": {
                    "cert_path": f"{LOGICAL_ROOT}/{config.cert_name}",
                    "key_path": f"{LOGICAL_ROOT}/{config.key_name}",
                },
            },
        }
        adc_temporary = _create_from_bytes(
            source_fd,
            "source",
            ".adc.json.d2b1.tmp",
            _safe_json_bytes(final_adc),
            config.owner_uid,
            config.owner_gid,
            created,
        )
        adc_final = _publish(
            source_fd,
            adc_temporary,
            "adc.json",
            rename_noreplace,
        )
        config_temporary = _create_from_bytes(
            source_fd,
            "source",
            ".certificate_config.json.d2b1.tmp",
            _safe_json_bytes(final_config),
            config.owner_uid,
            config.owner_gid,
            created,
        )
        config_final = _publish(
            source_fd,
            config_temporary,
            "certificate_config.json",
            rename_noreplace,
        )

        audience_temporary = _create_from_bytes(
            root_fd,
            "root",
            ".xingheng-real-test-wif-audience.d2b1.tmp",
            (AUDIENCE + "\n").encode("ascii"),
            config.owner_uid,
            config.owner_gid,
            created,
        )
        audience_final = _publish(
            root_fd,
            audience_temporary,
            audience_name,
            rename_noreplace,
        )

        final_names = {
            "adc.json",
            "certificate_config.json",
            config.cert_name,
            config.key_name,
        }
        actual_names = os.listdir(source_fd)
        if len(actual_names) != 4 or set(actual_names) != final_names:
            raise PreparationError("real-test source exact-set is invalid")
        receipts = {
            item.name: _verify_final_file(
                source_fd if item.parent == "source" else root_fd,
                item.name,
                item,
                config.owner_uid,
                config.owner_gid,
            )
            for item in [key_final, cert_final, adc_final, config_final, audience_final]
        }
        file_receipts: dict[str, dict[str, object]] = {}
        for item in [key_final, cert_final, adc_final, config_final]:
            metadata = os.stat(item.name, dir_fd=source_fd, follow_symlinks=False)
            file_receipts[item.name] = {
                "dev": metadata.st_dev,
                "ino": metadata.st_ino,
                "size": metadata.st_size,
                "mode": "0400",
                "nlink": metadata.st_nlink,
                "sha256": receipts[item.name],
            }
        audience_metadata = os.stat(
            audience_name,
            dir_fd=root_fd,
            follow_symlinks=False,
        )
        verified_adc_fd = os.open("adc.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=source_fd)
        verified_config_fd = os.open(
            "certificate_config.json",
            os.O_RDONLY | os.O_NOFOLLOW,
            dir_fd=source_fd,
        )
        try:
            verified_adc = json.loads(os.read(verified_adc_fd, MAX_JSON_BYTES))
            verified_config = json.loads(os.read(verified_config_fd, MAX_JSON_BYTES))
        finally:
            os.close(verified_adc_fd)
            os.close(verified_config_fd)
        if verified_adc != final_adc or verified_config != final_config:
            raise PreparationError("final JSON schema changed")
        os.fsync(source_fd)
        os.fsync(root_fd)
        if not _cleanup_isolation(
            root_fd,
            gcloud_config_fd,
            gcloud_config_receipt,
        ):
            raise PreparationError("gcloud config isolation cleanup failed")
        gcloud_config_fd = None
        gcloud_config_receipt = None
        if not _cleanup_isolation(root_fd, pycache_fd, pycache_receipt):
            raise PreparationError("Python cache isolation cleanup failed")
        pycache_fd = None
        pycache_receipt = None
        receipt = {
            "status": "prepared-not-installed",
            "environment": "real-test",
            "version": VERSION,
            "provider": PROVIDER,
            "audience_file": {
                "path": config.audience_file,
                "dev": audience_metadata.st_dev,
                "ino": audience_metadata.st_ino,
                "size": audience_metadata.st_size,
                "mode": "0400",
                "nlink": audience_metadata.st_nlink,
                "sha256": receipts[audience_name],
            },
            "source": {
                "path": config.source,
                "dev": source_receipt[0],
                "ino": source_receipt[1],
                "mode": "0700",
                "exact_set": sorted(final_names),
                "files": file_receipts,
            },
            "public_key_der_sha256": public_key_sha256,
            "gcloud": {
                "path": config.gcloud_path,
                "version": config.gcloud_version,
                "components": version_json,
                "dev": toolchain.gcloud.dev,
                "ino": toolchain.gcloud.ino,
                "size": toolchain.gcloud.size,
                "mode": f"{toolchain.gcloud.mode:04o}",
                "sha256": toolchain.gcloud.sha256,
                "dash_path": config.dash_path,
                "dash_dev": toolchain.dash.dev,
                "dash_ino": toolchain.dash.ino,
                "dash_size": toolchain.dash.size,
                "dash_mode": f"{toolchain.dash.mode:04o}",
                "dash_sha256": toolchain.dash.sha256,
                "bundled_python_path": config.bundled_python_path,
                "bundled_python_dev": toolchain.bundled_python.dev,
                "bundled_python_ino": toolchain.bundled_python.ino,
                "bundled_python_size": toolchain.bundled_python.size,
                "bundled_python_mode": f"{toolchain.bundled_python.mode:04o}",
                "bundled_python_sha256": toolchain.bundled_python.sha256,
                "python_probe_source": python_probe["source"],
                "create_argv_sha256": create_argv_sha256,
            },
            "packages": {
                "google_cloud_cli": config.gcloud_package,
                "dash": config.dash_package,
                "list_lines": config.package_list_lines,
                "list_sha256": config.package_list_sha256,
                "md5sums_lines": config.package_md5sums_lines,
                "md5sums_sha256": config.package_md5sums_sha256,
                "dpkg_verify": "clean",
                "dpkg_query": {
                    "path": toolchain.dpkg_query.path,
                    "dev": toolchain.dpkg_query.dev,
                    "ino": toolchain.dpkg_query.ino,
                    "size": toolchain.dpkg_query.size,
                    "mode": f"{toolchain.dpkg_query.mode:04o}",
                    "sha256": toolchain.dpkg_query.sha256,
                },
                "dpkg": {
                    "path": toolchain.dpkg.path,
                    "dev": toolchain.dpkg.dev,
                    "ino": toolchain.dpkg.ino,
                    "size": toolchain.dpkg.size,
                    "mode": f"{toolchain.dpkg.mode:04o}",
                    "sha256": toolchain.dpkg.sha256,
                },
            },
            "sdk_unmanifested_cache": {
                "root": config.sdk_root,
                "root_dev": toolchain.sdk_root_dev,
                "root_ino": toolchain.sdk_root_ino,
                "root_mode": f"{toolchain.sdk_root_mode:04o}",
                "count": toolchain.sdk_cache_count,
                "sorted_set_sha256": toolchain.sdk_cache_set_sha256,
            },
            "sdk_boundary": {
                "count": toolchain.sdk_boundary_count,
                "sorted_set_sha256": toolchain.sdk_boundary_set_sha256,
            },
            "isolation_cleanup": {
                config.gcloud_config_path: "missing",
                config.pycache_path: "missing",
            },
            "openssl_sha256": openssl.sha256,
            "trust_chain": "omitted-direct-root",
            "installed": False,
            "probed": False,
        }
        return receipt
    except BaseException as error:
        if pycache_receipt is None:
            pycache_receipt = next(
                (
                    item
                    for item in isolation_receipts
                    if item.name == os.path.basename(config.pycache_path)
                ),
                None,
            )
        if gcloud_config_receipt is None:
            gcloud_config_receipt = next(
                (
                    item
                    for item in isolation_receipts
                    if item.name == os.path.basename(config.gcloud_config_path)
                ),
                None,
            )
        if source_fd is not None:
            for generated_name in generated_names:
                try:
                    _capture_generated(source_fd, generated_name, created)
                except PreparationError:
                    pass
        cleanup_complete = _cleanup(
            root_fd,
            source_fd,
            source_receipt,
            created,
        )
        gcloud_config_cleanup = _cleanup_isolation(
            root_fd,
            gcloud_config_fd,
            gcloud_config_receipt,
        )
        if gcloud_config_cleanup:
            gcloud_config_fd = None
            gcloud_config_receipt = None
        pycache_cleanup = _cleanup_isolation(
            root_fd,
            pycache_fd,
            pycache_receipt,
        )
        if pycache_cleanup:
            pycache_fd = None
            pycache_receipt = None
        if isinstance(error, PreparationError):
            message = str(error)
        elif isinstance(error, FileExistsError) or (
            isinstance(error, OSError) and error.errno == errno.EEXIST
        ):
            message = "no-replace publication conflict"
        elif isinstance(error, subprocess.TimeoutExpired):
            message = "trusted tool timed out"
        else:
            message = "unexpected preparation failure"
        if not cleanup_complete or not gcloud_config_cleanup or not pycache_cleanup:
            message += "; cleanup stopped at receipt mismatch"
        raise PreparationError(message) from error
    finally:
        for fd in [
            key_fd,
            cert_fd,
            stage_fd,
            source_fd,
            pycache_fd,
            gcloud_config_fd,
            root_fd,
        ]:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass


def main(argv: list[str]) -> int:
    if argv != ["real-test"]:
        print(
            "usage: prepare-real-test-gcp-wif-source.py real-test",
            file=sys.stderr,
        )
        return 2
    if os.geteuid() != 0:
        print("real-test WIF source preparation requires root", file=sys.stderr)
        return 77
    try:
        receipt = prepare_source(production_config())
    except PreparationError as error:
        print(f"real-test WIF source preparation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
