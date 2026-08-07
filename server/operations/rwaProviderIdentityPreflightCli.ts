import {
  providerIdentityPreflightErrorCategory,
  providerIdentityPreflightFailureReceipt,
  runRwaProviderIdentityPreflight,
} from "./RwaProviderIdentityPreflight";

runRwaProviderIdentityPreflight()
  .then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  })
  .catch((error) => {
    process.stdout.write(`${JSON.stringify(providerIdentityPreflightFailureReceipt(error))}\n`);
    console.error(providerIdentityPreflightErrorCategory(error));
    process.exit(1);
  });
