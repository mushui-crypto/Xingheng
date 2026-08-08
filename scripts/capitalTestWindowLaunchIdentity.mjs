import {
  assertPromotionStateAllowsProduction,
} from "./releasePromotionTransaction.mjs";
import {
  PERMIT_INSTALL_RECEIPT,
  readInstallReceipt,
} from "./productionSelfTestPermitInstall.mjs";
import {
  PRODUCTION_IDENTITY_PROOF_KINDS,
} from "./productionIdentityTransition.mjs";
export {
  validatePermitInstalledTransition,
} from "./productionIdentityTransition.mjs";

export function assertCapitalTestWindowLaunchIdentity(options = {}) {
  const verifyPromotion = options.verifyPromotion
    ?? assertPromotionStateAllowsProduction;
  const readReceipt = options.readReceipt ?? readInstallReceipt;
  return verifyPromotion({
    ...options.promotionOptions,
    requiredProofKind: PRODUCTION_IDENTITY_PROOF_KINDS.PERMIT_TRANSITION,
    readPermitReceipt: () => readReceipt(
      options.receiptPath ?? PERMIT_INSTALL_RECEIPT,
      options.receiptOptions,
    ),
  });
}
