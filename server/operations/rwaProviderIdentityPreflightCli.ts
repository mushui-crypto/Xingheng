import {
  providerIdentityPreflightErrorCategory,
  runRwaProviderIdentityPreflight,
} from "./RwaProviderIdentityPreflight";

runRwaProviderIdentityPreflight()
  .then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  })
  .catch((error) => {
    console.error(providerIdentityPreflightErrorCategory(error));
    process.exit(1);
  });
