import type { ExecutionVenue } from "../cex/ExecutionIntent";

export type ProviderMutationKey = Readonly<{
  userId: string;
  venue: ExecutionVenue;
  accountId: string;
  canonicalInstrumentId: string;
}>;

/**
 * Serializes Xingheng-owned mutations inside one process. It cannot lock user,
 * bot, conditional-order, or other-process activity at the Provider.
 */
export class ProviderMutationSerializer {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: ProviderMutationKey, operation: () => Promise<T>): Promise<T> {
    return this.runExclusiveMany([key], operation);
  }

  async runExclusiveMany<T>(keys: readonly ProviderMutationKey[], operation: () => Promise<T>): Promise<T> {
    const normalized = [...new Set(keys.map(providerMutationKey))].sort();
    return this.acquire(normalized, 0, operation);
  }

  private async acquire<T>(keys: readonly string[], index: number, operation: () => Promise<T>): Promise<T> {
    if (index >= keys.length) return operation();
    const key = keys[index]!;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const ownership = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => ownership);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await this.acquire(keys, index + 1, operation);
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export const processProviderMutationSerializer = new ProviderMutationSerializer();

export function providerMutationKey(input: ProviderMutationKey) {
  return [input.userId, input.venue, input.accountId, input.canonicalInstrumentId].join("\u0000");
}
