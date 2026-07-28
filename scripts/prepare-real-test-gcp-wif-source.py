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
GCloud_VERSION = "576.0.0"
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
    gcloud_uid: int
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
    gcloud_version: str = GCloud_VERSION

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


RenameNoReplace = Callable[[int, str, str], None]


def production_config() -> PrepareConfig:
    return PrepareConfig(
        filesystem_root="/",
        gcloud_path="/usr/bin/gcloud",
        gcloud_uid=0,
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


def _validate_tool(path: str, uid: int) -> str:
    tool = os.lstat(path)
    if (
        not stat.S_ISREG(tool.st_mode)
        or stat.S_ISLNK(tool.st_mode)
        or tool.st_uid != uid
        or tool.st_nlink != 1
        or tool.st_mode & 0o022
        or not tool.st_mode & 0o100
    ):
        raise PreparationError("tool binary boundary is invalid")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        return _hash_fd(fd)
    finally:
        os.close(fd)


def _run_tool(
    argv: list[str],
    *,
    input_bytes: bytes | None = None,
    pass_fds: tuple[int, ...] = (),
    timeout: int = 60,
) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(
        argv,
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            "HOME": "/root",
            "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "TZ": "UTC",
        },
        pass_fds=pass_fds,
        check=False,
        timeout=timeout,
    )
    if len(result.stdout) > MAX_TOOL_OUTPUT_BYTES or len(result.stderr) > MAX_TOOL_OUTPUT_BYTES:
        raise PreparationError("tool output exceeded the audit boundary")
    return result


def _fd_path(fd: int) -> str:
    if os.path.isdir("/proc/self/fd"):
        return f"/proc/self/fd/{fd}"
    return f"/dev/fd/{fd}"


def _public_key_sha256(config: PrepareConfig, key_fd: int, cert_fd: int) -> str:
    key_result = _run_tool(
        [
            config.openssl_path,
            "pkey",
            "-in",
            _fd_path(key_fd),
            "-pubout",
            "-outform",
            "DER",
        ],
        pass_fds=(key_fd,),
    )
    if key_result.returncode != 0:
        raise PreparationError("private key public component validation failed")
    cert_result = _run_tool(
        [
            config.openssl_path,
            "x509",
            "-in",
            _fd_path(cert_fd),
            "-pubkey",
            "-noout",
        ],
        pass_fds=(cert_fd,),
    )
    if cert_result.returncode != 0:
        raise PreparationError("certificate public component validation failed")
    cert_der = _run_tool(
        [config.openssl_path, "pkey", "-pubin", "-outform", "DER"],
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
    source_receipt: tuple[int, int] | None = None
    created: list[CreatedObject] = []
    source_path = config.actual(config.source)
    generated_names = [
        ".adc.generated.json",
        ".certificate_config.generated.json",
    ]

    try:
        gcloud_sha256 = _validate_tool(config.gcloud_path, config.gcloud_uid)
        openssl_sha256 = _validate_tool(config.openssl_path, config.openssl_uid)
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
        public_key_sha256 = _public_key_sha256(config, key_fd, cert_fd)

        root_fd = _open_directory_chain(config, "/root", final_mode=0o700)
        source_name = os.path.basename(config.source)
        audience_name = os.path.basename(config.audience_file)
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

        version = _run_tool(
            [config.gcloud_path, "version", "--format=json"],
            timeout=20,
        )
        if version.returncode != 0:
            raise PreparationError("gcloud version validation failed")
        try:
            version_json = json.loads(version.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PreparationError("gcloud version output is invalid") from error
        if (
            not isinstance(version_json, dict)
            or version_json.get("Google Cloud SDK") != config.gcloud_version
        ):
            raise PreparationError("gcloud version is not frozen")
        if _validate_tool(config.gcloud_path, config.gcloud_uid) != gcloud_sha256:
            raise PreparationError("gcloud binary changed after version validation")

        for generated_name in generated_names:
            _ensure_missing(source_fd, generated_name)
        generated_adc_path = os.path.join(source_path, generated_names[0])
        generated_config_path = os.path.join(source_path, generated_names[1])
        create_argv = [
            config.gcloud_path,
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
            for argument in create_argv
        ):
            raise PreparationError("gcloud identity argv is not direct-root")
        create_argv_sha256 = hashlib.sha256(
            b"\0".join(argument.encode("utf-8") for argument in create_argv)
        ).hexdigest()
        generated = _run_tool(create_argv)
        for generated_name in generated_names:
            _capture_generated(source_fd, generated_name, created)
        if generated.returncode != 0:
            raise PreparationError("gcloud create-cred-config failed")
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
        if _validate_tool(config.gcloud_path, config.gcloud_uid) != gcloud_sha256:
            raise PreparationError("gcloud binary changed during preparation")
        return {
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
                "sha256": gcloud_sha256,
                "create_argv_sha256": create_argv_sha256,
            },
            "openssl_sha256": openssl_sha256,
            "trust_chain": "omitted-direct-root",
            "installed": False,
            "probed": False,
        }
    except BaseException as error:
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
        if not cleanup_complete:
            message += "; cleanup stopped at receipt mismatch"
        raise PreparationError(message) from error
    finally:
        for fd in [key_fd, cert_fd, stage_fd, source_fd, root_fd]:
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
