import {
  ACTIVATION_KMS_HEALTH_RECEIPT,
  activationPreflightErrorCategory,
  runRwaAutomationActivationPreflight,
} from "./RwaAutomationActivationPreflight";

async function main() {
  await runRwaAutomationActivationPreflight();
  console.log(ACTIVATION_KMS_HEALTH_RECEIPT);
}

main().catch((error) => {
  console.error(activationPreflightErrorCategory(error));
  process.exit(1);
});
