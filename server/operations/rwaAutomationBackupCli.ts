import { GcpKmsCredentialKeyProvider } from "../modules/arbitrage/automation/GcpKmsCredentialKeyProvider";
import {
  RWA_AUTOMATION_BACKUP_ROOT,
  RwaAutomationBackupError,
  RwaAutomationBackupService,
  assertBackupFileName,
  rwaAutomationBackupCreateFailureReceipt,
} from "../modules/arbitrage/automation/RwaAutomationBackupService";
import { RWA_AUTOMATION_DATA_ROOT } from "../modules/arbitrage/automation/RwaAutomationDataLayout";

const operation = process.argv[2];

try {
  const provider = new GcpKmsCredentialKeyProvider();
  const service = new RwaAutomationBackupService(provider, {
    dataRoot: RWA_AUTOMATION_DATA_ROOT,
    backupRoot: RWA_AUTOMATION_BACKUP_ROOT,
    production: true,
  });
  if (operation === "create") {
    const result = await service.createBackup();
    process.stdout.write(`${result.fileName}\n`);
  } else if (operation === "restore") {
    const fileName = process.env.RWA_AUTOMATION_RESTORE_FILE ?? "";
    assertBackupFileName(fileName);
    const result = await service.restoreBackup(fileName);
    process.stdout.write(`restored ${result.backupId}\n`);
  } else if (operation === "verify") {
    const fileName = process.env.RWA_AUTOMATION_RESTORE_FILE ?? "";
    assertBackupFileName(fileName);
    const result = await service.verifyBackup(fileName);
    process.stdout.write(`verified ${result.backupId} ${result.fileCount} ${result.plaintextBytes}\n`);
  } else if (operation === "rollback") {
    service.rollbackRestore();
    process.stdout.write("rollback complete\n");
  } else {
    throw new RwaAutomationBackupError("backup_operation_invalid", "自动套利备份操作无效。");
  }
} catch (error) {
  if (operation === "create") {
    process.stdout.write(`${JSON.stringify(rwaAutomationBackupCreateFailureReceipt(error))}\n`);
    process.exitCode = 1;
  } else {
    const category = error instanceof RwaAutomationBackupError ? error.category : "backup_failed";
    process.stderr.write(`自动套利灾备操作失败（${category}）。\n`);
    process.exitCode = 1;
  }
}
