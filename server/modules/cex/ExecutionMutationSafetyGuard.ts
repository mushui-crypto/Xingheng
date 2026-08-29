import { ExecutionPreMutationFailure } from "./ExecutionCapability";

export type ExecutionMutationOperation = "placeOrder" | "cancelOrder";
export type ExecutionMutationEffect = "INCREASE" | "DECREASE";

export type ExecutionMutationContext = Readonly<{
  venue: string;
  operation: ExecutionMutationOperation;
  userId: string;
  accountId: string;
  instrumentId: string;
  providerInstrumentId: string;
  providerAccountId?: string;
  executionIntentId?: string;
  mutationPreparedAt?: number;
  verifiedProviderIdentity?: VerifiedExecutionProviderIdentity;
  /** Internal server-owned semantic. Missing or unrecognized values fail safe as INCREASE. */
  mutationEffect?: ExecutionMutationEffect;
}>;

export type VerifiedExecutionProviderIdentity = Readonly<{
  userId: string;
  venue: string;
  accountId: string;
  executionIntentId: string;
  verifiedAt: number;
  source: "MUTATION_TIME_AUTHORITATIVE_CLOSE_SAFETY";
}>;

const verifiedProviderIdentities = new WeakSet<VerifiedExecutionProviderIdentity>();
const DEFAULT_VERIFIED_IDENTITY_MAX_AGE_MS = 15_000;

export function createVerifiedExecutionProviderIdentity(
  input: Omit<VerifiedExecutionProviderIdentity, "source">,
): VerifiedExecutionProviderIdentity {
  const identity = Object.freeze({
    userId: nonEmptyValue(input.userId, "verified identity userId"),
    venue: nonEmptyValue(input.venue, "verified identity venue"),
    accountId: nonEmptyValue(input.accountId, "verified identity accountId"),
    executionIntentId: nonEmptyValue(input.executionIntentId, "verified identity executionIntentId"),
    verifiedAt: nonNegativeSafeInteger(input.verifiedAt, "verified identity timestamp"),
    source: "MUTATION_TIME_AUTHORITATIVE_CLOSE_SAFETY" as const,
  });
  verifiedProviderIdentities.add(identity);
  return identity;
}

export type ExecutionProviderIdentityValidator = (
  context: ExecutionMutationContext,
) => void | Promise<void>;

export type ExecutionMutationSafetyState = Readonly<{
  liveTradingEnabled: boolean;
  killSwitchActive: boolean;
  liveTradingDisabledMessage?: string;
  killSwitchActiveMessage?: string;
}>;

export type ExecutionMutationSafetyConfig = ExecutionMutationSafetyState & Readonly<{
  venues?: Readonly<Record<string, ExecutionMutationSafetyState>>;
  validateProviderIdentity?: ExecutionProviderIdentityValidator;
  verifiedIdentityMaxAgeMs?: number;
}>;

type ExecutionMutationSafetyEnvironment = Readonly<Record<string, string | undefined>>;

const FAIL_CLOSED_STATE = Object.freeze({
  liveTradingEnabled: false,
  killSwitchActive: true,
});

export class ExecutionMutationSafetyError extends ExecutionPreMutationFailure {
  constructor(
    readonly category:
      | "live_trading_disabled"
      | "kill_switch_active"
      | "identity_invalid"
      | "provider_identity_invalid"
      | "identity_read_unavailable"
      | "identity_auth_or_permission_failed"
      | "identity_mismatch"
      | "identity_context_invalid",
    message: string,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = "ExecutionMutationSafetyError";
  }
}

export class ExecutionMutationSafetyGuard {
  constructor(
    private readonly config: ExecutionMutationSafetyConfig = executionMutationSafetyConfigFromEnvironment(),
  ) {}

  async assertAllowed(
    context: ExecutionMutationContext,
    validateProviderIdentity?: ExecutionProviderIdentityValidator,
  ) {
    const state = this.stateFor(context.venue);
    const riskIncreasing = context.operation === "placeOrder" && context.mutationEffect !== "DECREASE";
    if (riskIncreasing && !state.liveTradingEnabled) {
      throw new ExecutionMutationSafetyError(
        "live_trading_disabled",
        state.liveTradingDisabledMessage ?? "LIVE_TRADING_ENABLED is not true.",
      );
    }
    if (riskIncreasing && state.killSwitchActive) {
      throw new ExecutionMutationSafetyError(
        "kill_switch_active",
        state.killSwitchActiveMessage ?? "Unified execution kill switch is active.",
      );
    }
    if (!nonEmpty(context.venue) || !nonEmpty(context.userId)
      || !nonEmpty(context.accountId) || !nonEmpty(context.instrumentId)
      || !nonEmpty(context.providerInstrumentId)) {
      throw new ExecutionMutationSafetyError(
        "identity_invalid",
        "Execution mutation identity is incomplete.",
      );
    }
    await this.validateProviderIdentity(context, validateProviderIdentity);
  }

  status(venue?: string) {
    const state = venue === undefined ? this.config : this.stateFor(venue);
    return Object.freeze({
      liveTradingEnabled: state.liveTradingEnabled,
      killSwitchActive: state.killSwitchActive,
    });
  }

  private stateFor(venue: string) {
    if (!this.config.venues) return this.config;
    if (!nonEmpty(venue)) return this.config;
    return this.config.venues[venue] ?? FAIL_CLOSED_STATE;
  }

  private async validateProviderIdentity(
    context: ExecutionMutationContext,
    validateProviderIdentity?: ExecutionProviderIdentityValidator,
  ) {
    try {
      await this.config.validateProviderIdentity?.(context);
      if (context.verifiedProviderIdentity !== undefined) {
        assertVerifiedProviderIdentityContext(
          context,
          context.verifiedProviderIdentity,
          this.config.verifiedIdentityMaxAgeMs ?? DEFAULT_VERIFIED_IDENTITY_MAX_AGE_MS,
        );
        return;
      }
      await validateProviderIdentity?.(context);
    } catch (error) {
      if (error instanceof ExecutionMutationSafetyError) throw error;
      throw new ExecutionMutationSafetyError(
        "provider_identity_invalid",
        "Provider identity validation failed before mutation.",
      );
    }
  }
}

function assertVerifiedProviderIdentityContext(
  context: ExecutionMutationContext,
  identity: VerifiedExecutionProviderIdentity,
  maxAgeMs: number,
) {
  if (!verifiedProviderIdentities.has(identity)
    || identity.source !== "MUTATION_TIME_AUTHORITATIVE_CLOSE_SAFETY"
    || identity.userId !== context.userId
    || identity.venue !== context.venue
    || identity.accountId !== context.accountId
    || identity.executionIntentId !== context.executionIntentId
    || !Number.isSafeInteger(context.mutationPreparedAt)
    || context.mutationPreparedAt! < identity.verifiedAt
    || context.mutationPreparedAt! - identity.verifiedAt > positiveSafeInteger(maxAgeMs, "verified identity max age")) {
    throw new ExecutionMutationSafetyError(
      "identity_context_invalid",
      "Verified Provider identity context is invalid or stale.",
    );
  }
}

export function executionMutationSafetyConfigFromEnvironment(
  source: ExecutionMutationSafetyEnvironment = process.env,
): ExecutionMutationSafetyConfig {
  const binance = state(
    source.LIVE_TRADING_ENABLED === "true",
    source.BINANCE_KILL_SWITCH !== "false",
  );
  const okx = state(
    source.OKX_LIVE_TRADING_ENABLED === "true",
    source.OKX_KILL_SWITCH !== "false",
    {
      liveTradingDisabledMessage: "OKX_LIVE_TRADING_ENABLED is not true.",
      killSwitchActiveMessage: "OKX_KILL_SWITCH is active.",
    },
  );
  const bybit = state(
    source.BYBIT_LIVE_TRADING_ENABLED === "true",
    source.BYBIT_KILL_SWITCH !== "false",
    {
      liveTradingDisabledMessage: "BYBIT_LIVE_TRADING_ENABLED is not true.",
      killSwitchActiveMessage: "BYBIT_KILL_SWITCH is active.",
    },
  );
  const bitget = state(
    source.BITGET_LIVE_TRADING_ENABLED === "true",
    source.BITGET_KILL_SWITCH !== "false",
    {
      liveTradingDisabledMessage: "BITGET_LIVE_TRADING_ENABLED is not true.",
      killSwitchActiveMessage: "BITGET_KILL_SWITCH is active.",
    },
  );
  return Object.freeze({
    ...binance,
    venues: Object.freeze({
      binance,
      okx,
      bybit,
      bitget,
    }),
  });
}

function state(
  liveTradingEnabled: boolean,
  killSwitchActive: boolean,
  messages: Pick<
    ExecutionMutationSafetyState,
    "liveTradingDisabledMessage" | "killSwitchActiveMessage"
  > = {},
) {
  return Object.freeze({ liveTradingEnabled, killSwitchActive, ...messages });
}

function nonEmpty(value: string) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyValue(value: unknown, label: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 300) throw new Error(`${label} is invalid.`);
  return text;
}

function nonNegativeSafeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid.`);
  return Number(value);
}

function positiveSafeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} is invalid.`);
  return Number(value);
}
