import assert from "node:assert/strict";
import test from "node:test";
import {
  runRwaAutomationBackupVerify,
  rwaAutomationBackupVerifyErrorCategory,
} from "./RwaAutomationBackupVerify";

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

test("unexpected backup verify failures expose only a stable category", () => {
  assert.equal(rwaAutomationBackupVerifyErrorCategory(new Error("secret")), "backup_verify_failed");
});
