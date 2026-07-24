import type { AutomationVenue } from "./controlConsoleTypes";

export type StepUpOperation =
  | "credential_put"
  | "credential_delete"
  | "execution_enable"
  | "kill_switch_disable"
  | "hedge_execute"
  | "position_close"
  | "close_all";

export type StepUpIntent = {
  operation: StepUpOperation;
  venue: AutomationVenue;
  accountId: string;
  resourceId: string | null;
  requestDigest: string;
};

export type StepUpFactor = {
  method: "totp" | "recovery_code";
  code: string;
};

export type StepUpStatus = {
  enrolled: boolean;
  pendingEnrollment: boolean;
  method: "totp" | null;
  recoveryCodesRemaining: number;
  enabledAt: number | null;
};

export type StepUpEnrollment = {
  enrollmentId: string;
  otpauthUri: string;
  expiresAt: number;
};

export type StepUpRecoveryCodes = {
  ok: true;
  recoveryCodes: string[];
};

export type StepUpAuthorization = {
  authorizationToken: string;
  expiresAt: number;
};

export type StepUpSecurityClient = {
  status(signal?: AbortSignal): Promise<StepUpStatus>;
  beginEnrollment(input: {
    currentPassword: string;
    currentFactor?: StepUpFactor;
  }): Promise<StepUpEnrollment>;
  confirmEnrollment(input: {
    enrollmentId: string;
    code: string;
  }): Promise<StepUpRecoveryCodes>;
  authorize(input: {
    code: string;
    intent: StepUpIntent;
  }): Promise<StepUpAuthorization>;
  regenerateRecoveryCodes(input: {
    currentPassword: string;
    factor: StepUpFactor;
  }): Promise<StepUpRecoveryCodes>;
  disable(input: {
    currentPassword: string;
    factor: StepUpFactor;
  }): Promise<{ ok: true }>;
};
