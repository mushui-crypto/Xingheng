import {
  canonicalInstrumentFromId,
  type CanonicalInstrument,
} from "../cex/Instrument";

export type OkxInstrumentMappingRecord = Readonly<{
  canonicalInstrumentId: string;
  instId: string;
  contractType: "linear_perpetual";
}>;

export type OkxQuantityRulesReference = Readonly<{
  source: "okx-instruments";
  instType: "SWAP";
  instId: string;
  fields: readonly ["lotSz", "minSz", "ctVal", "tickSz"];
}>;

export type OkxVenueInstrument = Readonly<{
  venue: "okx";
  instId: string;
  contractType: "linear_perpetual";
  quantityRulesReference: OkxQuantityRulesReference;
}>;

export type OkxInstrumentResolution = Readonly<{
  canonicalInstrument: CanonicalInstrument;
  venueInstrument: OkxVenueInstrument;
}>;

const OKX_QUANTITY_RULE_FIELDS = Object.freeze(["lotSz", "minSz", "ctVal", "tickSz"] as const);

const DEFAULT_OKX_INSTRUMENT_MAPPINGS = Object.freeze([
  Object.freeze({
    canonicalInstrumentId: "DOGE-USDT-PERP",
    instId: "DOGE-USDT-SWAP",
    contractType: "linear_perpetual",
  }),
] satisfies readonly OkxInstrumentMappingRecord[]);

export class OkxInstrumentMappingAdapter {
  private readonly records: ReadonlyMap<string, OkxInstrumentMappingRecord>;

  constructor(records: readonly OkxInstrumentMappingRecord[] = DEFAULT_OKX_INSTRUMENT_MAPPINGS) {
    this.records = buildRecordMap(records);
  }

  resolve(canonicalInstrument: string | CanonicalInstrument): OkxInstrumentResolution {
    const canonical = normalizeCanonicalInstrument(canonicalInstrument);
    const record = this.records.get(canonical.instrumentId);
    if (!record) {
      throw new Error(`Unsupported OKX instrument: ${canonical.instrumentId}.`);
    }
    return Object.freeze({
      canonicalInstrument: canonical,
      venueInstrument: Object.freeze({
        venue: "okx",
        instId: record.instId,
        contractType: record.contractType,
        quantityRulesReference: quantityRulesReference(record.instId),
      }),
    });
  }
}

function buildRecordMap(records: readonly OkxInstrumentMappingRecord[]) {
  const map = new Map<string, OkxInstrumentMappingRecord>();
  for (const record of records) {
    const normalized = validateMappingRecord(record);
    if (map.has(normalized.canonicalInstrumentId)) {
      throw new Error(`Invalid OKX instrument mapping: duplicate ${normalized.canonicalInstrumentId}.`);
    }
    map.set(normalized.canonicalInstrumentId, normalized);
  }
  return map;
}

function validateMappingRecord(record: OkxInstrumentMappingRecord): OkxInstrumentMappingRecord {
  const canonical = canonicalInstrumentFromId(record.canonicalInstrumentId);
  if (canonical.contractType !== "perpetual") {
    throw new Error("Invalid OKX instrument mapping: only perpetual instruments are supported.");
  }
  if (canonical.quoteAsset !== "USDT") {
    throw new Error("Invalid OKX instrument mapping: only USDT linear perpetual instruments are supported.");
  }
  if (record.contractType !== "linear_perpetual") {
    throw new Error("Invalid OKX instrument mapping: contractType must be linear_perpetual.");
  }
  const expectedInstId = `${canonical.baseAsset}-${canonical.quoteAsset}-SWAP`;
  if (record.instId !== expectedInstId) {
    throw new Error(`Invalid OKX instrument mapping: ${record.canonicalInstrumentId} must map to ${expectedInstId}.`);
  }
  if (!/^[A-Z0-9]{2,12}-USDT-SWAP$/u.test(record.instId)) {
    throw new Error("Invalid OKX instrument mapping: instId must be a USDT swap id.");
  }
  return Object.freeze({
    canonicalInstrumentId: canonical.instrumentId,
    instId: record.instId,
    contractType: record.contractType,
  });
}

function normalizeCanonicalInstrument(input: string | CanonicalInstrument): CanonicalInstrument {
  if (typeof input === "string") return canonicalInstrumentFromId(input);
  const canonical = canonicalInstrumentFromId(input.instrumentId);
  if (
    input.baseAsset !== canonical.baseAsset
    || input.quoteAsset !== canonical.quoteAsset
    || input.contractType !== canonical.contractType
  ) {
    throw new Error("Canonical instrument identity does not match its fields.");
  }
  return canonical;
}

function quantityRulesReference(instId: string): OkxQuantityRulesReference {
  return Object.freeze({
    source: "okx-instruments",
    instType: "SWAP",
    instId,
    fields: OKX_QUANTITY_RULE_FIELDS,
  });
}
