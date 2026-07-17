import type { RealTradingUserStreamEvent } from "../../../api/realTrading";

export type RealTradingUserStreamSequenceDecision = "accept" | "gap" | "ignore";

export function parseRealTradingUserStreamEvent(value: unknown, expectedAddress: string) {
  if (!isRecord(value) || value.type !== "real-trading-user" || value.authoritative !== true) return null;
  if (typeof value.address !== "string" || value.address.toLowerCase() !== expectedAddress.toLowerCase()) return null;
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) return null;
  if (!Number.isFinite(value.timestamp) || Number(value.timestamp) <= 0) return null;
  if (!new Set(["snapshot", "incremental"]).has(String(value.mode))) return null;
  if (!new Set(["connected", "stale", "reconnecting"]).has(String(value.status))) return null;
  if (!new Set(["snapshot", "orders", "fills", "open_orders", "account", "connection"]).has(String(value.channel))) return null;
  return value as unknown as RealTradingUserStreamEvent;
}

export function decideRealTradingUserStreamSequence(
  previousSequence: number | null,
  event: RealTradingUserStreamEvent,
): RealTradingUserStreamSequenceDecision {
  if (event.mode === "snapshot") return "accept";
  if (previousSequence === null) return event.channel === "connection" ? "accept" : "gap";
  if (event.sequence <= previousSequence) return "ignore";
  return event.sequence === previousSequence + 1 ? "accept" : "gap";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
