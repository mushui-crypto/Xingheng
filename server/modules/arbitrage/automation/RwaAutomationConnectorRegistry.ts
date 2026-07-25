import type { ArbitrageOpportunity } from "../arbitrageTypes";
import type {
  RwaAutomationConnector,
  RwaAutomationVenue,
  RwaAutomationVenueStatus,
  RwaVenueCredentialInput,
} from "./RwaAutomationTypes";

const venuePriority: RwaAutomationVenue[] = ["bybit", "bitget", "binance", "okx"];

export class RwaAutomationConnectorRegistry {
  private readonly connectors = new Map<RwaAutomationVenue, RwaAutomationConnector>();
  private initialization: Promise<void> | null = null;

  constructor(connectors: RwaAutomationConnector[]) {
    for (const connector of connectors) {
      if (this.connectors.has(connector.venue)) throw new Error(`duplicate automation connector: ${connector.venue}`);
      this.connectors.set(connector.venue, connector);
    }
  }

  listVenues() {
    return [...venuePriority];
  }

  initialize() {
    if (!this.initialization) {
      this.initialization = Promise.allSettled(
        [...this.connectors.values()].map((connector) => connector.initialize?.()),
      ).then(() => undefined);
    }
    return this.initialization;
  }

  startActivityMonitoring() {
    return Promise.all(
      [...this.connectors.values()].map((connector) => connector.startActivityMonitoring?.()),
    ).then(() => undefined);
  }

  hasActivityMonitor() {
    return [...this.connectors.values()].some((connector) => connector.hasActivityMonitor?.());
  }

  dispose() {
    for (const connector of this.connectors.values()) connector.dispose?.();
  }

  getImplemented(venue: string) {
    return this.connectors.get(normalizeVenue(venue));
  }

  requireImplemented(venue: string) {
    const normalized = normalizeVenue(venue);
    const connector = this.connectors.get(normalized);
    if (!connector) throw new RwaAutomationRegistryError(501, "venue_not_implemented", `${normalized} 自动执行 adapter 尚未实现。`);
    return connector;
  }

  findForOpportunity(opportunity: ArbitrageOpportunity) {
    if (opportunity.longLeg.venue !== opportunity.shortLeg.venue) return null;
    const venue = normalizeVenueOrNull(opportunity.longLeg.venue);
    if (!venue) return null;
    const connector = this.connectors.get(venue);
    return connector?.supports(opportunity) ? connector : null;
  }

  async findByAccountId(accountId: string) {
    for (const connector of this.connectors.values()) {
      if (await connector.getConfiguredAccountId() === accountId) return connector;
    }
    return null;
  }

  async statuses(): Promise<RwaAutomationVenueStatus[]> {
    return Promise.all(venuePriority.map(async (venue) => {
      const connector = this.connectors.get(venue);
      if (connector) return connector.getStatus();
      return notImplementedStatus(venue);
    }));
  }
}

export class RwaAutomationRegistryError extends Error {
  constructor(readonly statusCode: number, readonly category: string, message: string) {
    super(message);
  }
}

export function normalizeVenue(value: string): RwaAutomationVenue {
  const venue = normalizeVenueOrNull(value);
  if (!venue) throw new RwaAutomationRegistryError(400, "venue_invalid", "venue 仅支持 bybit、bitget、binance、okx。");
  return venue;
}

function normalizeVenueOrNull(value: string) {
  return venuePriority.includes(value as RwaAutomationVenue) ? value as RwaAutomationVenue : null;
}

function notImplementedStatus(venue: RwaAutomationVenue): RwaAutomationVenueStatus {
  return {
    venue,
    implemented: false,
    enabled: false,
    credential: {
      userId: null,
      stored: false,
      accountId: null,
      accountFingerprint: null,
      masterKeyConfigured: false,
      maskedApiKey: null,
      connectionStatus: "not_implemented",
      lifecycleStatus: "not_implemented",
      accountMode: null,
      permissions: null,
      lastVerifiedAt: null,
      updatedAt: null,
      message: `${venue} 自动执行 adapter 尚未实现，默认 disabled。`,
      ipWhitelistConfigured: null,
      warnings: [],
    },
  };
}

export function bybitCredentialInput(input: RwaVenueCredentialInput) {
  return { apiKey: input.apiKey, apiSecret: input.apiSecret };
}
