import assert from "node:assert/strict";
import test from "node:test";
import {
  RWA_AUTOMATION_VERIFY_FAILURES,
  runRwaAutomationBackupVerify,
  rwaAutomationBackupVerifyFailureReceipt,
} from "./RwaAutomationBackupVerify";
import {
  RwaAutomationBackupError,
  type RwaAutomationBackupVerifyStage,
} from "../modules/arbitrage/automation/RwaAutomationBackupService";

const NAME = "rwa-automation-20260731T120000Z.rwa.enc.json";

test("backup verify returns an exact read-only receipt", async () => {
  let calls = 0;
  const receipt = await runRwaAutomationBackupVerify(NAME, async (name) => {
    calls += 1;
    assert.equal(name, NAME);
    return { backupId: "backup-id", fileCount: 5, plaintextBytes: 1234 };
  });
  assert.equal(calls, 1);
  assert.deepEqual(receipt, {
    schemaVersion: 1, operation: "verify", backupId: "backup-id",
    fileCount: 5, plaintextBytes: 1234, readOnly: true,
  });
});

test("backup verify rejects paths, whitespace, control characters and extra suffixes before access", async () => {
  for (const value of ["", `../${NAME}`, `/tmp/${NAME}`, `${NAME} `, `${NAME}\n`, `${NAME}.old`, "*"]) {
    let calls = 0;
    await assert.rejects(runRwaAutomationBackupVerify(value, async () => {
      calls += 1;
      throw new Error("must not run");
    }));
    assert.equal(calls, 0);
  }
});

test("backup verify failures expose only an exact stable receipt", () => {
  for (const [stage, category] of Object.entries(RWA_AUTOMATION_VERIFY_FAILURES)) {
    if (stage === "container_receipt") continue;
    assert.deepEqual(
      rwaAutomationBackupVerifyFailureReceipt(new RwaAutomationBackupError(
        category,
        "secret must not escape",
        stage as RwaAutomationBackupVerifyStage,
      )),
      {
        schemaVersion: 1,
        operation: "verify",
        ok: false,
        readOnly: true,
        stage,
        category,
      },
    );
  }
  const fallback = rwaAutomationBackupVerifyFailureReceipt(new Error("raw secret"));
  assert.deepEqual(fallback, {
    schemaVersion: 1,
    operation: "verify",
    ok: false,
    readOnly: true,
    stage: "container_receipt",
    category: "docker_execution_unknown",
  });
  assert.doesNotMatch(JSON.stringify(fallback), /raw secret/u);
});
