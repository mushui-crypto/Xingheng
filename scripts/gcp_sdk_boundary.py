#!/usr/bin/python3
"""Classify a package-managed Google Cloud SDK tree without following entries."""

from __future__ import annotations

import hashlib
import os
import posixpath
import stat
from dataclasses import dataclass
from enum import Enum
from pathlib import PurePosixPath
from typing import Iterable


class BoundaryReason(str, Enum):
    MANIFEST_PRESENT = "manifest-present"
    ALLOWED_PYCACHE_DIRECTORY = "allowed-pycache-directory"
    ALLOWED_PYCACHE_FILE = "allowed-pycache-file"
    MANIFEST_EMPTY = "manifest-empty"
    MANIFEST_NUL = "manifest-nul"
    MANIFEST_NON_ABSOLUTE = "manifest-non-absolute"
    MANIFEST_NOT_CANONICAL = "manifest-not-canonical"
    MANIFEST_OUTSIDE_SDK = "manifest-outside-sdk"
    MANIFEST_DUPLICATE = "manifest-duplicate-canonical"
    MANIFEST_ENTRY_MISSING = "manifest-entry-missing"
    ROOT_CHAIN_UNSAFE = "root-chain-unsafe"
    ENTRY_OWNER = "entry-owner"
    ENTRY_WRITABLE = "entry-group-or-world-writable"
    REGULAR_HARDLINK = "regular-hardlink"
    SPECIAL_OBJECT = "special-object"
    SYMLINK_BROKEN = "symlink-broken"
    SYMLINK_EXTERNAL = "symlink-external"
    UNMANIFESTED_SYMLINK = "unmanifested-symlink"
    UNMANIFESTED_DIRECTORY = "unmanifested-directory"
    UNMANIFESTED_REGULAR = "unmanifested-regular"


class BoundaryError(RuntimeError):
    def __init__(self, reason: BoundaryReason, path: str = "") -> None:
        super().__init__(f"{reason.value}: {path}" if path else reason.value)
        self.reason = reason
        self.path = path


@dataclass(frozen=True)
class FileReceipt:
    path: str
    dev: int
    ino: int
    uid: int
    gid: int
    mode: int
    nlink: int
    size: int
    ctime_ns: int
    sha256: str

    def public(self) -> dict[str, object]:
        return {
            "path": self.path,
            "dev": self.dev,
            "ino": self.ino,
            "uid": self.uid,
            "gid": self.gid,
            "mode": f"{self.mode:04o}",
            "nlink": self.nlink,
            "size": self.size,
            "ctime_ns": self.ctime_ns,
            "sha256": self.sha256,
        }


@dataclass(frozen=True)
class ManifestSnapshot:
    sdk_root: str
    relative_paths: frozenset[str]
    set_sha256: str


@dataclass(frozen=True)
class BoundaryEntry:
    relative_path: str
    object_type: str
    dev: int
    ino: int
    uid: int
    gid: int
    mode: int
    nlink: int
    size: int
    ctime_ns: int
    membership: bool
    raw_target: str | None
    reason: BoundaryReason

    def fingerprint(self) -> bytes:
        metadata = (
            f"dev={self.dev};ino={self.ino};uid={self.uid};gid={self.gid};"
            f"mode={self.mode:04o};nlink={self.nlink};size={self.size};"
            f"ctime_ns={self.ctime_ns};membership={int(self.membership)};"
            f"target={self.raw_target or ''};reason={self.reason.value}"
        )
        return (
            self.relative_path.encode("utf-8")
            + b"\0"
            + self.object_type.encode("ascii")
            + b"\0"
            + metadata.encode("utf-8")
        )

    def public(self) -> dict[str, object]:
        return {
            "relative_path": self.relative_path,
            "type": self.object_type,
            "dev": self.dev,
            "ino": self.ino,
            "uid": self.uid,
            "gid": self.gid,
            "mode": f"{self.mode:04o}",
            "nlink": self.nlink,
            "size": self.size,
            "ctime_ns": self.ctime_ns,
            "membership": self.membership,
            "raw_target": self.raw_target,
            "reason": self.reason.value,
        }


@dataclass(frozen=True)
class BoundarySet:
    count: int
    sha256: str

    def public(self) -> dict[str, object]:
        return {"count": self.count, "sha256": self.sha256}


@dataclass(frozen=True)
class BoundaryScan:
    root: FileReceipt
    entries: tuple[BoundaryEntry, ...]
    manifest_present: BoundarySet
    allowed: BoundarySet
    unsafe: BoundarySet
    external: BoundarySet
    broken: BoundarySet
    all_entries: BoundarySet

    @property
    def first_unsafe(self) -> BoundaryEntry | None:
        return next(
            (
                entry
                for entry in self.entries
                if entry.reason
                not in {
                    BoundaryReason.MANIFEST_PRESENT,
                    BoundaryReason.ALLOWED_PYCACHE_DIRECTORY,
                    BoundaryReason.ALLOWED_PYCACHE_FILE,
                }
            ),
            None,
        )

    def public(self) -> dict[str, object]:
        return {
            "root": self.root.public(),
            "manifest_present": self.manifest_present.public(),
            "allowed": self.allowed.public(),
            "unsafe": self.unsafe.public(),
            "external": self.external.public(),
            "broken": self.broken.public(),
            "all_entries": self.all_entries.public(),
            "first_unsafe": (
                self.first_unsafe.public() if self.first_unsafe is not None else None
            ),
        }


@dataclass(frozen=True)
class BoundaryComparison:
    concurrent_drift: bool
    first_symmetric_diff: dict[str, object] | None


def _digest(parts: Iterable[bytes]) -> str:
    return hashlib.sha256(b"\0".join(sorted(parts))).hexdigest()


def normalize_manifest(
    content: bytes,
    sdk_root: str,
) -> ManifestSnapshot:
    if not sdk_root.startswith("/") or posixpath.normpath(sdk_root) != sdk_root:
        raise BoundaryError(BoundaryReason.MANIFEST_NOT_CANONICAL, sdk_root)
    raw_lines = content.split(b"\n")
    if raw_lines and raw_lines[-1] == b"":
        raw_lines.pop()
    relative_paths: set[str] = set()
    for raw_line in raw_lines:
        if raw_line == b"":
            raise BoundaryError(BoundaryReason.MANIFEST_EMPTY)
        if b"\0" in raw_line:
            raise BoundaryError(BoundaryReason.MANIFEST_NUL)
        try:
            absolute = raw_line.decode("utf-8")
        except UnicodeDecodeError as error:
            raise BoundaryError(BoundaryReason.MANIFEST_NOT_CANONICAL) from error
        if not absolute.startswith("/"):
            raise BoundaryError(BoundaryReason.MANIFEST_NON_ABSOLUTE, absolute)
        if posixpath.normpath(absolute) != absolute or any(
            part in {".", ".."} for part in PurePosixPath(absolute).parts
        ):
            raise BoundaryError(BoundaryReason.MANIFEST_NOT_CANONICAL, absolute)
        prefix = sdk_root + "/"
        if not absolute.startswith(prefix):
            raise BoundaryError(BoundaryReason.MANIFEST_OUTSIDE_SDK, absolute)
        relative = absolute[len(prefix) :]
        if not relative:
            raise BoundaryError(BoundaryReason.MANIFEST_EMPTY, absolute)
        if relative in relative_paths:
            raise BoundaryError(BoundaryReason.MANIFEST_DUPLICATE, relative)
        relative_paths.add(relative)
    encoded = (path.encode("utf-8") for path in relative_paths)
    return ManifestSnapshot(sdk_root, frozenset(relative_paths), _digest(encoded))


def read_file_receipt(path: str) -> tuple[bytes, FileReceipt]:
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise BoundaryError(BoundaryReason.SPECIAL_OBJECT, path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise BoundaryError(BoundaryReason.ROOT_CHAIN_UNSAFE, path)
        content = bytearray()
        digest = hashlib.sha256()
        while True:
            chunk = os.read(fd, 64 * 1024)
            if not chunk:
                break
            content.extend(chunk)
            digest.update(chunk)
    finally:
        os.close(fd)
    after = os.lstat(path)
    if (
        after.st_dev,
        after.st_ino,
        after.st_uid,
        after.st_gid,
        after.st_mode,
        after.st_nlink,
        after.st_size,
        after.st_ctime_ns,
    ) != (
        opened.st_dev,
        opened.st_ino,
        opened.st_uid,
        opened.st_gid,
        opened.st_mode,
        opened.st_nlink,
        opened.st_size,
        opened.st_ctime_ns,
    ):
        raise BoundaryError(BoundaryReason.ROOT_CHAIN_UNSAFE, path)
    return bytes(content), FileReceipt(
        path,
        opened.st_dev,
        opened.st_ino,
        opened.st_uid,
        opened.st_gid,
        stat.S_IMODE(opened.st_mode),
        opened.st_nlink,
        opened.st_size,
        opened.st_ctime_ns,
        digest.hexdigest(),
    )


def _open_sdk_root(
    filesystem_root: str,
    sdk_root: str,
    owner_uid: int,
    owner_gid: int,
) -> tuple[int, FileReceipt, str]:
    root_actual = os.path.realpath(filesystem_root)
    current_fd = os.open(
        root_actual,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
    )
    actual = root_actual
    try:
        opened = os.fstat(current_fd)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or opened.st_uid != owner_uid
            or opened.st_gid != owner_gid
            or opened.st_mode & 0o022
        ):
            raise BoundaryError(BoundaryReason.ROOT_CHAIN_UNSAFE, actual)
        for component in [part for part in sdk_root.split("/") if part]:
            child_fd = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=current_fd,
            )
            os.close(current_fd)
            current_fd = child_fd
            actual = os.path.join(actual, component)
            opened = os.fstat(current_fd)
            if (
                not stat.S_ISDIR(opened.st_mode)
                or opened.st_uid != owner_uid
                or opened.st_gid != owner_gid
                or opened.st_mode & 0o022
            ):
                raise BoundaryError(BoundaryReason.ROOT_CHAIN_UNSAFE, actual)
        opened = os.fstat(current_fd)
        receipt = FileReceipt(
            sdk_root,
            opened.st_dev,
            opened.st_ino,
            opened.st_uid,
            opened.st_gid,
            stat.S_IMODE(opened.st_mode),
            opened.st_nlink,
            opened.st_size,
            opened.st_ctime_ns,
            "",
        )
        return current_fd, receipt, actual
    except BaseException:
        os.close(current_fd)
        raise


def _type(metadata: os.stat_result) -> str:
    if stat.S_ISDIR(metadata.st_mode):
        return "directory"
    if stat.S_ISREG(metadata.st_mode):
        return "regular"
    if stat.S_ISLNK(metadata.st_mode):
        return "symlink"
    return "special"


def _symlink_reason(
    actual_parent: str,
    sdk_actual: str,
    filesystem_actual: str,
    raw_target: str,
) -> BoundaryReason | None:
    target = (
        os.path.join(actual_parent, raw_target)
        if not raw_target.startswith("/")
        else os.path.join(filesystem_actual, raw_target.lstrip("/"))
    )
    resolved = os.path.realpath(target)
    try:
        inside = os.path.commonpath([sdk_actual, resolved]) == sdk_actual
    except ValueError:
        inside = False
    if not inside:
        return BoundaryReason.SYMLINK_EXTERNAL
    if not os.path.exists(resolved):
        return BoundaryReason.SYMLINK_BROKEN
    return None


def _classify(
    relative: str,
    metadata: os.stat_result,
    membership: bool,
    raw_target: str | None,
    symlink_reason: BoundaryReason | None,
    owner_uid: int,
    owner_gid: int,
) -> BoundaryReason:
    object_type = _type(metadata)
    if metadata.st_uid != owner_uid or metadata.st_gid != owner_gid:
        return BoundaryReason.ENTRY_OWNER
    if object_type == "symlink":
        if symlink_reason is not None:
            return symlink_reason
        return (
            BoundaryReason.MANIFEST_PRESENT
            if membership
            else BoundaryReason.UNMANIFESTED_SYMLINK
        )
    if metadata.st_mode & 0o022:
        return BoundaryReason.ENTRY_WRITABLE
    if object_type == "regular" and metadata.st_nlink != 1:
        return BoundaryReason.REGULAR_HARDLINK
    if object_type == "special":
        return BoundaryReason.SPECIAL_OBJECT
    if membership:
        return BoundaryReason.MANIFEST_PRESENT
    name = posixpath.basename(relative)
    parent_name = posixpath.basename(posixpath.dirname(relative))
    if object_type == "directory" and name == "__pycache__":
        return BoundaryReason.ALLOWED_PYCACHE_DIRECTORY
    if (
        object_type == "regular"
        and parent_name == "__pycache__"
        and name.endswith(".pyc")
    ):
        return BoundaryReason.ALLOWED_PYCACHE_FILE
    return (
        BoundaryReason.UNMANIFESTED_DIRECTORY
        if object_type == "directory"
        else BoundaryReason.UNMANIFESTED_REGULAR
    )


def _boundary_set(entries: Iterable[BoundaryEntry]) -> BoundarySet:
    selected = tuple(entries)
    return BoundarySet(len(selected), _digest(entry.fingerprint() for entry in selected))


def scan_sdk_boundary(
    filesystem_root: str,
    manifest: ManifestSnapshot,
    *,
    owner_uid: int = 0,
    owner_gid: int = 0,
) -> BoundaryScan:
    root_fd, root_receipt, sdk_actual = _open_sdk_root(
        filesystem_root,
        manifest.sdk_root,
        owner_uid,
        owner_gid,
    )
    filesystem_actual = os.path.realpath(filesystem_root)
    entries: list[BoundaryEntry] = []
    seen: set[str] = set()
    stack: list[tuple[int, str, str]] = [(root_fd, "", sdk_actual)]
    try:
        while stack:
            parent_fd, parent_relative, actual_parent = stack.pop()
            try:
                with os.scandir(parent_fd) as children:
                    names = sorted(child.name for child in children)
                for name in names:
                    metadata = os.stat(
                        name,
                        dir_fd=parent_fd,
                        follow_symlinks=False,
                    )
                    relative = (
                        posixpath.join(parent_relative, name)
                        if parent_relative
                        else name
                    )
                    membership = relative in manifest.relative_paths
                    seen.add(relative)
                    raw_target = (
                        os.readlink(name, dir_fd=parent_fd)
                        if stat.S_ISLNK(metadata.st_mode)
                        else None
                    )
                    symlink_reason = (
                        _symlink_reason(
                            actual_parent,
                            sdk_actual,
                            filesystem_actual,
                            raw_target,
                        )
                        if raw_target is not None
                        else None
                    )
                    reason = _classify(
                        relative,
                        metadata,
                        membership,
                        raw_target,
                        symlink_reason,
                        owner_uid,
                        owner_gid,
                    )
                    entries.append(
                        BoundaryEntry(
                            relative,
                            _type(metadata),
                            metadata.st_dev,
                            metadata.st_ino,
                            metadata.st_uid,
                            metadata.st_gid,
                            stat.S_IMODE(metadata.st_mode),
                            metadata.st_nlink,
                            metadata.st_size,
                            metadata.st_ctime_ns,
                            membership,
                            raw_target,
                            reason,
                        )
                    )
                    if stat.S_ISDIR(metadata.st_mode):
                        child_fd = os.open(
                            name,
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=parent_fd,
                        )
                        stack.append(
                            (
                                child_fd,
                                relative,
                                os.path.join(actual_parent, name),
                            )
                        )
            finally:
                os.close(parent_fd)
        for missing in sorted(manifest.relative_paths - seen):
            entries.append(
                BoundaryEntry(
                    missing,
                    "missing",
                    -1,
                    -1,
                    -1,
                    -1,
                    0,
                    0,
                    0,
                    0,
                    True,
                    None,
                    BoundaryReason.MANIFEST_ENTRY_MISSING,
                )
            )
    except BaseException:
        for pending_fd, _, _ in stack:
            try:
                os.close(pending_fd)
            except OSError:
                pass
        raise
    entries.sort(key=lambda entry: entry.relative_path)
    manifest_present = [
        entry
        for entry in entries
        if entry.membership and entry.object_type != "missing"
    ]
    allowed = [
        entry
        for entry in entries
        if entry.reason
        in {
            BoundaryReason.ALLOWED_PYCACHE_DIRECTORY,
            BoundaryReason.ALLOWED_PYCACHE_FILE,
        }
    ]
    unsafe = [
        entry
        for entry in entries
        if entry.reason
        not in {
            BoundaryReason.MANIFEST_PRESENT,
            BoundaryReason.ALLOWED_PYCACHE_DIRECTORY,
            BoundaryReason.ALLOWED_PYCACHE_FILE,
        }
    ]
    external = [
        entry
        for entry in entries
        if entry.reason == BoundaryReason.SYMLINK_EXTERNAL
    ]
    broken = [
        entry
        for entry in entries
        if entry.reason == BoundaryReason.SYMLINK_BROKEN
    ]
    return BoundaryScan(
        root_receipt,
        tuple(entries),
        _boundary_set(manifest_present),
        _boundary_set(allowed),
        _boundary_set(unsafe),
        _boundary_set(external),
        _boundary_set(broken),
        _boundary_set(entries),
    )


def compare_scans(
    reference: BoundaryScan,
    current: BoundaryScan,
    *,
    reference_manifest: FileReceipt | None = None,
    current_manifest: FileReceipt | None = None,
) -> BoundaryComparison:
    reference_map = {
        entry.relative_path: entry.fingerprint() for entry in reference.entries
    }
    current_map = {entry.relative_path: entry.fingerprint() for entry in current.entries}
    first_diff = None
    for path in sorted(set(reference_map) | set(current_map)):
        if reference_map.get(path) != current_map.get(path):
            first_diff = {
                "relative_path": path,
                "reference": hashlib.sha256(
                    reference_map.get(path, b"missing")
                ).hexdigest(),
                "current": hashlib.sha256(
                    current_map.get(path, b"missing")
                ).hexdigest(),
            }
            break
    manifest_changed = (
        reference_manifest is not None
        and current_manifest is not None
        and reference_manifest != current_manifest
    )
    root_changed = reference.root != current.root
    return BoundaryComparison(
        manifest_changed
        or root_changed
        or reference.all_entries != current.all_entries,
        first_diff,
    )
