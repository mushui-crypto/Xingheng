import {
  RwaAutomationBackupError,
  assertBackupFileName,
} from "../modules/arbitrage/automation/RwaAutomationBackupService";

export const RWA_AUTOMATION_VERIFY_FAILURES = Object.freeze({
  wif_identity: "wif_identity_invalid",
  sts_exchange: "sts_exchange_failed",
  kms_health: "kms_health_failed",
  kms_decrypt: "kms_decrypt_failed",
  backup_envelope: "backup_envelope_invalid",
  backup_authentication: "backup_authentication_failed",
  backup_content: "backup_content_invalid",
  container_receipt: "docker_execution_unknown",
} as const);

export type RwaAutomationBackupVerifyFailureReceipt = {
  schemaVersion: 1;
  operation: "verify";
  ok: false;
  readOnly: true;
  stage: keyof typeof RWA_AUTOMATION_VERIFY_FAILURES;
  category: (typeof RWA_AUTOMATION_VERIFY_FAILURES)[keyof typeof RWA_AUTOMATION_VERIFY_FAILURES];
};

export type RwaAutomationBackupVerifyReceipt = {
  schemaVersion: 1;
  operation: "verify";
  backupId: string;
  fileCount: number;
  plaintextBytes: number;
  readOnly: true;
};

export async function runRwaAutomationBackupVerify(
  fileName: string,
  verifyBackup: (fileName: string) => Promise<{
    backupId: string; fileCount: number; plaintextBytes: number;
  }>,
): Promise<RwaAutomationBackupVerifyReceipt> {
  assertBackupFileName(fileName);
  const result = await verifyBackup(fileName);
  return {
    schemaVersion: 1,
    operation: "verify",
    backupId: result.backupId,
    fileCount: result.fileCount,
    plaintextBytes: result.plaintextBytes,
    readOnly: true,
  };
}

export function rwaAutomationBackupVerifyFailureReceipt(
  error: unknown,
): RwaAutomationBackupVerifyFailureReceipt {
  if (error instanceof RwaAutomationBackupError && error.verifyStage !== null) {
    const stage = error.verifyStage;
    const category = RWA_AUTOMATION_VERIFY_FAILURES[stage];
    if (error.category === category) return failureReceipt(stage, category);
  }
  return failureReceipt("container_receipt", "docker_execution_unknown");
}

function failureReceipt<Stage extends keyof typeof RWA_AUTOMATION_VERIFY_FAILURES>(
  stage: Stage,
  category: (typeof RWA_AUTOMATION_VERIFY_FAILURES)[Stage],
): RwaAutomationBackupVerifyFailureReceipt {
  return {
    schemaVersion: 1,
    operation: "verify",
    ok: false,
    readOnly: true,
    stage,
    category,
  };
}
