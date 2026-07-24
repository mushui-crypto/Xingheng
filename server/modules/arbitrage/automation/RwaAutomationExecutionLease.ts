import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { RWA_AUTOMATION_RUNTIME_GID, RWA_AUTOMATION_RUNTIME_UID } from "./GcpWifCredentialConfig";

export const RWA_AUTOMATION_EXECUTION_MODE = "single-host";
export const RWA_AUTOMATION_LOCK_ROOT = "/app/rwa-automation-lock";
export const RWA_AUTOMATION_LOCK_PATH = `${RWA_AUTOMATION_LOCK_ROOT}/operation.lock`;

const rejectedFileSystems = new Set([
  "9p",
  "ceph",
  "cifs",
  "fuse",
  "fuseblk",
  "glusterfs",
  "nfs",
  "nfs4",
  "smb3",
]);

export type RwaAutomationExecutionLeaseOptions = {
  production?: boolean;
  root?: string;
  path?: string;
  expectedUid?: number;
  expectedGid?: number;
  expectedRootUid?: number;
  expectedRootGid?: number;
  runtimeUid?: number;
  runtimeGid?: number;
  mountInfo?: string;
  acquireFd?: (fd: number) => Promise<boolean>;
};

export class RwaAutomationExecutionLeaseError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

export class RwaAutomationExecutionLease {
  private descriptor: number | null = null;
  private device: bigint | null = null;
  private inode: bigint | null = null;
  private boundary: {
    production: boolean;
    root: string;
    path: string;
    expectedUid: number;
    expectedGid: number;
    expectedRootUid: number;
    expectedRootGid: number;
    mountInfo?: string;
  } | null = null;

  private constructor(private readonly options: RwaAutomationExecutionLeaseOptions) {}

  static async acquire(options: RwaAutomationExecutionLeaseOptions = {}) {
    const lease = new RwaAutomationExecutionLease(options);
    await lease.acquire();
    return lease;
  }

  assertHeld() {
    if (this.descriptor === null || this.device === null || this.inode === null || !this.boundary) {
      throw lost();
    }
    try {
      const boundary = this.boundary;
      validateMount(boundary.root, boundary.production, boundary.mountInfo);
      validateRoot(
        boundary.root,
        boundary.expectedRootUid,
        boundary.expectedRootGid,
        boundary.production ? 0o555 : 0o700,
      );
      const link = lstatSync(boundary.path);
      const real = realpathSync(boundary.path);
      const pathMetadata = statSync(real, { bigint: true });
      const metadata = fstatSync(this.descriptor, { bigint: true });
      if (
        link.isSymbolicLink()
        || real !== boundary.path
        || !pathMetadata.isFile()
        || pathMetadata.nlink !== 1n
        || pathMetadata.uid !== BigInt(boundary.expectedUid)
        || pathMetadata.gid !== BigInt(boundary.expectedGid)
        || (pathMetadata.mode & 0o777n) !== 0o600n
        || pathMetadata.dev !== metadata.dev
        || pathMetadata.ino !== metadata.ino
        || !metadata.isFile()
        || metadata.nlink !== 1n
        || metadata.dev !== this.device
        || metadata.ino !== this.inode
      ) {
        throw lost();
      }
    } catch (error) {
      if (error instanceof RwaAutomationExecutionLeaseError) throw error;
      throw lost();
    }
  }

  release() {
    if (this.descriptor === null) return;
    const descriptor = this.descriptor;
    this.descriptor = null;
    this.device = null;
    this.inode = null;
    this.boundary = null;
    closeSync(descriptor);
  }

  private async acquire() {
    const production = this.options.production ?? process.env.NODE_ENV === "production";
    const root = resolve(this.options.root ?? RWA_AUTOMATION_LOCK_ROOT);
    const path = resolve(this.options.path ?? RWA_AUTOMATION_LOCK_PATH);
    const expectedUid = production
      ? RWA_AUTOMATION_RUNTIME_UID
      : this.options.expectedUid ?? process.getuid?.() ?? -1;
    const expectedGid = production
      ? RWA_AUTOMATION_RUNTIME_GID
      : this.options.expectedGid ?? process.getgid?.() ?? -1;
    const expectedRootUid = production ? 0 : this.options.expectedRootUid ?? expectedUid;
    const expectedRootGid = production ? 0 : this.options.expectedRootGid ?? expectedGid;
    const runtimeUid = this.options.runtimeUid ?? process.getuid?.();
    const runtimeGid = this.options.runtimeGid ?? process.getgid?.();

    if (
      production
      && (
        root !== RWA_AUTOMATION_LOCK_ROOT
        || path !== RWA_AUTOMATION_LOCK_PATH
        || process.env.RWA_AUTOMATION_EXECUTION_MODE !== RWA_AUTOMATION_EXECUTION_MODE
        || runtimeUid !== RWA_AUTOMATION_RUNTIME_UID
        || runtimeGid !== RWA_AUTOMATION_RUNTIME_GID
      )
    ) {
      throw topologyInvalid();
    }
    if (path !== resolve(root, "operation.lock")) throw topologyInvalid();

    validateMount(root, production, this.options.mountInfo);
    validateRoot(root, expectedRootUid, expectedRootGid, production ? 0o555 : 0o700);
    const descriptor = openLockFile(path, expectedUid, expectedGid, !production);
    try {
      const acquired = await (this.options.acquireFd ?? acquireWithFlock)(descriptor);
      if (!acquired) throw unavailable();
      const metadata = fstatSync(descriptor, { bigint: true });
      if (!metadata.isFile() || metadata.nlink !== 1n) throw topologyInvalid();
      this.descriptor = descriptor;
      this.device = metadata.dev;
      this.inode = metadata.ino;
      this.boundary = {
        production,
        root,
        path,
        expectedUid,
        expectedGid,
        expectedRootUid,
        expectedRootGid,
        mountInfo: this.options.mountInfo,
      };
      this.assertHeld();
    } catch (error) {
      closeSync(descriptor);
      if (error instanceof RwaAutomationExecutionLeaseError) throw error;
      throw unavailable();
    }
  }
}

function validateRoot(root: string, uid: number, gid: number, mode: number) {
  try {
    const link = lstatSync(root);
    const real = realpathSync(root);
    const metadata = statSync(real);
    if (
      link.isSymbolicLink()
      || real !== root
      || !metadata.isDirectory()
      || metadata.uid !== uid
      || metadata.gid !== gid
      || (metadata.mode & 0o777) !== mode
    ) {
      throw topologyInvalid();
    }
  } catch (error) {
    if (error instanceof RwaAutomationExecutionLeaseError) throw error;
    throw topologyInvalid();
  }
}

function openLockFile(path: string, uid: number, gid: number, allowCreate: boolean) {
  let descriptor: number;
  if (allowCreate) {
    try {
      descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw topologyInvalid();
      try {
        descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
      } catch {
        throw topologyInvalid();
      }
    }
  } else {
    try {
      descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch {
      throw topologyInvalid();
    }
  }
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.uid !== uid
      || metadata.gid !== gid
      || (metadata.mode & 0o777) !== 0o600
    ) {
      throw topologyInvalid();
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    if (error instanceof RwaAutomationExecutionLeaseError) throw error;
    throw topologyInvalid();
  }
}

function validateMount(root: string, production: boolean, supplied?: string) {
  if (!production && supplied === undefined) return;
  let mountInfo: string;
  try {
    mountInfo = supplied ?? readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    throw topologyInvalid();
  }
  const mounts = parseMountInfo(mountInfo);
  const mount = mounts.find((entry) => entry.mountPoint === root);
  const fsType = mount?.fileSystemType.toLowerCase() ?? "";
  if (
    !mount
    || !mount.options.has("rw")
    || mounts.some((entry) => entry.mountPoint.startsWith(`${root}/`))
    || rejectedFileSystems.has(fsType)
    || fsType.startsWith("fuse.")
  ) {
    throw topologyInvalid();
  }
}

function parseMountInfo(value: string) {
  return value.split(/\r?\n/).flatMap((line) => {
    const separatorIndex = line.indexOf(" - ");
    if (separatorIndex < 0) return [];
    const mountFields = line.slice(0, separatorIndex).trim().split(/\s+/);
    const fileSystemFields = line.slice(separatorIndex + 3).trim().split(/\s+/);
    if (mountFields.length < 6 || fileSystemFields.length < 1) return [];
    return [{
      mountPoint: decodeMountPath(mountFields[4]!),
      options: new Set(mountFields[5]!.split(",")),
      fileSystemType: fileSystemFields[0]!,
    }];
  });
}

function decodeMountPath(value: string) {
  return value
    .replaceAll("\\040", " ")
    .replaceAll("\\011", "\t")
    .replaceAll("\\012", "\n")
    .replaceAll("\\134", "\\");
}

function acquireWithFlock(descriptor: number) {
  return new Promise<boolean>((resolvePromise, reject) => {
    const child = spawn(
      "flock",
      ["--exclusive", "--nonblock", "--conflict-exit-code", "73", "3"],
      { stdio: ["ignore", "ignore", "ignore", descriptor] },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error("flock terminated"));
        return;
      }
      resolvePromise(code === 0);
    });
  });
}

function topologyInvalid() {
  return new RwaAutomationExecutionLeaseError(
    "automation_execution_topology_invalid",
    "自动套利执行拓扑或锁存储边界无效；已拒绝启动。",
  );
}

function unavailable() {
  return new RwaAutomationExecutionLeaseError(
    "automation_execution_lease_unavailable",
    "自动套利执行实例租约不可用；已拒绝启动。",
  );
}

function lost() {
  return new RwaAutomationExecutionLeaseError(
    "automation_execution_lease_lost",
    "自动套利执行实例租约已失效；已拒绝继续。",
  );
}
