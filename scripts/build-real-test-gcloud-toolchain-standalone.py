#!/usr/bin/python3
"""Build the deterministic real-test gcloud toolchain stdin artifact."""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


SOURCE_COMMIT = "be83c732aa574bca7898fd31cf200024804ac049"
OUTPUT_NAME = "verify-real-test-gcloud-toolchain-standalone.py"


@dataclass(frozen=True)
class EmbeddedSource:
    label: str
    path: str
    blob: str
    size: int
    sha256: str


@dataclass(frozen=True)
class StartupContract:
    python_prefix: str
    initial_sys_path: tuple[str, str, str]
    active_sys_path: tuple[str, str]
    environment: tuple[tuple[str, str], ...]
    manifest_path: str
    trusted_uids: tuple[int, ...] = (0,)
    trusted_gids: tuple[int, ...] = (0,)
    forbidden_write_mask: int = 0o022


SOURCES = (
    EmbeddedSource(
        "CORE",
        "scripts/gcp_sdk_boundary.py",
        "81d49151884b882bda05557d77362bcfa97603e1",
        19631,
        "cc415b7a139f0af7d140c279ca55d873b03e534684d22d1d86a7d818ba31fd57",
    ),
    EmbeddedSource(
        "VERIFIER",
        "scripts/verify-real-test-gcloud-toolchain.py",
        "c7ca6fe40043590307b6b038e2e21bbf5c42ec26",
        15607,
        "06349ed2315825ac62e832b7015551af6f16e85227a136e81dc0d5275b8bd203",
    ),
)

PRODUCTION_CONTRACT = StartupContract(
    python_prefix="/usr/lib/google-cloud-sdk/platform/bundledpythonunix",
    initial_sys_path=(
        "/usr/lib/google-cloud-sdk/platform/bundledpythonunix/"
        "lib/python314.zip",
        "/usr/lib/google-cloud-sdk/platform/bundledpythonunix/"
        "lib/python3.14",
        "/usr/lib/google-cloud-sdk/platform/bundledpythonunix/"
        "lib/python3.14/lib-dynload",
    ),
    active_sys_path=(
        "/usr/lib/google-cloud-sdk/platform/bundledpythonunix/"
        "lib/python3.14",
        "/usr/lib/google-cloud-sdk/platform/bundledpythonunix/"
        "lib/python3.14/lib-dynload",
    ),
    environment=(("LANG", "C"), ("LC_ALL", "C"), ("TZ", "UTC")),
    manifest_path="/var/lib/dpkg/info/google-cloud-cli.list",
)


def _git(repo_root: Path, *arguments: str) -> bytes:
    result = subprocess.run(
        ["/usr/bin/git", "-C", str(repo_root), *arguments],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
            "HOME": str(repo_root),
            "PATH": "/usr/bin:/bin",
            "LANG": "C",
            "LC_ALL": "C",
            "TMPDIR": "/tmp",
        },
        check=False,
    )
    if result.returncode != 0 or result.stderr:
        raise RuntimeError("trusted git blob read failed")
    return result.stdout


def _git_blob_oid(content: bytes) -> str:
    digest = hashlib.sha1()
    digest.update(f"blob {len(content)}\0".encode("ascii"))
    digest.update(content)
    return digest.hexdigest()


def _trusted_sources(repo_root: Path) -> dict[str, bytes]:
    values: dict[str, bytes] = {}
    for source in SOURCES:
        resolved = _git(
            repo_root,
            "rev-parse",
            f"{SOURCE_COMMIT}:{source.path}",
        ).decode("ascii").strip()
        if resolved != source.blob:
            raise RuntimeError("source commit blob mapping drift")
        content = _git(repo_root, "cat-file", "blob", source.blob)
        if (
            len(content) != source.size
            or hashlib.sha256(content).hexdigest() != source.sha256
            or _git_blob_oid(content) != source.blob
        ):
            raise RuntimeError("trusted source blob identity drift")
        values[source.label] = content
    return values


def _hex_literal(content: bytes) -> str:
    encoded = content.hex()
    lines = [encoded[index : index + 96] for index in range(0, len(encoded), 96)]
    return "\n".join(f'    "{line}"' for line in lines)


def build_artifact(
    repo_root: Path | None = None,
    *,
    contract: StartupContract = PRODUCTION_CONTRACT,
) -> bytes:
    root = repo_root or Path(__file__).resolve().parents[1]
    sources = _trusted_sources(root)
    artifact = f'''#!/usr/bin/python3
"""Trusted, self-contained real-test gcloud toolchain read-only diagnose."""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

SOURCE_COMMIT = "{SOURCE_COMMIT}"
TRUSTED_SOURCE_COMMIT = "{SOURCE_COMMIT}"
CORE_SIZE = {SOURCES[0].size}
CORE_SHA256 = "{SOURCES[0].sha256}"
CORE_BLOB = "{SOURCES[0].blob}"
VERIFIER_SIZE = {SOURCES[1].size}
VERIFIER_SHA256 = "{SOURCES[1].sha256}"
VERIFIER_BLOB = "{SOURCES[1].blob}"

CORE_HEX = (
{_hex_literal(sources["CORE"])}
)
VERIFIER_HEX = (
{_hex_literal(sources["VERIFIER"])}
)

_CORE_FILENAME = "<trusted:{SOURCE_COMMIT}:gcp_sdk_boundary.py>"
_VERIFIER_FILENAME = (
    "<trusted:{SOURCE_COMMIT}:verify-real-test-gcloud-toolchain.py>"
)
_VERIFIER_MODULE_NAME = "_xingheng_real_test_gcloud_toolchain_verifier"

_PYTHON_PREFIX = {contract.python_prefix!r}
_INITIAL_SYS_PATH = {contract.initial_sys_path!r}
_ACTIVE_SYS_PATH = {contract.active_sys_path!r}
_EXPECTED_ENVIRONMENT = {contract.environment!r}
_PACKAGE_MANIFEST = {contract.manifest_path!r}
_TRUSTED_UIDS = {contract.trusted_uids!r}
_TRUSTED_GIDS = {contract.trusted_gids!r}
_FORBIDDEN_WRITE_MASK = {contract.forbidden_write_mask!r}
_MISSING_STDLIB_ZIP = _INITIAL_SYS_PATH[0]
_STDLIB_DIRECTORY = _ACTIVE_SYS_PATH[0]
_DYNLIB_DIRECTORY = _ACTIVE_SYS_PATH[1]
_POSIX = sys.modules.get("posix")

_S_IFMT = 0o170000
_S_IFDIR = 0o040000
_S_IFREG = 0o100000

hashlib = None
importlib_machinery = None
json = None
types = None


class _IdentityError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _early_receipt(reason: str) -> int:
    sys.stdout.write(
        '{{"command":"diagnose","gcloud_subprocesses":0,'
        f'"reason":"{{reason}}","status":"FAIL","writes":0}}}}\\n'
    )
    return 1


def _metadata(value: object) -> tuple[int, ...]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_uid,
        value.st_gid,
        value.st_mode,
        value.st_nlink,
        value.st_size,
        value.st_ctime_ns,
    )


def _validate_metadata(
    value: object,
    object_type: int,
    reason: str,
    *,
    nlink_one: bool = False,
) -> None:
    if (
        value.st_mode & _S_IFMT != object_type
        or value.st_uid not in _TRUSTED_UIDS
        or value.st_gid not in _TRUSTED_GIDS
        or value.st_mode & _FORBIDDEN_WRITE_MASK
        or (nlink_one and value.st_nlink != 1)
    ):
        raise _IdentityError(reason)


def _open_directory_chain(
    path: str,
) -> tuple[int, tuple[tuple[int, ...], ...]]:
    if (
        not path.startswith("/")
        or path == "/"
        or "//" in path
        or any(part in ("", ".", "..") for part in path.split("/")[1:])
    ):
        raise _IdentityError("standalone-startup-path-boundary")
    if _POSIX is None or getattr(_POSIX, "__spec__", None) is None:
        raise _IdentityError("standalone-startup-runtime")
    if _POSIX.__spec__.origin != "built-in":
        raise _IdentityError("standalone-startup-runtime")
    flags = (
        _POSIX.O_RDONLY
        | _POSIX.O_DIRECTORY
        | _POSIX.O_NOFOLLOW
        | _POSIX.O_CLOEXEC
    )
    current = _POSIX.open("/", flags)
    receipts: list[tuple[int, ...]] = []
    try:
        root = _POSIX.fstat(current)
        _validate_metadata(
            root,
            _S_IFDIR,
            "standalone-startup-path-boundary",
        )
        receipts.append(_metadata(root))
        for component in path.split("/")[1:]:
            child = _POSIX.open(component, flags, dir_fd=current)
            try:
                opened = _POSIX.fstat(child)
                _validate_metadata(
                    opened,
                    _S_IFDIR,
                    "standalone-startup-path-boundary",
                )
            except BaseException:
                _POSIX.close(child)
                raise
            _POSIX.close(current)
            current = child
            receipts.append(_metadata(opened))
        return current, tuple(receipts)
    except BaseException as error:
        _POSIX.close(current)
        if isinstance(error, _IdentityError):
            raise
        raise _IdentityError(
            "standalone-startup-path-boundary"
        ) from error


def _read_manifest(
) -> tuple[tuple[tuple[int, ...], ...], tuple[int, ...], bytes]:
    parent, separator, basename = _PACKAGE_MANIFEST.rpartition("/")
    if not separator or not basename:
        raise _IdentityError("standalone-startup-manifest")
    parent_fd, parent_receipts = _open_directory_chain(parent)
    descriptor = -1
    try:
        descriptor = _POSIX.open(
            basename,
            _POSIX.O_RDONLY | _POSIX.O_NOFOLLOW | _POSIX.O_CLOEXEC,
            dir_fd=parent_fd,
        )
        opened = _POSIX.fstat(descriptor)
        _validate_metadata(
            opened,
            _S_IFREG,
            "standalone-startup-manifest",
            nlink_one=True,
        )
        chunks: list[bytes] = []
        while True:
            chunk = _POSIX.read(descriptor, 64 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        after = _POSIX.fstat(descriptor)
        if _metadata(after) != _metadata(opened):
            raise _IdentityError("standalone-startup-manifest")
        lexical = _POSIX.stat(
            basename,
            dir_fd=parent_fd,
            follow_symlinks=False,
        )
        if _metadata(lexical) != _metadata(opened):
            raise _IdentityError("standalone-startup-manifest")
        content = b"".join(chunks)
        expected = {{
            _STDLIB_DIRECTORY.encode("ascii"),
            _DYNLIB_DIRECTORY.encode("ascii"),
        }}
        if b"\\0" in content or not expected.issubset(
            set(content.splitlines())
        ):
            raise _IdentityError("standalone-startup-manifest")
        return parent_receipts, _metadata(opened), content
    except BaseException as error:
        if isinstance(error, _IdentityError):
            raise
        raise _IdentityError("standalone-startup-manifest") from error
    finally:
        if descriptor >= 0:
            _POSIX.close(descriptor)
        _POSIX.close(parent_fd)


def _directory_receipt(path: str) -> tuple[tuple[int, ...], ...]:
    descriptor, receipts = _open_directory_chain(path)
    _POSIX.close(descriptor)
    return receipts


def _missing_zip_receipt() -> tuple[tuple[int, ...], ...]:
    parent, separator, basename = _MISSING_STDLIB_ZIP.rpartition("/")
    if not separator or not basename:
        raise _IdentityError("standalone-startup-zip-slot")
    parent_fd, receipts = _open_directory_chain(parent)
    try:
        try:
            _POSIX.stat(
                basename,
                dir_fd=parent_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError as error:
            if error.errno == 2:
                return receipts
            raise _IdentityError(
                "standalone-startup-zip-slot"
            ) from error
        except BaseException as error:
            raise _IdentityError(
                "standalone-startup-zip-slot"
            ) from error
        raise _IdentityError("standalone-startup-zip-slot")
    finally:
        _POSIX.close(parent_fd)


def _startup_scalar_binding(
    expected_sys_path: tuple[str, ...],
    *,
    initial: bool,
) -> tuple[object, ...]:
    if getattr(sys, "__spec__", None) is None:
        raise _IdentityError("standalone-startup-runtime")
    if sys.__spec__.origin != "built-in":
        raise _IdentityError("standalone-startup-runtime")
    expected_flags = (1, 1, 1, 1, True)
    actual_flags = (
        sys.flags.isolated,
        sys.flags.ignore_environment,
        sys.flags.no_user_site,
        sys.flags.no_site,
        sys.flags.safe_path,
    )
    if sys.argv != ["-", "diagnose"]:
        raise _IdentityError("standalone-startup-argv")
    if actual_flags != expected_flags or not sys.flags.dont_write_bytecode:
        raise _IdentityError("standalone-startup-flags")
    expected_environment = {{
        key.encode("ascii"): value.encode("ascii")
        for key, value in _EXPECTED_ENVIRONMENT
    }}
    if dict(_POSIX.environ) != expected_environment:
        raise _IdentityError("standalone-startup-environment")
    if (
        sys.prefix != _PYTHON_PREFIX
        or sys.base_prefix != _PYTHON_PREFIX
        or sys.exec_prefix != _PYTHON_PREFIX
    ):
        raise _IdentityError("standalone-startup-prefix")
    if tuple(sys.path) != expected_sys_path:
        raise _IdentityError("standalone-startup-sys-path")
    if any(
        name in sys.modules
        for name in ("site", "sitecustomize", "usercustomize")
    ):
        raise _IdentityError("standalone-startup-site")
    if not initial and _MISSING_STDLIB_ZIP in sys.path_importer_cache:
        raise _IdentityError("standalone-startup-importer-cache")
    return (
        tuple(sys.argv),
        actual_flags,
        tuple(sorted(_POSIX.environ.items())),
        sys.prefix,
        sys.base_prefix,
        sys.exec_prefix,
        tuple(sys.path),
        _MISSING_STDLIB_ZIP not in sys.path_importer_cache,
    )


def _filesystem_binding() -> tuple[object, ...]:
    return (
        _missing_zip_receipt(),
        _directory_receipt(_STDLIB_DIRECTORY),
        _directory_receipt(_DYNLIB_DIRECTORY),
        _read_manifest(),
    )


def _capture_startup_binding(
    expected_sys_path: tuple[str, ...],
    *,
    initial: bool,
) -> tuple[object, ...]:
    return (
        _startup_scalar_binding(expected_sys_path, initial=initial),
        _filesystem_binding(),
    )


def _activate_trusted_import_paths() -> None:
    if tuple(sys.path) != _INITIAL_SYS_PATH:
        raise _IdentityError("standalone-startup-sys-path")
    sys.path[:] = list(_ACTIVE_SYS_PATH)
    sys.path_importer_cache.pop(_MISSING_STDLIB_ZIP, None)


def _load_runtime_modules() -> None:
    global hashlib, importlib_machinery, json, types
    hashlib = __import__("hashlib")
    importlib_machinery = __import__(
        "importlib.machinery",
        fromlist=("machinery",),
    )
    json = __import__("json")
    types = __import__("types")


def _require_active_binding(
    trusted_binding: tuple[object, ...],
    reason: str,
) -> None:
    try:
        current_binding = _capture_startup_binding(
            _ACTIVE_SYS_PATH,
            initial=False,
        )
    except BaseException as error:
        raise _IdentityError(reason) from error
    if current_binding != trusted_binding:
        raise _IdentityError(reason)


def _blob_oid(content: bytes) -> str:
    digest = hashlib.sha1()
    digest.update(f"blob {{len(content)}}\\0".encode("ascii"))
    digest.update(content)
    return digest.hexdigest()


def _validate(
    label: str,
    content: bytes,
    expected_size: int,
    expected_sha256: str,
    expected_blob: str,
) -> None:
    if (
        len(content) != expected_size
        or hashlib.sha256(content).hexdigest() != expected_sha256
        or _blob_oid(content) != expected_blob
    ):
        raise _IdentityError(f"{{label}}-identity")


def _module(name: str, filename: str) -> types.ModuleType:
    value = types.ModuleType(name)
    value.__file__ = filename
    value.__package__ = ""
    value.__loader__ = None
    value.__spec__ = importlib_machinery.ModuleSpec(
        name,
        loader=None,
        origin=filename,
    )
    return value


def _load_verified_modules() -> types.ModuleType:
    if SOURCE_COMMIT != TRUSTED_SOURCE_COMMIT:
        raise _IdentityError("source-commit-identity")
    try:
        core_source = bytes.fromhex(CORE_HEX)
        verifier_source = bytes.fromhex(VERIFIER_HEX)
    except ValueError as error:
        raise _IdentityError("inner-encoding") from error
    _validate("core", core_source, CORE_SIZE, CORE_SHA256, CORE_BLOB)
    _validate(
        "verifier",
        verifier_source,
        VERIFIER_SIZE,
        VERIFIER_SHA256,
        VERIFIER_BLOB,
    )

    core = _module("gcp_sdk_boundary", _CORE_FILENAME)
    sys.modules["gcp_sdk_boundary"] = core
    exec(compile(core_source, _CORE_FILENAME, "exec"), core.__dict__)

    verifier = _module(_VERIFIER_MODULE_NAME, _VERIFIER_FILENAME)
    sys.modules[_VERIFIER_MODULE_NAME] = verifier
    exec(
        compile(verifier_source, _VERIFIER_FILENAME, "exec"),
        verifier.__dict__,
    )
    return verifier


def _loader_receipt(reason: str) -> int:
    print(
        json.dumps(
            {{
                "command": "diagnose",
                "gcloud_subprocesses": 0,
                "reason": reason,
                "status": "FAIL",
                "writes": 0,
            }},
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return 1


def _main() -> int:
    if sys.argv[1:] != ["diagnose"]:
        return _early_receipt("standalone-argv-invalid")
    try:
        _capture_startup_binding(_INITIAL_SYS_PATH, initial=True)
        _activate_trusted_import_paths()
        trusted_binding = _capture_startup_binding(
            _ACTIVE_SYS_PATH,
            initial=False,
        )
        _load_runtime_modules()
        verifier = _load_verified_modules()
        _require_active_binding(
            trusted_binding,
            "standalone-startup-post-load-drift",
        )
    except _IdentityError as error:
        return _early_receipt(error.reason)
    except BaseException:
        return _early_receipt("standalone-loader-failed")
    try:
        receipt = verifier.diagnose(verifier.production_config())
        _require_active_binding(
            trusted_binding,
            "standalone-startup-pre-exit-drift",
        )
        print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
        return 0 if receipt.get("status") == "PASS" else 1
    except _IdentityError as error:
        return _loader_receipt(error.reason)
    except BaseException:
        return _loader_receipt("standalone-verifier-failed")


if __name__ == "__main__":
    raise SystemExit(_main())
'''
    return artifact.encode("ascii")


def main(argv: list[str]) -> int:
    if argv:
        raise SystemExit(
            "usage: build-real-test-gcloud-toolchain-standalone.py"
        )
    repo_root = Path(__file__).resolve().parents[1]
    target = Path(__file__).resolve().parent / OUTPUT_NAME
    content = build_artifact(repo_root)
    target.write_bytes(content)
    os.chmod(target, 0o755)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
