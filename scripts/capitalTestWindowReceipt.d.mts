export const CAPITAL_TEST_WINDOW_EXECUTION_MODE: "single_connectivity_smoke";
export const CAPITAL_TEST_WINDOW_HOST_ROOT: string;
export const CAPITAL_TEST_WINDOW_RUNTIME_ROOT: string;
export const CAPITAL_TEST_WINDOW_MAX_DURATION_MS: number;
export const CAPITAL_TEST_WINDOW_LEASE_MS: number;

export type CapitalTestWindowPermitIdentity = {
  ownerUserId: string;
  accountBindingSha256: string;
  authorizationDigest: string;
  executionMode: "single_connectivity_smoke";
  revision: string;
  digest: string;
};

export function assertCapitalTestWindowAllowsNewRisk(
  permit: CapitalTestWindowPermitIdentity,
  options?: { path?: string; rootPath?: string; now?: number | Date; expectedUid?: number; expectedGid?: number },
): Readonly<Record<string, unknown>>;
