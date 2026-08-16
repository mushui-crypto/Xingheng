export type ExecutionMutationOperation = "placeOrder" | "cancelOrder";

export type ExecutionMutationContext = Readonly<{
  venue: string;
  operation: ExecutionMutationOperation;
  userId: string;
  accountId: string;
  instrumentId: string;
  providerInstrumentId: string;
  providerAccountId?: string;
}>;

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
}>;

type ExecutionMutationSafetyEnvironment = Readonly<Record<string, string | undefined>>;

const FAIL_CLOSED_STATE = Object.freeze({
  liveTradingEnabled: false,
  killSwitchActive: true,
});

export class ExecutionMutationSafetyError extends Error {
  constructor(
    readonly category:
      | "live_trading_disabled"
      | "kill_switch_active"
      | "identity_invalid"
      | "provider_identity_invalid",
    message: string,
  ) {
    super(message);
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
    if (!state.liveTradingEnabled) {
      throw new ExecutionMutationSafetyError(
        "live_trading_disabled",
        state.liveTradingDisabledMessage ?? "LIVE_TRADING_ENABLED is not true.",
      );
    }
    if (state.killSwitchActive) {
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
    try {
      await this.config.validateProviderIdentity?.(context);
      await validateProviderIdentity?.(context);
    } catch (error) {
      if (error instanceof ExecutionMutationSafetyError) throw error;
      throw new ExecutionMutationSafetyError(
        "provider_identity_invalid",
        "Provider identity validation failed before mutation.",
      );
    }
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
  return Object.freeze({
    ...binance,
    venues: Object.freeze({
      binance,
      okx,
      bybit: FAIL_CLOSED_STATE,
      bitget: FAIL_CLOSED_STATE,
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
