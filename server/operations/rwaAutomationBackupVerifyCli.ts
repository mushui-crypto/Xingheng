import { GcpKmsCredentialKeyProvider } from "../modules/arbitrage/automation/GcpKmsCredentialKeyProvider";
import {
  RWA_AUTOMATION_BACKUP_ROOT,
  RwaAutomationBackupService,
} from "../modules/arbitrage/automation/RwaAutomationBackupService";
import {
  runRwaAutomationBackupVerify,
  rwaAutomationBackupVerifyFailureReceipt,
} from "./RwaAutomationBackupVerify";

try {
  const fileName = process.env.RWA_AUTOMATION_VERIFY_FILE ?? "";
  const service = new RwaAutomationBackupService(new GcpKmsCredentialKeyProvider(), {
    backupRoot: RWA_AUTOMATION_BACKUP_ROOT,
    production: true,
  });
  const receipt = await runRwaAutomationBackupVerify(fileName, (name) => service.verifyBackup(name));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(rwaAutomationBackupVerifyFailureReceipt(error))}\n`);
  process.exitCode = 1;
}
