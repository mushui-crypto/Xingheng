import { BinanceAccountReadProvider } from "../../account-read/BinanceAccountReadProvider";
import { BitgetAccountReadProvider } from "../../account-read/BitgetAccountReadProvider";
import { BybitAccountReadProvider } from "../../account-read/BybitAccountReadProvider";
import { OkxAccountReadProvider } from "../../account-read/OkxAccountReadProvider";
import type { VenueAccountReadSnapshot } from "../../account-read/AccountReadTypes";
import { BinanceClient } from "../../binance/BinanceClient";
import type {
  BinancePerpetualPositionSnapshot,
  BinanceReadOnlyAccountSnapshot,
} from "../../binance/BinanceTypes";
import { BitgetAccountReadClient, type BitgetPerpetualPositionSnapshot } from "../../bitget/BitgetAccountReadClient";
import type { BitgetAccountReadSnapshot } from "../../bitget/BitgetAccountReadClient";
import { BybitAccountReadClient, type BybitAccountReadSnapshot, type BybitPerpetualPositionSnapshot } from "../../bybit/BybitAccountReadClient";
import type { ExecutionVenue } from "../ExecutionIntent";
import type { InstrumentCatalogPort } from "../CexCapabilityPorts";
import { canonicalInstrumentFromId } from "../Instrument";
import { InstrumentCapability } from "../InstrumentCapability";
import { OkxAccountReadClient, OkxAccountReadError, type OkxAccountReadSnapshot, type OkxPerpetualPositionSnapshot } from "../../okx/OkxAccountReadClient";
import type { UserExchangeCredentialSecret } from "../../credentials/UserExchangeCredentialStore";
import type {
  ArbitrageLegObservedState,
  ArbitrageLegReadProvider,
  ArbitrageLegReadProviderFactory,
} from "./ArbitragePositionVerification";
import { ArbitrageLegReadError } from "./ArbitragePositionVerification";
import type { ArbitrageInstanceLeg } from "./ArbitrageInstance";
import { managedCurrentQuantity } from "./ArbitrageInstance";

type PositionSnapshot =
  | BinancePerpetualPositionSnapshot
  | OkxPerpetualPositionSnapshot
  | BybitPerpetualPositionSnapshot
  | BitgetPerpetualPositionSnapshot;

type VerificationClient = Readonly<{
  readAccountSnapshot(): Promise<unknown>;
  readPerpetualPosition(providerSymbol: string, expectedSide?: "long" | "short"): Promise<PositionSnapshot>;
}>;

type BinanceVerificationClient = VerificationClient & Readonly<{
  readAccountSnapshot(): Promise<BinanceReadOnlyAccountSnapshot>;
  readPerpetualPosition(providerSymbol: string, expectedSide?: "long" | "short"): Promise<BinancePerpetualPositionSnapshot>;
}>;

type OkxVerificationClient = VerificationClient & Readonly<{
  readAccountSnapshot(): Promise<OkxAccountReadSnapshot>;
  readPerpetualPosition(providerSymbol: string, expectedSide?: "long" | "short"): Promise<OkxPerpetualPositionSnapshot>;
  dispose?(): void | Promise<void>;
}>;

type BybitVerificationClient = VerificationClient & Readonly<{
  readAccountSnapshot(): Promise<BybitAccountReadSnapshot>;
  readPerpetualPosition(providerSymbol: string, expectedSide?: "long" | "short"): Promise<BybitPerpetualPositionSnapshot>;
  dispose?(): void | Promise<void>;
}>;

type BitgetVerificationClient = VerificationClient & Readonly<{
  readAccountSnapshot(): Promise<BitgetAccountReadSnapshot>;
  readPerpetualPosition(providerSymbol: string, expectedSide?: "long" | "short"): Promise<BitgetPerpetualPositionSnapshot>;
  dispose?(): void | Promise<void>;
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
  private readonly catalogs: ReadonlyMap<
    ExecutionVenue,
    Pick<InstrumentCatalogPort, "venue" | "listInstruments">
  >;

  constructor(catalogs: readonly Pick<InstrumentCatalogPort, "venue" | "listInstruments">[]) {
    this.catalogs = new Map(catalogs.map((catalog) => [catalog.venue, catalog]));
  }

  async resolve(venue: ExecutionVenue, instrumentId: string) {
    if (venue === "binance") {
      const instrument = canonicalInstrumentFromId(instrumentId);
      return Object.freeze({ providerSymbol: `${instrument.baseAsset}${instrument.quoteAsset}`, contractSize: "1" });
    }
    const instruments = await this.catalogs.get(venue)?.listInstruments();
    const instrument = instruments?.find((candidate) => candidate.instrumentId === instrumentId);
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
      throw new ArbitrageLegReadError("account_identity_mismatch", "Arbitrage leg account does not match the authenticated credential.");
    }
    const instrument = canonicalInstrumentFromId(leg.instrumentId);
    if (instrument.contractType === "spot") {
      if (leg.role !== "LONG") throw new Error("Spot short quantity cannot be verified from an account balance.");
      if (!account.accountTypes.some((accountType) => accountType === "spot" || accountType === "unified")) {
        throw new Error("Provider account data cannot reliably represent a spot balance.");
      }
      const balances = account.balances.filter((balance) => balance.asset === instrument.baseAsset
        && (balance.accountType === "spot" || balance.accountType === "unified"));
      const available = balances.every((balance) => balance.available !== null)
        ? decimalFromNumber(sumNumbers(balances.map((balance) => balance.available!)))
        : null;
      const managedQuantity = managedCurrentQuantity(leg);
      return {
        actualQuantity: managedQuantity,
        availableQuantity: balances.length ? available : "0",
        direction: managedQuantity === "0" ? "FLAT" : "LONG",
        observedAt: account.latestSyncAt,
      };
    }
    const binding = await this.instruments.resolve(this.venue, leg.instrumentId);
    if (!binding) throw new ArbitrageLegReadError("instrument_mapping_unavailable", "Provider instrument mapping is unavailable.");
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
    private readonly clientFactory: (secret: UserExchangeCredentialSecret) => BinanceVerificationClient =
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
    private readonly clientFactory: (secret: UserExchangeCredentialSecret) => OkxVerificationClient = (secret) => {
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
    private readonly clientFactory: (secret: UserExchangeCredentialSecret) => BybitVerificationClient =
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
    private readonly clientFactory: (secret: UserExchangeCredentialSecret) => BitgetVerificationClient = (secret) => {
      if (!secret.passphrase?.trim()) throw new Error("Bitget passphrase is required.");
      return new BitgetAccountReadClient({ apiKey: secret.apiKey, apiSecret: secret.apiSecret, passphrase: secret.passphrase });
    },
  ) {}
  create(secret: UserExchangeCredentialSecret) {
    const client = this.clientFactory(secret);
    return new VenueArbitrageLegReadProvider(this.venue, client, new BitgetAccountReadProvider(client), this.instruments);
  }
}

export type ArbitrageVerificationClientFactories = Readonly<{
  binance?: (secret: UserExchangeCredentialSecret) => BinanceVerificationClient;
  okx?: (secret: UserExchangeCredentialSecret) => OkxVerificationClient;
  bybit?: (secret: UserExchangeCredentialSecret) => BybitVerificationClient;
  bitget?: (secret: UserExchangeCredentialSecret) => BitgetVerificationClient;
}>;

export function createVenueArbitrageLegReadProviderFactories(
  instruments: VerificationInstrumentResolver,
  clients: ArbitrageVerificationClientFactories = {},
) {
  return Object.freeze([
    new BinanceArbitrageLegReadProviderFactory(instruments, clients.binance),
    new OkxArbitrageLegReadProviderFactory(instruments, clients.okx),
    new BybitArbitrageLegReadProviderFactory(instruments, clients.bybit),
    new BitgetArbitrageLegReadProviderFactory(instruments, clients.bitget),
  ]);
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
