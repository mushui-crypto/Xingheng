import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  acknowledgeHedgeProviderTiming,
  beginHedgeProviderTiming,
  finishHedgeProviderTiming,
  type HedgeProviderTimingToken,
} from "../arbitrage-execution/ArbitrageHedgeStartTiming";

type Venue = "binance" | "okx" | "bybit" | "bitget";
type Action = "READ" | "PLACE_ORDER" | "CANCEL" | "AMEND" | "OTHER_MUTATION";
type Binding = Readonly<{ venue: string; accountId: string }>;
export type ProviderRequestTrace = {
  venue: Venue; accountId: string | null; instanceId: string; commandId: string;
  phase: string; substage: string; method: string; endpoint: string;
  startedAt: number; durationMs: number | null; providerCode: string | null;
  mutationDisposition: "NOT_DISPATCHED" | "DISPATCHED_OR_POSSIBLE";
  reconcileAttempt: number | null; action: Action; orderIdentityHash: string | null;
  mutationTargetHash: string | null;
  unexpectedVenue: boolean;
};
type SafetyWindow = {
  venue: string; accountId: string; executionIntentId: string; safetyPassedAt: number;
  placeOrderDispatchAt: number | null; endedAt: number | null; getCount: number; getEndpoints: string[];
};
export type ProviderCommandTrace = {
  traceId: string; userId: string; instanceId: string; commandId: string; phase: string;
  startedAt: number; completedAt: number | null; bindings: readonly Binding[];
  requests: ProviderRequestTrace[]; postSafety: SafetyWindow[]; droppedRequests: number;
};
type Context = { trace: ProviderCommandTrace; reconcileAttempt: number | null };
const context = new AsyncLocalStorage<Context>();
const responses = new WeakMap<Response, ProviderRequestTrace>();
const hedgeTiming = new WeakMap<ProviderRequestTrace, HedgeProviderTimingToken>();
const MAX_REQUESTS = 512;

export function providerTraceBindings(read: () => readonly Binding[]): readonly Binding[] {
  try { return read(); } catch { return []; }
}

// Observational only. Never consulted by mutation guards, retry policy or execution state.
// No global fetch patch, response cloning, extra read, timer, or raw payload storage.
export async function withProviderCommandTrace<T>(
  input: Pick<ProviderCommandTrace, "userId" | "instanceId" | "commandId" | "phase" | "bindings">,
  persist: (trace: ProviderCommandTrace) => unknown,
  run: () => Promise<T>,
): Promise<T> {
  let trace: ProviderCommandTrace;
  try {
    trace = { ...input, bindings: input.bindings.map(({ venue, accountId }) => ({ venue, accountId })),
      traceId: randomUUID(), startedAt: Date.now(), completedAt: null,
      requests: [], postSafety: [], droppedRequests: 0 };
  } catch { return run(); }
  return context.run({ trace, reconcileAttempt: null }, async () => {
    try { return await run(); } finally {
      try {
        trace.completedAt = Date.now();
        // Persistence is outside the execution call stack. Failure cannot reject the command.
        const snapshot = JSON.parse(JSON.stringify(trace)) as ProviderCommandTrace;
        setImmediate(() => {
          try { Promise.resolve(persist(snapshot)).catch(reportStorageFailure); }
          catch { reportStorageFailure(); }
        });
      } catch { reportStorageFailure(); }
    }
  });
}

function reportStorageFailure() {
  try { console.warn("[provider-request-trace] storage unavailable; evidence incomplete"); } catch { /* best effort */ }
}

export function withProviderReconcileAttempt<T>(attempt: number, run: () => Promise<T>): Promise<T> {
  const current = context.getStore();
  return current ? context.run({ ...current, reconcileAttempt: attempt }, run) : run();
}

export function markPerpCloseSafetyPass(input: Binding & { executionIntentId: string }) {
  try {
    const trace = context.getStore()?.trace;
    if (!trace) return;
    if (trace.postSafety.length >= 16) { trace.droppedRequests += 1; return; }
    trace.postSafety.push({ ...input, safetyPassedAt: Date.now(), placeOrderDispatchAt: null,
      endedAt: null, getCount: 0, getEndpoints: [] });
  } catch { /* best effort */ }
}

export function endPerpCloseTraceAttempt(binding: Binding) {
  try {
    for (const window of context.getStore()?.trace.postSafety ?? []) {
      if (window.venue === binding.venue && window.accountId === binding.accountId && window.endedAt === null) {
        window.endedAt = Date.now();
      }
    }
  } catch { /* best effort */ }
}

// Keep the transport invocation synchronous: Binance's existing dispatch callback relies on it.
export function tracedProviderFetch(venue: Venue, transport: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    let entry: ProviderRequestTrace | undefined;
    try {
      const current = context.getStore();
      if (current) {
        const { trace } = current;
        if (trace.requests.length >= MAX_REQUESTS) trace.droppedRequests += 1;
        else {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
          const endpoint = normalizeEndpoint(url.pathname);
          const action = actionFor(venue, method, endpoint);
          const accounts = [...new Set(trace.bindings.filter(b => b.venue === venue).map(b => b.accountId))];
          entry = { venue, accountId: accounts.length === 1 ? accounts[0]! : null,
            instanceId: trace.instanceId, commandId: trace.commandId, phase: trace.phase,
            substage: substageFor(endpoint, action), method, endpoint, startedAt: Date.now(),
            durationMs: null, providerCode: null, mutationDisposition: method === "GET" ? "NOT_DISPATCHED" : "DISPATCHED_OR_POSSIBLE",
            reconcileAttempt: current.reconcileAttempt, action,
            orderIdentityHash: identityHash(url, init), mutationTargetHash: targetHash(url, init),
            unexpectedVenue: accounts.length === 0 };
          trace.requests.push(entry);
          for (const window of trace.postSafety.filter(w => w.endedAt === null)) {
            if (method === "GET") {
              window.getCount += 1;
              const target = `${venue}:${endpoint}`;
              if (!window.getEndpoints.includes(target)) window.getEndpoints.push(target);
            }
            if (action === "PLACE_ORDER" && window.venue === venue && window.accountId === entry.accountId) {
              window.placeOrderDispatchAt = entry.startedAt;
              window.endedAt = entry.startedAt;
            }
          }
        }
      }
    } catch {
      try { const trace = context.getStore()?.trace; if (trace) trace.droppedRequests += 1; } catch { /* best effort */ }
    }
    try {
      if (entry) {
        const token = beginHedgeProviderTiming(entry.action, entry.substage);
        if (token) hedgeTiming.set(entry, token);
      }
    } catch { /* best effort */ }
    let pending: Promise<Response>;
    try { pending = transport(input, init); }
    catch (error) { finish(entry); throw error; }
    return pending.then(response => {
      try { if (entry) responses.set(response, entry); } catch { /* best effort */ }
      finish(entry);
      return response;
    }, error => { finish(entry); throw error; });
  }) as typeof fetch;
}

function finish(entry?: ProviderRequestTrace) {
  try {
    if (entry) {
      entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
      finishHedgeProviderTiming(hedgeTiming.get(entry) ?? null);
    }
  } catch { /* best effort */ }
}

export function recordProviderResponseCode(response: Response, code: unknown) {
  try {
    const entry = responses.get(response);
    if (!entry) return;
    const text = typeof code === "number" || typeof code === "string" ? String(code) : "";
    // Current four venues use numeric codes. Never persist arbitrary provider messages.
    entry.providerCode = /^-?\d{1,10}$/.test(text) ? text : null;
    finish(entry);
    acknowledgeHedgeProviderTiming(hedgeTiming.get(entry) ?? null);
  } catch { /* best effort */ }
}

export async function tracedProviderJson(response: Response): Promise<any> {
  const payload = await response.json();
  try {
    const root = payload as { code?: unknown; retCode?: unknown; data?: { sCode?: unknown }[] } | null;
    const itemCode = Array.isArray(root?.data) ? root.data[0]?.sCode : undefined;
    recordProviderResponseCode(response, root?.code === "0" && itemCode !== undefined ? itemCode : root?.code ?? root?.retCode);
  } catch { /* best effort, preserve the original parsed value */ }
  return payload;
}

function normalizeEndpoint(path: string) {
  // Static API paths only; query, host, fragment, credentials and dynamic identifiers excluded.
  return /^\/(?:api|sapi|fapi|v5)\/[A-Za-z0-9/_-]{1,110}$/.test(path) ? path : "/UNRECOGNIZED";
}
function actionFor(venue: Venue, method: string, endpoint: string): Action {
  if (method === "GET") return "READ";
  if (method === "DELETE" || /cancel/i.test(endpoint)) return "CANCEL";
  if (/amend|modify/i.test(endpoint) || method === "PUT") return "AMEND";
  if (method === "POST" && ((venue === "binance" && /^\/(api|fapi)\/v[13]\/order$/.test(endpoint))
    || endpoint === "/api/v5/trade/order" || endpoint === "/v5/order/create" || endpoint === "/api/v3/trade/place-order")) return "PLACE_ORDER";
  return "OTHER_MUTATION";
}
function substageFor(endpoint: string, action: Action) {
  if (action !== "READ") return action === "PLACE_ORDER" ? "PLACE_ORDER_DISPATCH" : action;
  if (/execution|fills|myTrades|userTrades/.test(endpoint)) return "EXECUTION_LIST";
  if (/history/.test(endpoint)) return "ORDER_HISTORY";
  if (/order/.test(endpoint)) return "ORDER_REALTIME";
  if (/instruments|exchangeInfo/.test(endpoint)) return "INSTRUMENT_RULES";
  if (/ticker/.test(endpoint)) return "QUOTE";
  if (/positionSide|position-mode|settings/.test(endpoint)) return "POSITION_MODE";
  if (/position/.test(endpoint)) return "POSITION_REALITY";
  if (/balance|assets|wallet/.test(endpoint)) return "BALANCE";
  if (/account|query-api/.test(endpoint)) return "ACCOUNT";
  return "PROVIDER_READ";
}
function identityHash(url: URL, init?: RequestInit) {
  // Only exact order correlation fields are selected; raw query/body is never retained.
  const values = requestValues(url, init);
  const id = values.clientOid ?? values.clOrdId ?? values.orderLinkId ?? values.newClientOrderId
    ?? values.origClientOrderId ?? values.orderId ?? values.ordId;
  return typeof id === "string" && id.length <= 160
    ? createHash("sha256").update(id).digest("hex") : null;
}

function requestValues(url: URL, init?: RequestInit): Record<string, unknown> {
  const query = Object.fromEntries(url.searchParams);
  if (typeof init?.body === "string" && init.body.length < 16_384) {
    try { return { ...query, ...JSON.parse(init.body) }; } catch { /* no identity */ }
  }
  return query;
}
function targetHash(url: URL, init?: RequestInit) {
  const values = requestValues(url, init);
  const symbol = values.symbol ?? values.instId;
  if (typeof symbol !== "string" || typeof values.side !== "string") return null;
  return createHash("sha256").update(JSON.stringify([
    symbol, values.category ?? url.pathname, values.side, values.posSide ?? values.positionSide,
    values.reduceOnly, values.tradeSide,
  ])).digest("hex");
}

export function summarizeProviderTraces(traces: readonly ProviderCommandTrace[]) {
  const requests = traces.flatMap(t => t.requests);
  const places = requests.filter(r => r.action === "PLACE_ORDER");
  const identities = new Map<string, number>();
  const targets = new Map<string, number>();
  for (const r of places) {
    if (r.mutationTargetHash) {
      const target = `${r.instanceId}:${r.venue}:${r.accountId}:${r.phase}:${r.mutationTargetHash}`;
      targets.set(target, (targets.get(target) ?? 0) + 1);
    }
    if (!r.orderIdentityHash) continue;
    const key = `${r.instanceId}:${r.venue}:${r.accountId}:${r.orderIdentityHash}`;
    identities.set(key, (identities.get(key) ?? 0) + 1);
  }
  return {
    COMMAND_VENUES: [...new Set(traces.flatMap(t => t.bindings.map(b => b.venue)))],
    PROVIDER_GET_COUNT: requests.filter(r => r.method === "GET").length,
    PLACE_ORDER_COUNT: places.length,
    CANCEL_COUNT: requests.filter(r => r.action === "CANCEL").length,
    AMEND_COUNT: requests.filter(r => r.action === "AMEND").length,
    UNEXPECTED_VENUE_MUTATION_COUNT: requests.filter(r => r.unexpectedVenue && r.method !== "GET").length,
    REPEATED_ORDER_IDENTITY_DISPATCH_COUNT: [...identities.values()].reduce((n, count) => n + Math.max(0, count - 1), 0),
    // Candidates only: a separately authorized partial/recovery close may legitimately repeat a target.
    REPEATED_INSTANCE_MUTATION_TARGETS: [...targets.entries()].filter(([, count]) => count > 1)
      .map(([target, dispatchCount]) => ({ target, dispatchCount })),
    POST_SAFETY: traces.flatMap(t => t.postSafety),
    POST_SAFETY_PROVIDER_GET_COUNT: traces.some(t => t.postSafety.length > 0)
      ? traces.flatMap(t => t.postSafety).reduce((n, w) => n + w.getCount, 0) : null,
    POST_SAFETY_PROVIDER_GET_ENDPOINTS: [...new Set(traces.flatMap(t => t.postSafety.flatMap(w => w.getEndpoints)))],
    EVIDENCE_COMPLETE: traces.length > 0 && traces.every(t => t.completedAt !== null && t.droppedRequests === 0
      && t.bindings.length > 0 && t.requests.every(r => r.durationMs !== null && r.accountId !== null
        && r.endpoint !== "/UNRECOGNIZED" && (r.action !== "PLACE_ORDER" || r.orderIdentityHash !== null))),
  };
}
