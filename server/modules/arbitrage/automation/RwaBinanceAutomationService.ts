import type { ArbitrageOpportunity } from "../arbitrageTypes";
import { RwaAutomationPersistentStore } from "./RwaAutomationPersistentStore";
import {
  RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS,
  RWA_BINANCE_STRATEGY_ID,
  RWA_BINANCE_TOTAL_BUDGET_USD,
  type RwaBinanceClient,
  type RwaBinanceClientFactory,
  type RwaBinanceCredentials,
  type RwaBinancePermissions,
  type RwaBinancePreflightSnapshot,
} from "./RwaBinanceAutomationTypes";
import { RwaBinanceProviderError } from "./RwaBinanceMainnetClient";
import type { RwaAutomationMode } from "./RwaAutomationTypes";
import { RwaNeutralExecutionError } from "./RwaNeutralExecutionService";
import {
  RWA_MAX_STRATEGY_CAPITAL_USD,
  defaultRwaExecutionConfig,
  type RwaCredentialLifecycle,
  type RwaExecutionConfig,
} from "./RwaNeutralExecutionTypes";

const rotationAgeMs = 90 * 24 * 60 * 60 * 1_000;
type BinanceStore = RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>;
type BinanceCredentialMetadata = NonNullable<Awaited<ReturnType<BinanceStore["readCredentialMetadata"]>>>;

export class RwaBinanceAutomationService {
  private credentialLifecycleOverride: RwaCredentialLifecycle | null = null;
  private readonly publicClient: RwaBinanceClient;

  constructor(
    private readonly store: RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>,
    private readonly clientFactory: RwaBinanceClientFactory,
    private readonly now: () => number = Date.now,
    private readonly serverKillSwitchActive: () => boolean = () => process.env.RWA_AUTOMATION_SERVER_KILL_SWITCH !== "false",
    publicClient?: RwaBinanceClient,
  ) {
    this.publicClient = publicClient ?? clientFactory({ apiKey: "", apiSecret: "" });
  }

  async getProductAvailability() {
    try {
      return await this.publicClient.readProductAvailability();
    } catch {
      return {
        available: false,
        status: "both_unavailable" as const,
        spotSymbol: "XAUTUSDT" as const,
        perpetualSymbol: "XAUTUSDT" as const,
        checkedAt: this.now(),
        message: "Binance Mainnet 产品目录暂不可用；已按 unavailable 处理。",
      };
    }
  }

  async getCredentialStatus() {
    let metadata;
    try {
      metadata = await this.store.readCredentialMetadata();
    } catch {
      return this.status({
        stored: true,
        connectionStatus: "invalid",
        lifecycleStatus: "invalid",
        message: "Binance API 凭证文件不可读；已拒绝继续使用。",
      });
    }
    if (!metadata) {
      return this.status({
        stored: false,
        connectionStatus: "not_configured",
        lifecycleStatus: this.credentialLifecycleOverride ?? "unconfigured",
        message: this.store.masterKeyError,
      });
    }
    if (!this.store.masterKeyConfigured) {
      return this.status({
        metadata,
        stored: true,
        connectionStatus: "unavailable",
        lifecycleStatus: "invalid",
        message: this.store.masterKeyError,
      });
    }
    try {
      const access = await this.client().then((client) => client.validateAccess());
      const valid = permissionsValid(access.permissions) && access.accountId === metadata.accountId;
      const rotationRequired = this.now() - metadata.updatedAt >= rotationAgeMs;
      const lifecycleStatus = !valid ? "invalid" as const : rotationRequired ? "rotation_required" as const : "active" as const;
      return this.status({
        metadata: {
          ...metadata,
          accountMode: access.accountMode,
          permissions: access.permissions,
          lastVerifiedAt: this.now(),
        },
        stored: true,
        connectionStatus: valid ? "verified" : "invalid",
        lifecycleStatus,
        message: !valid
          ? "Binance Key 当前权限、账户身份或持仓模式不符合只读预检安全门禁。"
          : rotationRequired ? "API Key 已达到轮换周期，完成轮换前禁止新增风险。" : null,
      });
    } catch (error) {
      const lifecycleStatus = credentialFailureLifecycle(error);
      return this.status({
        metadata,
        stored: true,
        connectionStatus: lifecycleStatus === "invalid" || lifecycleStatus === "revoked" ? "invalid" : "unavailable",
        lifecycleStatus,
        message: error instanceof RwaBinanceProviderError
          ? error.message
          : "Binance 凭证实时连接校验暂不可用。",
      });
    }
  }

  async getConfiguredAccountId() {
    return (await this.store.readCredentialMetadata())?.accountId ?? null;
  }

  async putCredentials(input: RwaBinanceCredentials) {
    if (!this.store.masterKeyConfigured) {
      throw new RwaNeutralExecutionError(503, "master_key_unavailable", this.store.masterKeyError ?? "主密钥不可用。");
    }
    this.credentialLifecycleOverride = "validating";
    try {
      const previous = await this.store.readCredentialMetadata();
      const access = await this.clientFactory(input).validateAccess().catch((error) => {
        throw providerError(error, "Binance 凭证校验失败。");
      });
      assertPermissions(access.permissions);
      if (previous && previous.accountId !== access.accountId) {
        throw new RwaNeutralExecutionError(
          409,
          "credential_account_mismatch",
          "新凭证属于不同 Binance 账户；请先确认旧账户无订单/仓位并安全删除旧凭证。",
        );
      }
      const verifiedAt = this.now();
      await this.store.saveCredentials(input, access.permissions, access, verifiedAt);
      const state = await this.store.readState();
      state.credentialLifecycle = "active";
      state.credentialAlert = null;
      state.config = {
        ...state.config,
        globalExecutionEnabled: false,
        strategyEnabled: false,
        killSwitchActive: true,
      };
      state.challenges = [];
      state.credentialAudit.push({
        userId: this.store.ownerUserId,
        action: previous ? "rotated" : "activated",
        accountId: access.accountId,
        accountFingerprint: access.accountFingerprint,
        maskedApiKey: (await this.store.readCredentialMetadata())?.maskedApiKey ?? null,
        occurredAt: verifiedAt,
      });
      await this.store.writeState(state);
      return this.getCredentialStatus();
    } finally {
      this.credentialLifecycleOverride = null;
    }
  }

  async deleteCredentials(input: unknown = {}) {
    const body = record(input);
    assertOnlyKeys(body, ["accountId"]);
    const metadata = await this.store.readCredentialMetadata();
    const state = await this.store.readState();
    if (metadata) {
      assertAccountId(requiredString(body.accountId, "accountId", 100), metadata.accountId);
      let snapshot;
      try {
        snapshot = await this.client().then((client) => client.readPreflightSnapshot());
      } catch {
        state.credentialLifecycle = "invalid";
        state.credentialAlert = "Binance 凭证不可用，无法确认账户风险敞口。";
        state.config.killSwitchActive = true;
        await this.store.writeState(state);
        throw new RwaNeutralExecutionError(
          409,
          "credential_delete_manual_intervention",
          "凭证已失效或不可用，无法安全解绑。请先在 Binance 现货与 USD-M Futures 人工撤单并确认无仓位。",
          { accountId: metadata.accountId },
        );
      }
      if (
        snapshot.existingSpotQuantityXaut > 1e-9
        || snapshot.existingPerpetualQuantityXaut > 1e-9
        || snapshot.openSpotOrderCount > 0
        || snapshot.openPerpetualOrderCount > 0
      ) {
        throw new RwaNeutralExecutionError(
          409,
          "credential_delete_blocked",
          "Binance 账户存在 XAUT 余额、永续仓位或活动订单；请先人工核对并退出后再删除凭证。",
          { accountId: metadata.accountId },
        );
      }
      state.credentialAudit.push({
        userId: this.store.ownerUserId,
        action: "deleted",
        accountId: metadata.accountId,
        accountFingerprint: metadata.accountFingerprint,
        maskedApiKey: metadata.maskedApiKey,
        occurredAt: this.now(),
      });
    }
    state.config = {
      ...state.config,
      globalExecutionEnabled: false,
      strategyEnabled: false,
      killSwitchActive: true,
    };
    state.challenges = [];
    state.credentialLifecycle = "unconfigured";
    state.credentialAlert = null;
    await this.store.writeState(state);
    await this.store.deleteCredentials();
    return { ok: true, credentials: await this.getCredentialStatus() };
  }

  async getConfig() {
    const state = await this.store.readState();
    const metadata = await this.store.readCredentialMetadata();
    return publicConfig(this.store.ownerUserId, state.config, metadata?.accountId ?? null, this.serverKillSwitchActive());
  }

  async updateConfig(input: unknown) {
    const body = record(input);
    assertOnlyKeys(body, [
      "globalExecutionEnabled",
      "strategyEnabled",
      "maxStrategyCapitalUsd",
      "maxEntryBasisBps",
      "maxCombinedSlippageBps",
      "minNetAprPercent",
      "minLiquidationDistancePercent",
      "maxUnhedgedMs",
      "accountId",
    ]);
    const state = await this.store.readState();
    const metadata = await this.store.readCredentialMetadata();
    if (metadata) assertAccountId(requiredString(body.accountId, "accountId", 100), metadata.accountId);
    if (body.globalExecutionEnabled === true || body.strategyEnabled === true) {
      throw new RwaNeutralExecutionError(
        409,
        "binance_provider_writes_disabled",
        "Binance 第一阶段仅开放私有只读与 Shadow/preflight，真实执行开关不可启用。",
      );
    }
    const next = { ...state.config };
    if ("globalExecutionEnabled" in body) next.globalExecutionEnabled = booleanField(body.globalExecutionEnabled, "globalExecutionEnabled");
    if ("strategyEnabled" in body) next.strategyEnabled = booleanField(body.strategyEnabled, "strategyEnabled");
    assignRange(next, body, "maxStrategyCapitalUsd", 25, RWA_MAX_STRATEGY_CAPITAL_USD);
    assignRange(next, body, "maxEntryBasisBps", 0, 80);
    assignRange(next, body, "maxCombinedSlippageBps", 1, 20);
    assignRange(next, body, "minNetAprPercent", 8, 100);
    assignRange(next, body, "minLiquidationDistancePercent", 30, 100);
    assignRange(next, body, "maxUnhedgedMs", 1_000, 10_000);
    state.config = next;
    await this.store.writeState(state);
    return publicConfig(this.store.ownerUserId, next, metadata?.accountId ?? null, this.serverKillSwitchActive());
  }

  async setKillSwitch(active: boolean, accountId?: string) {
    const state = await this.store.readState();
    const metadata = await this.store.readCredentialMetadata();
    if (metadata) assertAccountId(requiredString(accountId, "accountId", 100), metadata.accountId);
    state.config.killSwitchActive = active;
    state.challenges = [];
    await this.store.writeState(state);
    return {
      active,
      userId: this.store.ownerUserId,
      accountId: metadata?.accountId ?? null,
      config: publicConfig(this.store.ownerUserId, state.config, metadata?.accountId ?? null, this.serverKillSwitchActive()),
    };
  }

  async getPrivateAccount() {
    const metadata = await this.requireMetadata();
    const snapshot = await this.client().then((client) => client.readPreflightSnapshot())
      .catch((error) => { throw providerError(error, "Binance 私有账户读取失败。"); });
    assertAccountId(snapshot.accountId, metadata.accountId);
    return {
      network: "binance_mainnet" as const,
      phase: "phase_1_read_only_shadow" as const,
      providerWritesEnabled: false,
      userId: this.store.ownerUserId,
      accountId: snapshot.accountId,
      accountFingerprint: snapshot.accountFingerprint,
      strategyId: RWA_BINANCE_STRATEGY_ID,
      accountMode: snapshot.accountMode,
      permissions: snapshot.permissions,
      productAvailability: snapshot.productAvailability,
      balances: {
        spotAvailableUsdt: snapshot.spotAvailableUsdt,
        futuresAvailableUsdt: snapshot.futuresAvailableUsdt,
        spotXaut: snapshot.existingSpotQuantityXaut,
        perpetualXaut: snapshot.existingPerpetualQuantityXaut,
      },
      openOrders: {
        spot: snapshot.openSpotOrderCount,
        perpetual: snapshot.openPerpetualOrderCount,
      },
      instruments: { spot: snapshot.spot, perpetual: snapshot.perpetual },
      fees: snapshot.fees,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  async getPnl() {
    const metadata = await this.store.readCredentialMetadata();
    return {
      userId: this.store.ownerUserId,
      accountId: metadata?.accountId ?? null,
      current: null,
      series: [],
      history: [],
      phase: "phase_1_read_only_shadow",
      providerWritesEnabled: false,
      message: "Binance 第一阶段未发送策略订单，因此不把账户已有余额或仓位冒充为策略 PnL。",
    };
  }

  async getAudit() {
    const state = await this.store.readState();
    return {
      items: state.credentialAudit.slice(-200).reverse(),
      alert: state.credentialAlert,
      phase: "phase_1_read_only_shadow",
      providerWritesEnabled: false,
    };
  }

  async preflight(opportunity: ArbitrageOpportunity, accountId: string, mode: RwaAutomationMode): Promise<never> {
    assertSupportedOpportunity(opportunity, mode);
    const metadata = await this.requireMetadata();
    assertAccountId(accountId, metadata.accountId);
    const productAvailability = await this.getProductAvailability();
    if (!productAvailability.available) {
      throw new RwaNeutralExecutionError(
        409,
        "binance_product_unavailable",
        productAvailability.message ?? "Binance Mainnet 当前无法组成 XAUT 同所中性双腿。",
        { productAvailability },
      );
    }
    const snapshot = await this.client().then((client) => client.readPreflightSnapshot())
      .catch((error) => { throw providerError(error, "Binance 实时 preflight 读取失败。"); });
    assertAccountId(snapshot.accountId, accountId);
    const config = (await this.store.readState()).config;
    const report = buildShadowPreflight(this.store.ownerUserId, opportunity, snapshot, config, mode, this.now());
    throw new RwaNeutralExecutionError(
      409,
      report.marketChecksPassed ? "binance_provider_writes_disabled" : "preflight_rejected",
      report.marketChecksPassed
        ? "Binance 第一阶段只完成 Shadow/preflight，真实 provider 写调用保持关闭。"
        : "Binance Shadow/preflight 未通过，禁止进入真实执行。",
      { report },
    );
  }

  execute(): never {
    throw new RwaNeutralExecutionError(
      501,
      "binance_provider_writes_disabled",
      "Binance 第一阶段未实现下单、撤单、补腿、杠杆或平仓写调用。",
    );
  }

  closeAll(): never {
    throw new RwaNeutralExecutionError(
      501,
      "binance_provider_writes_disabled",
      "Binance 第一阶段没有平台代理退出能力；如账户已有风险，请直接在 Binance 人工处理。",
    );
  }

  private async client(): Promise<RwaBinanceClient> {
    if (!this.store.masterKeyConfigured) {
      throw new RwaNeutralExecutionError(503, "master_key_unavailable", this.store.masterKeyError ?? "主密钥不可用。");
    }
    try {
      return this.clientFactory(await this.store.loadCredentials());
    } catch {
      throw new RwaNeutralExecutionError(503, "credential_unavailable", "Binance API 凭证不可用；已拒绝私有请求。");
    }
  }

  private async requireMetadata() {
    const metadata = await this.store.readCredentialMetadata();
    if (!metadata) throw new RwaNeutralExecutionError(409, "credential_not_configured", "Binance API 凭证尚未配置。");
    return metadata;
  }

  private status(input: {
    metadata?: BinanceCredentialMetadata | null;
    stored: boolean;
    connectionStatus: "not_configured" | "verified" | "invalid" | "unavailable";
    lifecycleStatus: RwaCredentialLifecycle;
    message: string | null;
  }) {
    const metadata = input.metadata ?? null;
    const permissions = metadata?.permissions ?? null;
    return {
      userId: this.store.ownerUserId,
      accountId: metadata?.accountId ?? null,
      accountFingerprint: metadata?.accountFingerprint ?? null,
      stored: input.stored,
      masterKeyConfigured: this.store.masterKeyConfigured,
      maskedApiKey: metadata?.maskedApiKey ?? null,
      connectionStatus: input.connectionStatus,
      lifecycleStatus: input.lifecycleStatus,
      accountMode: metadata?.accountMode ?? null,
      permissions,
      lastVerifiedAt: metadata?.lastVerifiedAt ?? null,
      updatedAt: metadata?.updatedAt ?? null,
      message: input.message,
      ipWhitelistConfigured: permissions?.ipRestricted ?? null,
      warnings: permissions && !permissions.ipRestricted
        ? ["API Key 未配置固定 IP 白名单；这是高风险配置，但 Binance 第一阶段不将其作为硬阻断。"]
        : [],
    };
  }
}

function buildShadowPreflight(
  userId: string,
  opportunity: ArbitrageOpportunity,
  snapshot: RwaBinancePreflightSnapshot,
  config: RwaExecutionConfig,
  mode: RwaAutomationMode,
  now: number,
) {
  const commonStep = Math.max(snapshot.spot.qtyStep, snapshot.perpetual.qtyStep);
  const budgetQuantity = commonStep > 0
    ? floorStep(RWA_BINANCE_TOTAL_BUDGET_USD * 0.95 / (snapshot.spot.ask + snapshot.perpetual.bid), commonStep)
    : 0;
  const quantityXaut = budgetQuantity;
  const spotNotional = quantityXaut * snapshot.spot.ask;
  const perpetualNotional = quantityXaut * snapshot.perpetual.bid;
  const feesUsd = (spotNotional * snapshot.fees.spotTakerBps + perpetualNotional * snapshot.fees.perpetualTakerBps) / 10_000;
  const slippageReserveUsd = (spotNotional + perpetualNotional) * config.maxCombinedSlippageBps / 10_000;
  const capitalRequired = spotNotional + perpetualNotional + feesUsd + slippageReserveUsd;
  const entryBasisBps = snapshot.spot.ask > 0
    ? (snapshot.perpetual.bid - snapshot.spot.ask) / snapshot.spot.ask * 10_000
    : Number.POSITIVE_INFINITY;
  const fundingPeriodsPerYear = snapshot.perpetual.fundingIntervalHours > 0
    ? 24 / snapshot.perpetual.fundingIntervalHours * 365
    : 0;
  const estimatedNetAprPercent = snapshot.perpetual.fundingRate * fundingPeriodsPerYear * 100
    - (snapshot.fees.spotTakerBps + snapshot.fees.perpetualTakerBps + config.maxCombinedSlippageBps) / 100;
  const checks = [
    check("product_pair", snapshot.productAvailability.available, true, "Binance Mainnet 必须同时存在 XAUTUSDT 现货与 USD-M 永续。"),
    check("permissions", permissionsValid(snapshot.permissions), true, "必须具备读取、现货交易和 USD-M Futures 交易权限，且提现权限关闭。"),
    check("position_mode", snapshot.permissions.positionModeSupported, true, "第一阶段只接受 one-way 持仓模式；hedge mode 暂不放行。"),
    check("spot_trading", snapshot.spot.status === "Trading", "Trading", "XAUTUSDT 现货必须为 TRADING。"),
    check("perpetual_trading", snapshot.perpetual.status === "Trading", "Trading", "XAUTUSDT USD-M 永续必须为 TRADING。"),
    check("quotes", snapshot.spot.bid > 0 && snapshot.spot.ask > 0 && snapshot.perpetual.bid > 0 && snapshot.perpetual.ask > 0, true, "两腿 Bid/Ask 必须完整。"),
    check("precision", quantityXaut > 0 && stepAligned(quantityXaut, snapshot.spot.qtyStep) && stepAligned(quantityXaut, snapshot.perpetual.qtyStep), true, "数量必须同时匹配现货和永续步长。"),
    check("spot_minimum", quantityXaut >= snapshot.spot.minOrderQty && spotNotional >= snapshot.spot.minNotionalUsd, true, "现货数量和名义必须达到实时最小值。"),
    check("perpetual_minimum", quantityXaut >= snapshot.perpetual.minOrderQty && perpetualNotional >= snapshot.perpetual.minNotionalUsd, true, "永续数量和名义必须达到实时最小值。"),
    check("spot_balance", snapshot.spotAvailableUsdt >= spotNotional + feesUsd, spotNotional + feesUsd, "现货账户 USDT 必须独立覆盖现货腿。"),
    check("futures_balance", snapshot.futuresAvailableUsdt >= perpetualNotional + feesUsd, perpetualNotional + feesUsd, "USD-M Futures 可用余额必须独立覆盖永续腿。"),
    check("no_existing_spot", snapshot.existingSpotQuantityXaut <= 1e-9 && snapshot.openSpotOrderCount === 0, 0, "专用账户不得已有 XAUT 现货或活动现货订单。"),
    check("no_existing_perpetual", snapshot.existingPerpetualQuantityXaut <= 1e-9 && snapshot.openPerpetualOrderCount === 0, 0, "专用账户不得已有 XAUT 永续仓位或活动合约订单。"),
    check("depth", snapshot.spot.depthUsd >= spotNotional && snapshot.perpetual.depthUsd >= perpetualNotional, true, "两腿公开盘口深度必须覆盖计划名义。"),
    check("total_budget", capitalRequired <= RWA_BINANCE_TOTAL_BUDGET_USD, RWA_BINANCE_TOTAL_BUDGET_USD, "两腿 1x 名义、手续费和滑点准备金必须在 25 USDT 总预算内。"),
    check("strategy_cap", capitalRequired <= config.maxStrategyCapitalUsd && config.maxStrategyCapitalUsd <= RWA_MAX_STRATEGY_CAPITAL_USD, config.maxStrategyCapitalUsd, "venue 资本上限不得超过 300 USDT。"),
    check("liquidation", snapshot.perpetual.liquidationDistancePercent === null
      || snapshot.perpetual.liquidationDistancePercent >= config.minLiquidationDistancePercent, config.minLiquidationDistancePercent, "已有仓位强平距离不得低于门限。"),
    check("freshness", now - snapshot.fetchedAt <= RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS, RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS, "私有账户与市场快照必须新鲜。"),
  ];
  if (mode === "arbitrage_entry") {
    checks.push(
      check("funding_direction", snapshot.perpetual.fundingRate > 0, "> 0", "永续空头必须处于收取 Funding 方向。"),
      check("entry_basis", Math.abs(entryBasisBps) <= config.maxEntryBasisBps, config.maxEntryBasisBps, "入场基差绝对值不得超过门限。"),
      check("net_apr", estimatedNetAprPercent >= config.minNetAprPercent, config.minNetAprPercent, "估算净 APR 必须达到自动策略门限。"),
    );
  }
  const warnings = snapshot.permissions.ipRestricted
    ? []
    : ["Binance API Key 未配置固定 IP 白名单；这是高风险配置。"];
  if (mode === "manual_entry") {
    if (snapshot.perpetual.fundingRate <= 0) warnings.push("当前空头腿未处于收取 Funding 状态。");
    if (Math.abs(entryBasisBps) > config.maxEntryBasisBps) warnings.push("当前入场基差超过自动策略门限。");
    if (estimatedNetAprPercent < config.minNetAprPercent) warnings.push("当前估算净 APR 低于自动策略门限。");
  }
  const marketChecksPassed = checks.every((item) => item.passed);
  return {
    userId,
    accountId: snapshot.accountId,
    accountFingerprint: snapshot.accountFingerprint,
    network: "binance_mainnet",
    venue: "binance",
    phase: "phase_1_read_only_shadow",
    providerWritesEnabled: false,
    strategyId: RWA_BINANCE_STRATEGY_ID,
    opportunityId: opportunity.id,
    mode,
    productAvailability: snapshot.productAvailability,
    quantityXaut,
    totalBudgetUsd: RWA_BINANCE_TOTAL_BUDGET_USD,
    estimatedSpotNotionalUsd: spotNotional,
    estimatedPerpetualNotionalUsd: perpetualNotional,
    estimatedCapitalRequiredUsd: capitalRequired,
    referenceSpotAsk: snapshot.spot.ask,
    referencePerpetualBid: snapshot.perpetual.bid,
    entryBasisBps,
    fundingRate: snapshot.perpetual.fundingRate,
    estimatedNetAprPercent,
    checks,
    warnings,
    marketChecksPassed,
    passed: false,
    generatedAt: now,
    message: marketChecksPassed
      ? "市场与账户只读检查通过，但 Binance 第一阶段不签发执行 challenge。"
      : "市场或账户只读检查未通过。",
  };
}

function assertSupportedOpportunity(opportunity: ArbitrageOpportunity, mode: RwaAutomationMode) {
  if (
    (mode !== "arbitrage_entry" && mode !== "manual_entry")
    || opportunity.strategyType !== "same_venue_neutral"
    || opportunity.longLeg.venue !== "binance"
    || opportunity.shortLeg.venue !== "binance"
    || opportunity.longLeg.kind !== "spot"
    || opportunity.shortLeg.kind !== "perpetual"
    || opportunity.longLeg.asset !== "XAUT"
    || opportunity.shortLeg.asset !== "XAUT"
    || opportunity.disqualifiers.length > 0
    || (mode === "arbitrage_entry" && !opportunity.automationEligible)
  ) {
    throw new RwaNeutralExecutionError(
      409,
      "adapter_opportunity_unsupported",
      "Binance 第一阶段仅评估安全可执行的 XAUT 同所现货多头 + USD-M 永续空头机会。",
    );
  }
}

function publicConfig(userId: string, config: RwaExecutionConfig, accountId: string | null, serverGlobalKillSwitchActive: boolean) {
  return {
    userId,
    accountId,
    ...config,
    globalExecutionEnabled: false,
    strategyEnabled: false,
    serverGlobalKillSwitchActive,
    venue: "binance",
    phase: "phase_1_read_only_shadow",
    providerWritesEnabled: false,
  };
}

function assertPermissions(value: RwaBinancePermissions) {
  if (!permissionsValid(value)) {
    throw new RwaNeutralExecutionError(
      409,
      "permission_rejected",
      "Binance Key 必须具备读取、现货交易与 USD-M Futures 交易权限，禁止提现，并使用当前支持的 one-way 持仓模式。",
    );
  }
}

function permissionsValid(value: RwaBinancePermissions) {
  return value.read
    && value.spotTrade
    && value.contractTrade
    && !value.withdraw
    && value.spotAccount
    && value.futuresAccount
    && value.positionModeSupported;
}

function credentialFailureLifecycle(error: unknown): Exclude<RwaCredentialLifecycle, "unconfigured" | "validating" | "active"> {
  if (error instanceof RwaBinanceProviderError && ["provider_credential_invalid", "provider_permission_error"].includes(error.category)) {
    return "revoked";
  }
  return "invalid";
}

function providerError(error: unknown, fallback: string) {
  if (error instanceof RwaNeutralExecutionError) return error;
  if (error instanceof RwaBinanceProviderError) return new RwaNeutralExecutionError(502, error.category, error.message);
  return new RwaNeutralExecutionError(502, "provider_unavailable", fallback);
}

function assertAccountId(actual: string, expected: string) {
  if (actual !== expected) {
    throw new RwaNeutralExecutionError(409, "account_mismatch", "accountId 与当前 Binance 执行账户不匹配，已拒绝操作。");
  }
}

function assignRange(
  target: RwaExecutionConfig,
  body: Record<string, unknown>,
  key: keyof RwaExecutionConfig,
  minimum: number,
  maximum: number,
) {
  if (!(key in body)) return;
  const value = Number(body[key]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RwaNeutralExecutionError(400, "invalid_request", `${key} 必须在 ${minimum} 到 ${maximum} 之间。`);
  }
  (target[key] as number) = value;
}

function booleanField(value: unknown, field: string) {
  if (typeof value !== "boolean") throw new RwaNeutralExecutionError(400, "invalid_request", `${field} 必须是布尔值。`);
  return value;
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new RwaNeutralExecutionError(400, "invalid_request", `请求包含不支持的字段：${unknown.join("、")}。`);
}

function requiredString(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new RwaNeutralExecutionError(400, "invalid_request", `${field} 格式无效。`);
  }
  return value.trim();
}

function check(name: string, passed: boolean, limit: number | string | boolean, message: string) {
  return { name, passed, limit, message };
}

function floorStep(value: number, step: number) {
  return step > 0 ? Math.floor((value + 1e-12) / step) * step : 0;
}

function stepAligned(value: number, step: number) {
  if (!(step > 0)) return false;
  return Math.abs(value / step - Math.round(value / step)) <= 1e-8;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export const binancePhaseOneDefaultConfig = { ...defaultRwaExecutionConfig };
