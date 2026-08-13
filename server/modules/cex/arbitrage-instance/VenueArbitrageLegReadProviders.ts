import { BinanceAccountReadProvider } from "../../account-read/BinanceAccountReadProvider";
import { BitgetAccountReadProvider } from "../../account-read/BitgetAccountReadProvider";
import { BybitAccountReadProvider } from "../../account-read/BybitAccountReadProvider";
import { OkxAccountReadProvider } from "../../account-read/OkxAccountReadProvider";
import type { VenueAccountReadSnapshot } from "../../account-read/AccountReadTypes";
import { BinanceClient } from "../../binance/BinanceClient";
import type { BinancePerpetualPositionSnapshot } from "../../binance/BinanceTypes";
import { BitgetAccountReadClient, type BitgetPerpetualPositionSnapshot } from "../../bitget/BitgetAccountReadClient";
import { BybitAccountReadClient, type BybitPerpetualPositionSnapshot } from "../../bybit/BybitAccountReadClient";
import type { ExecutionVenue } from "../ExecutionIntent";
import type { InstrumentCatalogPort } from "../CexCapabilityPorts";
import { canonicalInstrumentFromId } from "../Instrument";
import { InstrumentCapability } from "../InstrumentCapability";
import { OkxAccountReadClient, OkxAccountReadError, type OkxPerpetualPositionSnapshot } from "../../okx/OkxAccountReadClient";
import type { UserExchangeCredentialSecret } from "../../credentials/UserExchangeCredentialStore";
import type {
  ArbitrageLegObservedState,
  ArbitrageLegReadProvider,
  ArbitrageLegReadProviderFactory,
} from "./ArbitragePositionVerification";
import type { ArbitrageInstanceLeg } from "./ArbitrageInstance";

type PositionSnapshot =
  | BinancePerpetualPositionSnapshot
  | OkxPerpetualPositionSnapshot
  | BybitPerpetualPositionSnapshot
  | BitgetPerpetualPositionSnapshot;

type VerificationClient = Readonly<{
  readAccountSnapshot(): Promise<unknown>;
  readPerpetualPosition(providerSymbol: string, expectedSide?: "long" | "short"): Promise<PositionSnapshot>;
}>;

type AccountReader = Readonly<{
  readAccount(): Promise<VenueAccountReadSnapshot>;
  dispose(): void | Promise<void>;
}>;

export type VerificationInstrumentBinding = Readonly<{
  providerSymbol: string;
  contractSize: string;
}>;

export type VerificationInstrumentResolver = Readonly<{
  resolve(venue: ExecutionVenue, instrumentId: string): Promise<VerificationInstrumentBinding | null>;
}>;

export class ConventionVerificationInstrumentResolver implements VerificationInstrumentResolver {
  constructor(private readonly instrumentCapability = new InstrumentCapability()) {}

  async resolve(venue: ExecutionVenue, instrumentId: string) {
    const instrument = canonicalInstrumentFromId(instrumentId);
    const venueInstrument = this.instrumentCapability.resolveVenueInstrument(instrument, venue);
    if (venue === "okx" && instrument.contractType === "perpetual") return null;
    return Object.freeze({ providerSymbol: venueInstrument.symbol, contractSize: "1" });
  }
}

export class CatalogVerificationInstrumentResolver implements VerificationInstrumentResolver {
  private readonly catalogs: ReadonlyMap<ExecutionVenue, InstrumentCatalogPort>;

  constructor(catalogs: readonly InstrumentCatalogPort[]) {
    this.catalogs = new Map(catalogs.map((catalog) => [catalog.venue, catalog]));
  }

  async resolve(venue: ExecutionVenue, instrumentId: string) {
    const instrument = await this.catalogs.get(venue)?.getInstrument(instrumentId);
    if (!instrument || instrument.venue !== venue) return null;
    return Object.freeze({
      providerSymbol: instrument.providerSymbol,
      contractSize: decimalFromNumber(instrument.contractSize),
    });
  }
}

export class VenueArbitrageLegReadProvider implements ArbitrageLegReadProvider {
  constructor(
    readonly venue: ExecutionVenue,
    private client: VerificationClient | null,
    private accountReader: AccountReader | null,
    private readonly instruments: VerificationInstrumentResolver,
  ) {}

  async readLeg(leg: ArbitrageInstanceLeg): Promise<ArbitrageLegObservedState> {
    const client = this.client;
    const accountReader = this.accountReader;
    if (!client || !accountReader) throw new Error(`${this.venue} verification provider has been disposed.`);
    if (leg.venue !== this.venue) throw new Error("Arbitrage leg venue does not match verification provider.");
    const account = await accountReader.readAccount();
    if (account.accountId !== leg.accountId && !isCredentialOnlyBinding(this.venue, leg.accountId)) {
      throw new Error("Arbitrage leg account does not match the authenticated credential.");
    }
    const instrument = canonicalInstrumentFromId(leg.instrumentId);
    if (instrument.contractType === "spot") {
      if (leg.role !== "LONG") throw new Error("Spot short quantity cannot be verified from an account balance.");
      if (!account.accountTypes.some((accountType) => accountType === "spot" || accountType === "unified")) {
        throw new Error("Provider account data cannot reliably represent a spot balance.");
      }
      const balances = account.balances.filter((balance) => balance.asset === instrument.baseAsset
        && (balance.accountType === "spot" || balance.accountType === "unified"));
      if (!balances.length) return { actualQuantity: "0", direction: "FLAT", observedAt: account.latestSyncAt };
      const total = sumNumbers(balances.map((balance) => balance.total));
      return {
        actualQuantity: decimalFromNumber(total),
        direction: total === 0 ? "FLAT" : "LONG",
        observedAt: account.latestSyncAt,
      };
    }
    const binding = await this.instruments.resolve(this.venue, leg.instrumentId);
    if (!binding) throw new Error("Provider instrument mapping is unavailable.");
    const position = await client.readPerpetualPosition(
      binding.providerSymbol,
      leg.role === "LONG" ? "long" : "short",
    );
    const rawQuantity = "contractQuantity" in position ? position.contractQuantity : position.baseQuantity;
    return {
      actualQuantity: multiplyDecimals(rawQuantity, binding.contractSize),
      direction: position.side === "long" ? "LONG" : position.side === "short" ? "SHORT" : "FLAT",
      observedAt: position.updatedAt,
    };
  }

  async dispose() {
    const accountReader = this.accountReader;
    this.client = null;
    this.accountReader = null;
    await accountReader?.dispose();
  }
}

function isCredentialOnlyBinding(venue: ExecutionVenue, accountId: string) {
  return accountId.startsWith(`${venue}:credential-only:`);
}

export class BinanceArbitrageLegReadProviderFactory implements ArbitrageLegReadProviderFactory {
  readonly venue = "binance" as const;
  constructor(
    private readonly instruments: VerificationInstrumentResolver = new ConventionVerificationInstrumentResolver(),
    private readonly clientFactory: (secret: UserExchangeCredentialSecret) => BinanceClient =
      (secret) => new BinanceClient({ apiKey: secret.apiKey, apiSecret: secret.apiSecret }),
  ) {}
  create(secret: UserExchangeCredentialSecret) {
    const client = this.clientFactory(secret);
    return new VenueArbitrageLegReadProvider(this.venue, client, new BinanceAccountReadProvider(client), this.instruments);
  }
}

export class OkxArbitrageLegReadProviderFactory implements ArbitrageLegReadProviderFactory {
  readonly venue = "okx" as const;
  constructor(
    private readonly instruments: VerificationInstrumentResolver = new ConventionVerificationInstrumentResolver(),
    private readonly clientFactory: (secret: UserExchangeCredentialSecret) => OkxAccountReadClient = (secret) => {
      if (!secret.passphrase?.trim()) throw new OkxAccountReadError("credential_validation_failed", "OKX passphrase is required.");
      return new OkxAccountReadClient({ apiKey: secret.apiKey, apiSecret: secret.apiSecret, passphrase: secret.passphrase });
    },
  ) {}
  create(secret: UserExchangeCredentialSecret) {
    const client = this.clientFactory(secret);
    return new VenueArbitrageLegReadProvider(this.venue, client, new OkxAccountReadProvider(client), this.instruments);
  }
}

export class BybitArbitrageLegReadProviderFactory implements ArbitrageLegReadProviderFactory {
  readonly venue = "bybit" as const;
  constructor(
    private readonly instruments: VerificationInstrumentResolver = new ConventionVerificationInstrumentResolver(),
    private readonly clientFactory: (secret: UserExchangeCredentialSecret) => BybitAccountReadClient =
      (secret) => new BybitAccountReadClient({ apiKey: secret.apiKey, apiSecret: secret.apiSecret }),
  ) {}
  create(secret: UserExchangeCredentialSecret) {
    const client = this.clientFactory(secret);
    return new VenueArbitrageLegReadProvider(this.venue, client, new BybitAccountReadProvider(client), this.instruments);
  }
}

export class BitgetArbitrageLegReadProviderFactory implements ArbitrageLegReadProviderFactory {
  readonly venue = "bitget" as const;
  constructor(
    private readonly instruments: VerificationInstrumentResolver = new ConventionVerificationInstrumentResolver(),
    private readonly clientFactory: (secret: UserExchangeCredentialSecret) => BitgetAccountReadClient = (secret) => {
      if (!secret.passphrase?.trim()) throw new Error("Bitget passphrase is required.");
      return new BitgetAccountReadClient({ apiKey: secret.apiKey, apiSecret: secret.apiSecret, passphrase: secret.passphrase });
    },
  ) {}
  create(secret: UserExchangeCredentialSecret) {
    const client = this.clientFactory(secret);
    return new VenueArbitrageLegReadProvider(this.venue, client, new BitgetAccountReadProvider(client), this.instruments);
  }
}

function sumNumbers(values: readonly number[]) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total < 0) throw new Error("Account balance quantity is invalid.");
  return total;
}

function decimalFromNumber(value: number) {
  return value.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 15 });
}

function multiplyDecimals(left: string, right: string) {
  const lhs = parseDecimal(left);
  const rhs = parseDecimal(right);
  return formatDecimal(lhs.value * rhs.value, lhs.scale + rhs.scale);
}

function parseDecimal(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw new Error("Position quantity is invalid.");
  const [integer, fraction = ""] = value.split(".");
  return { value: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function formatDecimal(value: bigint, scale: number) {
  if (value === 0n) return "0";
  const digits = value.toString().padStart(scale + 1, "0");
  if (!scale) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction ? `${digits.slice(0, -scale)}.${fraction}` : digits.slice(0, -scale);
}
