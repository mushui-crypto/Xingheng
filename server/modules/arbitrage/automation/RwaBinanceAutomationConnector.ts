import type { ArbitrageOpportunity } from "../arbitrageTypes";
import type { RwaAutomationConnector, RwaAutomationMode, RwaAutomationVenueStatus, RwaVenueCredentialInput } from "./RwaAutomationTypes";
import type { RwaBinanceAutomationService } from "./RwaBinanceAutomationService";

export class RwaBinanceAutomationConnector implements RwaAutomationConnector {
  readonly venue = "binance" as const;
  readonly implemented = true as const;
  readonly providerWritesEnabled = true;

  constructor(private readonly service: RwaBinanceAutomationService) {}

  supports(opportunity: ArbitrageOpportunity) {
    return opportunity.strategyType === "same_venue_neutral"
      && opportunity.longLeg.venue === "binance"
      && opportunity.shortLeg.venue === "binance"
      && opportunity.longLeg.kind === "spot"
      && opportunity.shortLeg.kind === "perpetual"
      && opportunity.longLeg.asset === "XAUT"
      && opportunity.shortLeg.asset === "XAUT";
  }

  getConfiguredAccountId() { return this.service.getConfiguredAccountId(); }

  async getStatus(): Promise<RwaAutomationVenueStatus> {
    const [credential, config, productAvailability] = await Promise.all([
      this.service.getCredentialStatus(),
      this.service.getConfig(),
      this.service.getProductAvailability(),
    ]) as [
      Awaited<ReturnType<RwaBinanceAutomationService["getCredentialStatus"]>>,
      Awaited<ReturnType<RwaBinanceAutomationService["getConfig"]>>,
      Awaited<ReturnType<RwaBinanceAutomationService["getProductAvailability"]>>,
    ];
    return {
      venue: this.venue,
      implemented: true,
      enabled: Boolean(
        credential.lifecycleStatus === "active"
        && config.globalExecutionEnabled
        && config.strategyEnabled
        && !config.killSwitchActive
        && !config.serverGlobalKillSwitchActive
      ),
      phase: "execution_capable",
      providerWritesEnabled: true,
      credential: { ...credential, permissions: credential.permissions ? { ...credential.permissions } : null },
      productAvailability,
      config,
    };
  }

  async putCredentials(input: RwaVenueCredentialInput) {
    await this.service.putCredentials({ apiKey: input.apiKey, apiSecret: input.apiSecret });
    return this.getStatus();
  }

  deleteCredentials(input?: unknown) { return this.service.deleteCredentials(input); }
  getConfig() { return this.service.getConfig(); }
  updateConfig(input: unknown) { return this.service.updateConfig(input); }
  setKillSwitch(active: boolean, accountId?: string) { return this.service.setKillSwitch(active, accountId); }
  getPrivateAccount() { return this.service.getPrivateAccount(); }
  getPnl() { return this.service.getPnl(); }
  getAudit() { return this.service.getAudit(); }
  preflight(opportunity: ArbitrageOpportunity, accountId: string, mode: RwaAutomationMode) {
    return this.service.preflight(opportunity, accountId, mode);
  }
  execute(input: unknown) { return this.service.execute(input); }
  closeAll(input: unknown) { return this.service.closeAll(input); }
}
