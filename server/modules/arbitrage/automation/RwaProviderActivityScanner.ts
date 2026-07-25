import {
  RWA_ACTIVITY_MAX_PAGES_PER_SOURCE,
  RWA_ACTIVITY_MAX_SCAN_CONCURRENCY,
  RWA_ACTIVITY_RETRY_DELAYS_MS,
  RWA_SPOT_ACTIVITY_SOURCES,
  RWA_PERPETUAL_ACTIVITY_SOURCES,
  attributionScanStart,
  buildPositionAttributionSnapshot,
  sourceSnapshot,
} from "./RwaProviderActivityContinuity";
import type {
  RwaPositionAttributionSnapshot,
  RwaProviderActivitySource,
  RwaProviderActivitySourceSnapshot,
  RwaStrategyActivityContinuity,
} from "./RwaNeutralExecutionTypes";

type Request = (path: string, params: Record<string, string>) => Promise<unknown>;

type ScanInput = {
  since: number;
  checkedThrough: number;
  strategyOrderPrefixes: string[];
  continuity: RwaStrategyActivityContinuity;
};

type EventRow = {
  id: string;
  occurredAt: number;
  clientOrderId: string | null;
  providerOrderId: string | null;
  affectsXaut: boolean;
};

type Page = {
  rows: unknown[];
  nextCursor: string | null;
  complete: boolean;
};

const BINANCE_TRANSFER_TYPES = [
  "MAIN_UMFUTURE",
  "MAIN_CMFUTURE",
  "MAIN_MARGIN",
  "UMFUTURE_MAIN",
  "UMFUTURE_MARGIN",
  "CMFUTURE_MAIN",
  "CMFUTURE_MARGIN",
  "MARGIN_MAIN",
  "MARGIN_UMFUTURE",
  "MARGIN_CMFUTURE",
  "ISOLATEDMARGIN_MARGIN",
  "MARGIN_ISOLATEDMARGIN",
  "ISOLATEDMARGIN_ISOLATEDMARGIN",
  "MAIN_FUNDING",
  "FUNDING_MAIN",
  "FUNDING_UMFUTURE",
  "UMFUTURE_FUNDING",
  "MARGIN_FUNDING",
  "FUNDING_MARGIN",
  "FUNDING_CMFUTURE",
  "CMFUTURE_FUNDING",
] as const;

export async function scanBinancePositionAttribution(
  spotRequest: Request,
  futuresRequest: Request,
  input: ScanInput,
): Promise<RwaPositionAttributionSnapshot> {
  const strategyProviderOrderIds = new Set([
    ...input.continuity.spot.providerOrderIds,
    ...input.continuity.perpetual.providerOrderIds,
  ]);
  const prefixes = new Set(input.strategyOrderPrefixes);
  const sources: RwaProviderActivitySourceSnapshot[] = [];
  const providerOrderIds = { spot: [] as string[], perpetual: [] as string[] };
  const scan = async (
    source: RwaProviderActivitySource,
    scope: "spot" | "futures",
    path: string,
    params: Record<string, string>,
    rows: (value: unknown) => unknown[],
    parse: (value: unknown) => EventRow,
    options: {
      limit: number;
      cursorParam?: string;
      cursorField?: string;
      pageParam?: string;
      offsetParam?: string;
      responseTotal?: (value: unknown) => number | null;
    } = { limit: 1000 },
  ) => {
    const checkedFrom = attributionScanStart(input.continuity, source, input.since);
    try {
      const request = scope === "spot" ? spotRequest : futuresRequest;
      const result = await scanBinancePages(
        (requestPath, requestParams) => retryActivityRequest(request, requestPath, requestParams),
        path,
        { ...params, startTime: String(checkedFrom), endTime: String(input.checkedThrough) },
        rows,
        parse,
        options,
      );
      const classified = classify(result.events, prefixes, strategyProviderOrderIds);
      providerOrderIds[scope === "spot" ? "spot" : "perpetual"].push(...classified.strategyOrderIds);
      sources.push(sourceSnapshot({
        source,
        coverage: result.complete ? "complete" : "incomplete",
        checkedFrom,
        checkedThrough: result.complete ? input.checkedThrough : checkedFrom,
        eventIds: result.events.map((event) => `${source}:${event.id}`),
        externalActivity: classified.external,
      }));
    } catch {
      sources.push(sourceSnapshot({
        source,
        coverage: "incomplete",
        checkedFrom,
        checkedThrough: checkedFrom,
      }));
    }
  };

  const tasks: Array<() => Promise<void>> = [
    () => scan("spot_orders", "spot", "/api/v3/allOrders", { symbol: "XAUTUSDT", limit: "1000" }, arrayRows, binanceOrder, {
      limit: 1000,
      cursorParam: "orderId",
      cursorField: "orderId",
    }),
    () => scan("spot_trades", "spot", "/api/v3/myTrades", { symbol: "XAUTUSDT", limit: "1000" }, arrayRows, binanceTrade, {
      limit: 1000,
      cursorParam: "fromId",
      cursorField: "id",
    }),
    () => scan("perpetual_orders", "futures", "/fapi/v1/allOrders", { symbol: "XAUTUSDT", limit: "1000" }, arrayRows, binanceOrder, {
      limit: 1000,
      cursorParam: "orderId",
      cursorField: "orderId",
    }),
    () => scan("perpetual_trades", "futures", "/fapi/v1/userTrades", { symbol: "XAUTUSDT", limit: "1000" }, arrayRows, binanceTrade, {
      limit: 1000,
      cursorParam: "fromId",
      cursorField: "id",
    }),
    () => scan("account_transactions", "futures", "/fapi/v1/income", { symbol: "XAUTUSDT", limit: "1000" }, arrayRows, binanceIncome, {
      limit: 1000,
      cursorParam: "tranId",
      cursorField: "tranId",
    }),
    ...BINANCE_TRANSFER_TYPES.map((type, index) => () => scan(
      index < 2 ? "internal_transfers" : "universal_transfers",
      "spot",
      "/sapi/v1/asset/transfer",
      {
        type,
        size: "100",
        ...(type === "ISOLATEDMARGIN_MARGIN" ? { fromSymbol: "XAUTUSDT" } : {}),
        ...(type === "MARGIN_ISOLATEDMARGIN" ? { toSymbol: "XAUTUSDT" } : {}),
        ...(type === "ISOLATEDMARGIN_ISOLATEDMARGIN"
          ? { fromSymbol: "XAUTUSDT", toSymbol: "XAUTUSDT" }
          : {}),
      },
      rowsRows,
      binanceTransfer,
      {
        limit: 100,
        pageParam: "current",
        responseTotal: totalRows,
      },
    )),
    () => scan("deposits", "spot", "/sapi/v1/capital/deposit/hisrec", { coin: "XAUT", limit: "1000" }, arrayRows, binanceDeposit, {
      limit: 1000,
      offsetParam: "offset",
    }),
    () => scan("internal_deposits", "spot", "/sapi/v1/capital/deposit/hisrec", { coin: "XAUT", limit: "1000" }, arrayRows, binanceInternalDeposit, {
      limit: 1000,
      offsetParam: "offset",
    }),
    () => scan("withdrawals", "spot", "/sapi/v1/capital/withdraw/history", { coin: "XAUT", limit: "1000" }, arrayRows, binanceWithdrawal, {
      limit: 1000,
      offsetParam: "offset",
    }),
    () => scan("convert", "spot", "/sapi/v1/convert/tradeFlow", { limit: "100" }, listRows, binanceConvert, {
      limit: 100,
    }),
    () => scan("dust", "spot", "/sapi/v1/asset/dribblet", {}, dustRows, binanceDust, {
      limit: 100,
    }),
    () => scan("balance_adjustments", "spot", "/sapi/v1/asset/assetDividend", { asset: "XAUT", limit: "500" }, rowsRows, binanceDividend, {
      limit: 500,
      offsetParam: "offset",
      responseTotal: totalRows,
    }),
  ];
  await runBounded(tasks, RWA_ACTIVITY_MAX_SCAN_CONCURRENCY);

  return finalizeSources(input, sources, providerOrderIds);
}

export async function scanBybitPositionAttribution(
  request: Request,
  input: ScanInput,
): Promise<RwaPositionAttributionSnapshot> {
  const strategyProviderOrderIds = new Set([
    ...input.continuity.spot.providerOrderIds,
    ...input.continuity.perpetual.providerOrderIds,
  ]);
  const prefixes = new Set(input.strategyOrderPrefixes);
  const sources: RwaProviderActivitySourceSnapshot[] = [];
  const providerOrderIds = { spot: [] as string[], perpetual: [] as string[] };
  const scan = async (
    source: RwaProviderActivitySource,
    path: string,
    params: Record<string, string>,
    rows: (value: unknown) => unknown[],
    parse: (value: unknown) => EventRow,
    side: "spot" | "perpetual" | "both",
    cursorField = "nextPageCursor",
    timeMode: "milliseconds" | "seconds_create" | "none" = "milliseconds",
    pageParam?: string,
  ) => {
    const checkedFrom = attributionScanStart(input.continuity, source, input.since);
    try {
      const timeParams: Record<string, string> = {};
      if (timeMode === "seconds_create") {
        timeParams.createTimeFrom = String(Math.floor(checkedFrom / 1000));
        timeParams.createTimeTo = String(Math.ceil(input.checkedThrough / 1000));
      } else if (timeMode === "milliseconds") {
        timeParams.startTime = String(checkedFrom);
        timeParams.endTime = String(input.checkedThrough);
      }
      const result = await scanBybitCursorPages(
        (requestPath, requestParams) => retryActivityRequest(request, requestPath, requestParams),
        path,
        { ...params, ...timeParams },
        rows,
        parse,
        cursorField,
        pageParam,
        checkedFrom,
        input.checkedThrough,
        timeMode === "none",
      );
      const classified = classify(result.events, prefixes, strategyProviderOrderIds);
      if (side !== "both") providerOrderIds[side === "spot" ? "spot" : "perpetual"].push(...classified.strategyOrderIds);
      sources.push(sourceSnapshot({
        source,
        coverage: result.complete ? "complete" : "incomplete",
        checkedFrom,
        checkedThrough: result.complete ? input.checkedThrough : checkedFrom,
        eventIds: result.events.map((event) => `${source}:${event.id}`),
        externalActivity: classified.external,
      }));
    } catch {
      sources.push(sourceSnapshot({
        source,
        coverage: "incomplete",
        checkedFrom,
        checkedThrough: checkedFrom,
      }));
    }
  };

  const tasks: Array<() => Promise<void>> = [
    () => scan("spot_orders", "/v5/order/history", { category: "spot", symbol: "XAUTUSDT", limit: "50" }, bybitListRows, bybitOrder, "spot"),
    () => scan("spot_trades", "/v5/execution/list", { category: "spot", symbol: "XAUTUSDT", limit: "100" }, bybitListRows, bybitExecution, "spot"),
    () => scan("perpetual_orders", "/v5/order/history", { category: "linear", symbol: "XAUTUSDT", limit: "50" }, bybitListRows, bybitOrder, "perpetual"),
    () => scan("perpetual_trades", "/v5/execution/list", { category: "linear", symbol: "XAUTUSDT", limit: "100" }, bybitListRows, bybitExecution, "perpetual"),
    () => scan("account_transactions", "/v5/account/transaction-log", { accountType: "UNIFIED", currency: "XAUT", limit: "50" }, bybitListRows, bybitTransaction, "both"),
    () => scan("internal_transfers", "/v5/asset/transfer/query-inter-transfer-list", { coin: "XAUT", limit: "50" }, bybitListRows, bybitTransfer, "both"),
    () => scan("universal_transfers", "/v5/asset/transfer/query-universal-transfer-list", { coin: "XAUT", limit: "50" }, bybitListRows, bybitTransfer, "both"),
    () => scan("deposits", "/v5/asset/deposit/query-record", { coin: "XAUT", limit: "50" }, bybitRowsRows, bybitDeposit, "spot"),
    () => scan("internal_deposits", "/v5/asset/deposit/query-internal-record", { coin: "XAUT", limit: "50" }, bybitRowsRows, bybitDeposit, "spot"),
    () => scan("withdrawals", "/v5/asset/withdraw/query-record", { coin: "XAUT", limit: "50" }, bybitRowsRows, bybitWithdrawal, "spot"),
    () => scan(
      "convert",
      "/v5/asset/exchange/query-convert-history",
      { limit: "100" },
      bybitListRows,
      bybitConvert,
      "spot",
      "nextPageCursor",
      "none",
      "index",
    ),
    () => scan("dust", "/v5/asset/covert/small-balance-history", { size: "100" }, bybitRecordsRows, bybitDust, "spot", "cursor"),
    () => scan(
      "balance_adjustments",
      "/v5/asset/fundinghistory",
      { coin: "XAUT", limit: "100" },
      bybitListRows,
      bybitFunding,
      "both",
      "nextPageCursor",
      "seconds_create",
    ),
  ];
  await runBounded(tasks, RWA_ACTIVITY_MAX_SCAN_CONCURRENCY);

  return finalizeSources(input, sources, providerOrderIds);
}

async function runBounded(tasks: Array<() => Promise<void>>, concurrency: number) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      await tasks[index]();
    }
  });
  await Promise.all(workers);
}

async function retryActivityRequest(request: Request, path: string, params: Record<string, string>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request(path, params);
    } catch (error) {
      const category = error && typeof error === "object" && "category" in error
        ? String((error as { category?: unknown }).category ?? "")
        : "";
      if (
        attempt >= RWA_ACTIVITY_RETRY_DELAYS_MS.length
        || !["provider_rate_limited", "provider_timeout", "provider_transport_error"].includes(category)
      ) throw error;
      await delay(RWA_ACTIVITY_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function scanBinancePages(
  request: Request,
  path: string,
  baseParams: Record<string, string>,
  rows: (value: unknown) => unknown[],
  parse: (value: unknown) => EventRow,
  options: {
    limit: number;
    cursorParam?: string;
    cursorField?: string;
    pageParam?: string;
    offsetParam?: string;
    responseTotal?: (value: unknown) => number | null;
  },
) {
  const events: EventRow[] = [];
  const seenCursors = new Set<string>();
  const seenPages = new Set<string>();
  let cursor: string | null = null;
  let page = 1;
  let offset = 0;
  for (let count = 0; count < RWA_ACTIVITY_MAX_PAGES_PER_SOURCE; count += 1) {
    const params = { ...baseParams };
    if (cursor && options.cursorParam) params[options.cursorParam] = cursor;
    if (options.pageParam) params[options.pageParam] = String(page);
    if (options.offsetParam) params[options.offsetParam] = String(offset);
    const value = await request(path, params);
    const rawRows = rows(value);
    const parsed = rawRows.map(parse);
    const pageIdentity = parsed.map((event) => event.id).sort().join("\n");
    if (rawRows.length && seenPages.has(pageIdentity)) return { complete: false, events };
    if (rawRows.length) seenPages.add(pageIdentity);
    const startTime = Number(baseParams.startTime);
    const endTime = Number(baseParams.endTime);
    if (parsed.some((event) =>
      !validEvent(event)
      || (Number.isFinite(startTime) && event.occurredAt < startTime)
      || (Number.isFinite(endTime) && event.occurredAt > endTime))) {
      return { complete: false, events };
    }
    events.push(...parsed);
    const total = options.responseTotal?.(value) ?? null;
    if (rawRows.length < options.limit || (total !== null && events.length >= total)) {
      return { complete: true, events };
    }
    if (options.cursorParam && options.cursorField) {
      const cursorValues = rawRows.map((row) => Number(expectRecord(row)[options.cursorField!]));
      if (
        cursorValues.some((value) => !Number.isSafeInteger(value) || value < 0)
        || cursorValues.some((value, index) => index > 0 && value <= cursorValues[index - 1])
      ) return { complete: false, events };
      const last = expectRecord(rawRows.at(-1));
      const rawCursor = String(last[options.cursorField] ?? "");
      const numericCursor = Number(rawCursor);
      cursor = Number.isSafeInteger(numericCursor) ? String(numericCursor + 1) : rawCursor;
      if (!cursor || seenCursors.has(cursor)) return { complete: false, events };
      seenCursors.add(cursor);
      continue;
    }
    if (options.pageParam) {
      page += 1;
      continue;
    }
    if (options.offsetParam) {
      offset += rawRows.length;
      continue;
    }
    return { complete: false, events };
  }
  return { complete: false, events };
}

async function scanBybitCursorPages(
  request: Request,
  path: string,
  baseParams: Record<string, string>,
  rows: (value: unknown) => unknown[],
  parse: (value: unknown) => EventRow,
  cursorField: string,
  pageParam: string | undefined,
  checkedFrom: number,
  checkedThrough: number,
  allowOlderEvents: boolean,
) {
  const events: EventRow[] = [];
  const seen = new Set<string>();
  const seenPages = new Set<string>();
  let cursor = "";
  let page = 1;
  for (let count = 0; count < RWA_ACTIVITY_MAX_PAGES_PER_SOURCE; count += 1) {
    const value = await request(path, {
      ...baseParams,
      ...(pageParam ? { [pageParam]: String(page) } : cursor ? { cursor } : {}),
    });
    const rawRows = rows(value);
    const parsed = rawRows.map(parse);
    const pageIdentity = parsed.map((event) => event.id).sort().join("\n");
    if (rawRows.length && seenPages.has(pageIdentity)) return { complete: false, events };
    if (rawRows.length) seenPages.add(pageIdentity);
    if (parsed.some((event) =>
      !validEvent(event)
      || (!allowOlderEvents && event.occurredAt < checkedFrom)
      || event.occurredAt > checkedThrough)) {
      return { complete: false, events };
    }
    events.push(...parsed.filter((event) => event.occurredAt >= checkedFrom));
    if (pageParam) {
      const limit = Number(baseParams.limit);
      if (!Number.isSafeInteger(limit) || limit < 1) return { complete: false, events };
      if (rawRows.length < limit) return { complete: true, events };
      page += 1;
      continue;
    }
    const root = expectRecord(value);
    if (!Object.hasOwn(root, cursorField)) return { complete: false, events };
    let next = String(root[cursorField] ?? "");
    if (cursorField === "cursor" && next) {
      const currentPage = Number(next);
      const lastPage = Number(root.lastPage);
      if (!Number.isSafeInteger(currentPage) || !Number.isSafeInteger(lastPage) || currentPage < 1 || lastPage < currentPage) {
        return { complete: false, events };
      }
      if (currentPage === lastPage) return { complete: true, events };
      next = String(currentPage + 1);
    }
    if (!next) return { complete: true, events };
    if (!rawRows.length) return { complete: false, events };
    if (seen.has(next)) return { complete: false, events };
    seen.add(next);
    cursor = next;
  }
  return { complete: false, events };
}

function finalizeSources(
  input: ScanInput,
  sources: RwaProviderActivitySourceSnapshot[],
  providerOrderIds: { spot: string[]; perpetual: string[] },
) {
  const unique = new Map<RwaProviderActivitySource, RwaProviderActivitySourceSnapshot>();
  for (const source of sources) {
    const previous = unique.get(source.source);
    if (!previous) unique.set(source.source, source);
    else unique.set(source.source, {
      ...source,
      coverage: previous.coverage === "complete" && source.coverage === "complete" ? "complete" : "incomplete",
      checkedFrom: Math.min(previous.checkedFrom, source.checkedFrom),
      checkedThrough: Math.min(previous.checkedThrough, source.checkedThrough),
      eventIds: [...previous.eventIds, ...source.eventIds],
      externalActivity: previous.externalActivity || source.externalActivity,
    });
  }
  for (const source of new Set([...RWA_SPOT_ACTIVITY_SOURCES, ...RWA_PERPETUAL_ACTIVITY_SOURCES])) {
    if (!unique.has(source)) unique.set(source, sourceSnapshot({
      source,
      coverage: "incomplete",
      checkedFrom: input.since,
      checkedThrough: input.since,
    }));
  }
  return buildPositionAttributionSnapshot({
    since: input.since,
    checkedThrough: input.checkedThrough,
    sources: [...unique.values()],
    providerOrderIds,
  });
}

function classify(events: EventRow[], prefixes: Set<string>, providerOrderIds: Set<string>) {
  const strategyOrderIds: string[] = [];
  let external = false;
  for (const event of events) {
    if (!event.affectsXaut) continue;
    const strategy = (event.clientOrderId && [...prefixes].some((prefix) => event.clientOrderId?.startsWith(prefix)))
      || (event.providerOrderId && providerOrderIds.has(event.providerOrderId));
    if (strategy && event.providerOrderId) strategyOrderIds.push(event.providerOrderId);
    if (!strategy) external = true;
  }
  return { external, strategyOrderIds };
}

function binanceOrder(value: unknown): EventRow {
  const row = record(value);
  return event(row.orderId, row.time ?? row.updateTime, row.clientOrderId, row.orderId, row.symbol === "XAUTUSDT");
}

function binanceTrade(value: unknown): EventRow {
  const row = record(value);
  return event(row.id, row.time, null, row.orderId, row.symbol === "XAUTUSDT");
}

function binanceIncome(value: unknown): EventRow {
  const row = record(value);
  const positionAffecting = !["FUNDING_FEE", "COMMISSION", "REALIZED_PNL"].includes(String(row.incomeType ?? ""));
  return event(row.tranId, row.time, null, null, row.symbol === "XAUTUSDT" && positionAffecting);
}

function binanceTransfer(value: unknown): EventRow {
  const row = record(value);
  return event(row.tranId ?? row.clientTranId, row.timestamp ?? row.time, null, null, row.asset === "XAUT");
}

function binanceDeposit(value: unknown): EventRow {
  const row = record(value);
  return event(row.id ?? row.txId, row.insertTime ?? row.completeTime, null, null, row.coin === "XAUT" && Number(row.transferType ?? 0) === 0);
}

function binanceInternalDeposit(value: unknown): EventRow {
  const row = record(value);
  return event(row.id ?? row.txId, row.insertTime ?? row.completeTime, null, null, row.coin === "XAUT" && Number(row.transferType ?? 0) === 1);
}

function binanceWithdrawal(value: unknown): EventRow {
  const row = record(value);
  return event(row.id ?? row.txId, Date.parse(String(row.applyTime ?? "")) || row.completeTime, null, null, row.coin === "XAUT");
}

function binanceConvert(value: unknown): EventRow {
  const row = record(value);
  return event(row.orderId ?? row.quoteId, row.createTime, null, null, row.fromAsset === "XAUT" || row.toAsset === "XAUT");
}

function binanceDust(value: unknown): EventRow {
  const row = record(value);
  return event(row.transId ?? row.operateTime, row.operateTime, null, null, row.fromAsset === "XAUT");
}

function binanceDividend(value: unknown): EventRow {
  const row = record(value);
  return event(row.tranId, row.divTime, null, null, row.asset === "XAUT");
}

function bybitOrder(value: unknown): EventRow {
  const row = record(value);
  return event(row.orderId, row.updatedTime ?? row.createdTime, row.orderLinkId, row.orderId, row.symbol === "XAUTUSDT");
}

function bybitExecution(value: unknown): EventRow {
  const row = record(value);
  return event(row.execId, row.execTime, row.orderLinkId, row.orderId, row.symbol === "XAUTUSDT");
}

function bybitTransaction(value: unknown): EventRow {
  const row = record(value);
  const type = String(row.type ?? "").toUpperCase();
  const affectsXaut = row.currency === "XAUT"
    || (row.symbol === "XAUTUSDT" && type !== "SETTLEMENT");
  return event(row.id ?? row.transactionTime, row.transactionTime, row.orderLinkId, row.orderId, affectsXaut);
}

function bybitTransfer(value: unknown): EventRow {
  const row = record(value);
  return event(row.transferId, row.timestamp, null, null, row.coin === "XAUT");
}

function bybitDeposit(value: unknown): EventRow {
  const row = record(value);
  return event(row.id ?? row.txID, row.successAt ?? row.createdTime, null, null, row.coin === "XAUT");
}

function bybitWithdrawal(value: unknown): EventRow {
  const row = record(value);
  return event(row.withdrawId ?? row.txID, row.updateTime ?? row.createTime, null, null, row.coin === "XAUT");
}

function bybitConvert(value: unknown): EventRow {
  const row = record(value);
  return event(row.exchangeTxId ?? row.tradeNo, row.createdAt, null, null, row.fromCoin === "XAUT" || row.toCoin === "XAUT");
}

function bybitDust(value: unknown): EventRow {
  const row = record(value);
  const affectsXaut = row.fromCoin === "XAUT"
    || row.toCoin === "XAUT"
    || list(row.subRecords).some((item) => {
      const part = record(item);
      return part.fromCoin === "XAUT" || part.toCoin === "XAUT";
    });
  return event(row.exchangeTxId, row.createdAt, null, null, affectsXaut);
}

function bybitFunding(value: unknown): EventRow {
  const row = record(value);
  return event(`${row.createTime}:${row.txnAmt}:${row.afterAmt}`, Number(row.createTime) * 1000, null, null, row.currency === "XAUT");
}

function event(
  id: unknown,
  occurredAt: unknown,
  clientOrderId: unknown,
  providerOrderId: unknown,
  affectsXaut: boolean,
): EventRow {
  return {
    id: String(id ?? ""),
    occurredAt: Number(occurredAt),
    clientOrderId: typeof clientOrderId === "string" && clientOrderId ? clientOrderId : null,
    providerOrderId: providerOrderId === null || providerOrderId === undefined ? null : String(providerOrderId),
    affectsXaut,
  };
}

function validEvent(value: EventRow) {
  return Boolean(value.id) && Number.isFinite(value.occurredAt) && value.occurredAt >= 0;
}

function arrayRows(value: unknown) {
  if (!Array.isArray(value)) throw new Error("provider schema invalid");
  return value;
}

function listRows(value: unknown) {
  return requiredArray(expectRecord(value), "list");
}

function rowsRows(value: unknown) {
  return requiredArray(expectRecord(value), "rows");
}

function dustRows(value: unknown) {
  return requiredArray(expectRecord(value), "userAssetDribblets").flatMap((group) => {
    const root = expectRecord(group);
    return requiredArray(root, "userAssetDribbletDetails").map((detail) => ({
      ...expectRecord(detail),
      operateTime: root.operateTime,
      transId: root.transId,
    }));
  });
}

function bybitListRows(value: unknown) {
  return requiredArray(expectRecord(value), "list");
}

function bybitRowsRows(value: unknown) {
  return requiredArray(expectRecord(value), "rows");
}

function bybitRecordsRows(value: unknown) {
  return requiredArray(expectRecord(value), "records");
}

function totalRows(value: unknown) {
  const total = Number(expectRecord(value).total);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("provider schema invalid");
  return total;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function expectRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("provider schema invalid");
  return value as Record<string, any>;
}

function requiredArray(value: Record<string, any>, key: string): unknown[] {
  if (!Array.isArray(value[key])) throw new Error("provider schema invalid");
  return value[key];
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
