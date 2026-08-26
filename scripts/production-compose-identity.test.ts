import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const compose = source("../compose.yaml");
const criticalProductionScripts = [
  "./backup.sh",
  "./restore.sh",
  "./smoke.sh",
];
const currentProductionDocs = [
  "../RELEASE_PROCESS.md",
  "../docs/strategy/STRATEGY_RESEARCH.md",
];

test("production Compose has the canonical xingheng project identity", () => {
  assert.match(compose, /^name: xingheng$/mu);
  assert.doesNotMatch(compose, /^name: stellax-personal$/mu);
});

test("critical production scripts explicitly target xingheng", () => {
  for (const path of criticalProductionScripts) {
    const script = source(path);
    const invocations = script.split("\n").filter((line) => /docker compose/u.test(line));
    assert.ok(invocations.length > 0, `${path} must contain a Compose invocation`);
    for (const invocation of invocations) {
      assert.match(invocation, /docker compose -p xingheng\b/u, `${path}: ${invocation}`);
      assert.doesNotMatch(invocation, /stellax-personal/u);
    }
  }
});

test("current production command examples explicitly target xingheng", () => {
  for (const path of currentProductionDocs) {
    const document = source(path);
    const commands = document.split("\n").filter((line) => /^docker compose .*\b(?:config|ps|run|up)\b/u.test(line));
    assert.ok(commands.length > 0, `${path} must contain a production Compose command`);
    for (const command of commands) assert.match(command, /docker compose -p xingheng\b/u, `${path}: ${command}`);
  }
});

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
