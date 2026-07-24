import {
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { RWA_AUTOMATION_RUNTIME_GID, RWA_AUTOMATION_RUNTIME_UID } from "./GcpWifCredentialConfig";

export const RWA_AUTOMATION_DATA_ROOT = "/app/rwa-automation-data";
export const RWA_AUTOMATION_CURRENT_POINTER = "current.json";
export const RWA_AUTOMATION_ROLLBACK_POINTER = "rollback";
export const RWA_AUTOMATION_INITIAL_GENERATION = "generation-initial";

const generationPattern = /^generation-(?:initial|[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12})$/;

export type RwaAutomationDataLayoutOptions = {
  root?: string;
  expectedUid?: number;
  expectedGid?: number;
  production?: boolean;
};

export class RwaAutomationDataLayoutError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

export function resolveRwaAutomationActiveDataDir(options: RwaAutomationDataLayoutOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === "production";
  const root = resolve(options.root ?? process.env.RWA_AUTOMATION_DATA_DIR ?? "server/data/rwa-automation");
  if (!production) return root;
  return readGenerationPointer(root, RWA_AUTOMATION_CURRENT_POINTER, options);
}

export function validateRwaAutomationDataLayout(options: RwaAutomationDataLayoutOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === "production";
  const root = resolve(options.root ?? process.env.RWA_AUTOMATION_DATA_DIR ?? RWA_AUTOMATION_DATA_ROOT);
  if (production && root !== RWA_AUTOMATION_DATA_ROOT) {
    throw new RwaAutomationDataLayoutError(
      "rwa_automation_data_path_invalid",
      "生产自动套利数据目录必须使用冻结的专用卷路径。",
    );
  }
  assertSecureDirectory(root, options);
  const pointer = readGenerationState(root, options);
  const active = generationPath(root, pointer.generation);
  assertSecureDirectory(active, options);
  if (pointer.rollbackGeneration) assertSecureDirectory(generationPath(root, pointer.rollbackGeneration), options);
  return { root, active, rollbackGeneration: pointer.rollbackGeneration };
}

export function readGenerationPointer(
  rootInput: string,
  pointerName: typeof RWA_AUTOMATION_CURRENT_POINTER | typeof RWA_AUTOMATION_ROLLBACK_POINTER,
  options: RwaAutomationDataLayoutOptions = {},
) {
  const root = resolve(rootInput);
  const value = readGenerationState(root, options);
  const generation = pointerName === RWA_AUTOMATION_CURRENT_POINTER ? value.generation : value.rollbackGeneration;
  if (!generation) {
    throw new RwaAutomationDataLayoutError("rwa_automation_rollback_unavailable", "自动套利回滚点不存在。");
  }
  return generationPath(root, generation);
}

export function readGenerationState(rootInput: string, options: RwaAutomationDataLayoutOptions = {}) {
  const root = resolve(rootInput);
  const pointerPath = resolve(root, RWA_AUTOMATION_CURRENT_POINTER);
  assertSecureFile(pointerPath, options);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(pointerPath, "utf8"));
  } catch {
    throw new RwaAutomationDataLayoutError("rwa_automation_pointer_invalid", "自动套利数据指针无效；已拒绝继续。");
  }
  if (
    !value || typeof value !== "object"
    || Object.keys(value).sort().join(",") !== "generation,rollbackGeneration,version"
    || (value as { version?: unknown }).version !== 1
    || typeof (value as { generation?: unknown }).generation !== "string"
    || !generationPattern.test((value as { generation: string }).generation)
    || !(
      (value as { rollbackGeneration?: unknown }).rollbackGeneration === null
      || (
        typeof (value as { rollbackGeneration?: unknown }).rollbackGeneration === "string"
        && generationPattern.test((value as { rollbackGeneration: string }).rollbackGeneration)
      )
    )
  ) {
    throw new RwaAutomationDataLayoutError("rwa_automation_pointer_invalid", "自动套利数据指针无效；已拒绝继续。");
  }
  return value as { version: 1; generation: string; rollbackGeneration: string | null };
}

export function createGenerationName(createdAt: Date) {
  const timestamp = createdAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `generation-${timestamp}-${randomBytes(6).toString("hex")}`;
}

export function writeGenerationState(
  rootInput: string,
  generation: string,
  rollbackGeneration: string | null,
  options: RwaAutomationDataLayoutOptions = {},
) {
  if (
    !generationPattern.test(generation)
    || (rollbackGeneration !== null && !generationPattern.test(rollbackGeneration))
    || generation === rollbackGeneration
  ) {
    throw new RwaAutomationDataLayoutError("rwa_automation_pointer_invalid", "自动套利 generation 名称无效。");
  }
  const root = resolve(rootInput);
  assertSecureDirectory(root, options);
  assertSecureDirectory(generationPath(root, generation), options);
  if (rollbackGeneration) assertSecureDirectory(generationPath(root, rollbackGeneration), options);
  atomicWriteJson(
    resolve(root, RWA_AUTOMATION_CURRENT_POINTER),
    { version: 1, generation, rollbackGeneration },
    options,
  );
}

export function ensureSecureDirectory(pathInput: string, options: RwaAutomationDataLayoutOptions = {}) {
  const path = resolve(pathInput);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertSecureDirectory(path, options);
}

export function expectedRwaAutomationOwner(options: RwaAutomationDataLayoutOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === "production";
  return {
    uid: production ? RWA_AUTOMATION_RUNTIME_UID : options.expectedUid ?? process.getuid?.() ?? -1,
    gid: production ? RWA_AUTOMATION_RUNTIME_GID : options.expectedGid ?? process.getgid?.() ?? -1,
  };
}

export function assertSecureDirectory(pathInput: string, options: RwaAutomationDataLayoutOptions = {}) {
  const path = resolve(pathInput);
  const owner = expectedRwaAutomationOwner(options);
  try {
    const link = lstatSync(path);
    const metadata = statSync(path);
    if (
      link.isSymbolicLink() || !metadata.isDirectory()
      || metadata.uid !== owner.uid || metadata.gid !== owner.gid
      || (metadata.mode & 0o777) !== 0o700
    ) throw new Error("unsafe directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new RwaAutomationDataLayoutError(
      "rwa_automation_storage_permissions",
      "自动套利持久化目录权限无效；已拒绝继续。",
    );
  }
}

export function assertSecureFile(pathInput: string, options: RwaAutomationDataLayoutOptions = {}) {
  const path = resolve(pathInput);
  const owner = expectedRwaAutomationOwner(options);
  try {
    const link = lstatSync(path);
    const metadata = statSync(path);
    if (
      link.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
      || metadata.uid !== owner.uid || metadata.gid !== owner.gid
      || (metadata.mode & 0o777) !== 0o600
    ) throw new Error("unsafe file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new RwaAutomationDataLayoutError(
      "rwa_automation_storage_permissions",
      "自动套利持久化文件权限无效；已拒绝继续。",
    );
  }
}

export function assertContained(rootInput: string, targetInput: string) {
  const root = resolve(rootInput);
  const target = resolve(targetInput);
  const pathFromRoot = relative(root, target);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || resolve(root, pathFromRoot) !== target) {
    throw new RwaAutomationDataLayoutError("rwa_automation_path_escape", "自动套利数据路径越界；已拒绝继续。");
  }
}

function atomicWriteJson(path: string, value: unknown, options: RwaAutomationDataLayoutOptions) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const payload = `${JSON.stringify(value)}\n`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, payload, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    const directoryDescriptor = openSync(dirname(path), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    assertSecureFile(path, options);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function generationPath(root: string, generation: string) {
  const target = resolve(root, generation);
  assertContained(root, target);
  return target;
}
