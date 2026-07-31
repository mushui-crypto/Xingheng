import {
  RwaAutomationBackupError,
  assertBackupFileName,
} from "../modules/arbitrage/automation/RwaAutomationBackupService";

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

export function rwaAutomationBackupVerifyErrorCategory(error: unknown) {
  return error instanceof RwaAutomationBackupError ? error.category : "backup_verify_failed";
}
