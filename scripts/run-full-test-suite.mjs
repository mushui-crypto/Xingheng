import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const excludedDirectories = new Set([
  ".git",
  ".codex",
  "coverage",
  "dist",
  "dist-server",
  "node_modules",
]);
export const formalTestFile = /(?:\.test|\.spec)\.(?:[cm]?[jt]sx?)$/u;
export const forbiddenExecutablePaths = new Set([
  "scripts/run-real-trading-test.ts",
]);

export function discoverSafeTestFiles(root = repositoryRoot) {
  return discover(root)
    .map((path) => relative(root, path))
    .filter((path) => formalTestFile.test(path))
    .sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const testFiles = discoverSafeTestFiles();
  const forbidden = testFiles.filter((path) => forbiddenExecutablePaths.has(path));
  if (forbidden.length > 0) {
    throw new Error(`Unsafe full-suite manifest contains Provider mutation CLI: ${forbidden.join(", ")}`);
  }
  if (testFiles.length === 0) throw new Error("Safe full-suite manifest discovered no formal test files.");

  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

function discover(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) files.push(...discover(resolve(directory, entry.name)));
      continue;
    }
    if (entry.isFile()) files.push(resolve(directory, entry.name));
  }
  return files;
}
