import {
  activationPreflightErrorCategory,
  runRwaAutomationActivationPreflight,
} from "./RwaAutomationActivationPreflight";

async function main() {
  await runRwaAutomationActivationPreflight();
  console.log("activation WIF and KMS health verified");
}

main().catch((error) => {
  console.error(activationPreflightErrorCategory(error));
  process.exit(1);
});
