import type { ArbitrageInstance } from "./ArbitrageInstance";
import type { ArbitrageHistoryPageQuery } from "./ArbitrageInstanceStore";

const DEFAULT_HISTORY_LIMIT = 50;

export type ArbitrageInstanceQueryStore = Readonly<{
  listActive(userId: string): ArbitrageInstance[];
  listHistory(userId: string, pagination: ArbitrageHistoryPageQuery): ArbitrageInstance[];
  get(userId: string, arbitrageId: string): ArbitrageInstance | null;
}>;

export type ArbitrageHistoryPagination = Readonly<{
  page?: number;
  limit?: number;
}>;

export class ArbitrageInstanceQueryService {
  constructor(
    private readonly store: ArbitrageInstanceQueryStore,
  ) {}

  listActive(userId: string) {
    return Object.freeze([...this.store.listActive(identifier(userId, "userId"))]);
  }

  listHistory(userId: string, pagination: ArbitrageHistoryPagination = {}) {
    const normalizedUserId = identifier(userId, "userId");
    const page = positiveInteger(pagination.page ?? 1, "page");
    const limit = positiveInteger(pagination.limit ?? DEFAULT_HISTORY_LIMIT, "limit");
    const offset = (page - 1) * limit;
    if (!Number.isSafeInteger(offset)) throw new Error("pagination offset is too large.");
    return Object.freeze([...this.store.listHistory(normalizedUserId, { limit, offset })]);
  }

  getById(userId: string, arbitrageId: string) {
    return this.store.get(
      identifier(userId, "userId"),
      identifier(arbitrageId, "arbitrageId"),
    );
  }
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value as number;
}
