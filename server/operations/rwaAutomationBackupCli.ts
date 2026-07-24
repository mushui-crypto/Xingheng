import { GcpKmsCredentialKeyProvider } from "../modules/arbitrage/automation/GcpKmsCredentialKeyProvider";
import {
  RWA_AUTOMATION_BACKUP_ROOT,
  RwaAutomationBackupError,
  RwaAutomationBackupService,
  assertBackupFileName,
} from "../modules/arbitrage/automation/RwaAutomationBackupService";
import { RWA_AUTOMATION_DATA_ROOT } from "../modules/arbitrage/automation/RwaAutomationDataLayout";

const operation = process.argv[2];
const provider = new GcpKmsCredentialKeyProvider();
const service = new RwaAutomationBackupService(provider, {
  dataRoot: RWA_AUTOMATION_DATA_ROOT,
  backupRoot: RWA_AUTOMATION_BACKUP_ROOT,
  production: true,
});

try {
  if (operation === "create") {
    const result = await service.createBackup();
    process.stdout.write(`${result.fileName}\n`);
  } else if (operation === "restore") {
    const fileName = process.env.RWA_AUTOMATION_RESTORE_FILE ?? "";
    assertBackupFileName(fileName);
    const result = await service.restoreBackup(fileName);
    process.stdout.write(`restored ${result.backupId}\n`);
  } else if (operation === "rollback") {
    service.rollbackRestore();
    process.stdout.write("rollback complete\n");
  } else {
    throw new RwaAutomationBackupError("backup_operation_invalid", "自动套利备份操作无效。");
  }
} catch (error) {
  const category = error instanceof RwaAutomationBackupError ? error.category : "backup_failed";
  process.stderr.write(`自动套利灾备操作失败（${category}）。\n`);
  process.exitCode = 1;
}
