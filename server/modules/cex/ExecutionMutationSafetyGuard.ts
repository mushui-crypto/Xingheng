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

export type ExecutionMutationSafetyConfig = Readonly<{
  liveTradingEnabled: boolean;
  killSwitchActive: boolean;
  validateProviderIdentity?: (
    context: ExecutionMutationContext,
  ) => void | Promise<void>;
}>;

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
    private readonly config: ExecutionMutationSafetyConfig = {
      liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === "true",
      killSwitchActive: process.env.BINANCE_KILL_SWITCH !== "false",
    },
  ) {}

  async assertAllowed(context: ExecutionMutationContext) {
    if (!this.config.liveTradingEnabled) {
      throw new ExecutionMutationSafetyError(
        "live_trading_disabled",
        "LIVE_TRADING_ENABLED is not true.",
      );
    }
    if (this.config.killSwitchActive) {
      throw new ExecutionMutationSafetyError(
        "kill_switch_active",
        "Unified execution kill switch is active.",
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
    } catch (error) {
      if (error instanceof ExecutionMutationSafetyError) throw error;
      throw new ExecutionMutationSafetyError(
        "provider_identity_invalid",
        "Provider identity validation failed before mutation.",
      );
    }
  }

  status() {
    return Object.freeze({
      liveTradingEnabled: this.config.liveTradingEnabled,
      killSwitchActive: this.config.killSwitchActive,
    });
  }
}

function nonEmpty(value: string) {
  return typeof value === "string" && value.trim().length > 0;
}
