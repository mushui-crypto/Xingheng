import type { ArbitrageOpportunity } from "../arbitrageTypes";
import type { RwaAutomationConnector, RwaAutomationMode, RwaAutomationVenueStatus, RwaVenueCredentialInput } from "./RwaAutomationTypes";
import type { RwaBinanceAutomationService } from "./RwaBinanceAutomationService";

export class RwaBinanceAutomationConnector implements RwaAutomationConnector {
  readonly venue = "binance" as const;
  readonly implemented = true as const;
  readonly providerWritesEnabled = true;

  constructor(private readonly service: RwaBinanceAutomationService) {}

  initialize() { return this.service.initialize(); }
  startActivityMonitoring() { return this.service.startActivityMonitoring(); }
  hasActivityMonitor() { return this.service.hasActivityMonitor(); }
  dispose() { this.service.dispose(); }

  supports(opportunity: ArbitrageOpportunity) {
    return opportunity.strategyType === "same_venue_neutral"
      && opportunity.longLeg.venue === "binance"
      && opportunity.shortLeg.venue === "binance"
      && opportunity.longLeg.kind === "spot"
      && opportunity.shortLeg.kind === "perpetual"
      && opportunity.longLeg.asset === "XAUT"
      && opportunity.shortLeg.asset === "XAUT";
  }

  assertRiskCapacity() { return this.service.assertRiskCapacity(); }
  captureCredentialMutationSnapshot() { return this.service.captureCredentialMutationSnapshot(); }
  restoreCredentialMutationSnapshot(snapshot: Parameters<RwaBinanceAutomationService["restoreCredentialMutationSnapshot"]>[0]) {
    return this.service.restoreCredentialMutationSnapshot(snapshot);
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
  getAccountAssetAuthorization(assetId: string) { return this.service.getAccountAssetAuthorization(assetId); }
  previewAccountAssetAuthorization(assetId: string) { return this.service.previewAccountAssetAuthorization(assetId); }
  createAccountAssetAuthorization(
    assetId: string,
    preview: Parameters<RwaBinanceAutomationService["createAccountAssetAuthorization"]>[1],
  ) {
    return this.service.createAccountAssetAuthorization(assetId, preview);
  }
  revokeAccountAssetAuthorization(assetId: string) { return this.service.revokeAccountAssetAuthorization(assetId); }
  previewAssetTakeover(input: Parameters<RwaBinanceAutomationService["previewAssetTakeover"]>[0]) {
    return this.service.previewAssetTakeover(input);
  }
  startAssetTakeover(input: Parameters<RwaBinanceAutomationService["startAssetTakeover"]>[0]) {
    return this.service.startAssetTakeover(input);
  }
  reconfirmAssetTakeover(input: Parameters<RwaBinanceAutomationService["reconfirmAssetTakeover"]>[0]) {
    return this.service.reconfirmAssetTakeover(input);
  }
  getCurrentAssetTakeover() { return this.service.getCurrentAssetTakeover(); }
  getAssetTakeoverAbortContext(input: Parameters<RwaBinanceAutomationService["getAssetTakeoverAbortContext"]>[0]) {
    return this.service.getAssetTakeoverAbortContext(input);
  }
  abortAssetTakeover(input: Parameters<RwaBinanceAutomationService["abortAssetTakeover"]>[0]) {
    return this.service.abortAssetTakeover(input);
  }
  getAssetTakeoverStatus(takeoverId: string) { return this.service.getAssetTakeoverStatus(takeoverId); }
  previewAssetTakeoverExit(input: Parameters<RwaBinanceAutomationService["previewAssetTakeoverExit"]>[0]) {
    return this.service.previewAssetTakeoverExit(input);
  }
  confirmAssetTakeoverExit(input: Parameters<RwaBinanceAutomationService["confirmAssetTakeoverExit"]>[0]) {
    return this.service.confirmAssetTakeoverExit(input);
  }
  getAssetTakeoverExitStatus(takeoverId: string) {
    return this.service.getAssetTakeoverExitStatus(takeoverId);
  }
  getConfig() { return this.service.getConfig(); }
  updateConfig(input: unknown) { return this.service.updateConfig(input); }
  setKillSwitch(active: boolean, accountId?: string) { return this.service.setKillSwitch(active, accountId); }
  getPrivateAccount() { return this.service.getPrivateAccount(); }
  getPnl() { return this.service.getPnl(); }
  getAudit() { return this.service.getAudit(); }
  getReconciliation(input?: unknown) { return this.service.getReconciliation(input); }
  preflight(opportunity: ArbitrageOpportunity, accountId: string, mode: RwaAutomationMode) {
    return this.service.preflight(opportunity, accountId, mode);
  }
  execute(input: unknown) { return this.service.execute(input); }
  closeAll(input: unknown) { return this.service.closeAll(input); }
  finalizeReconciliation(input: unknown) { return this.service.finalizeReconciliation(input); }
}
