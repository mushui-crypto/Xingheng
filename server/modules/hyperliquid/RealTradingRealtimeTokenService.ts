import { createHash, randomBytes } from "node:crypto";
import { normalizeAddress } from "./HyperliquidInfoClient";

type RealtimeGrant = { userId: string; address: string; expiresAt: number };

export class RealTradingRealtimeTokenService {
  private readonly grants = new Map<string, RealtimeGrant>();
  private readonly tokensByUser = new Map<string, string>();
  private readonly ttlMs: number;

  constructor(ttlMs = readTtl()) {
    this.ttlMs = ttlMs;
  }

  issue(userId: string, addressInput: unknown) {
    this.purge();
    const address = normalizeAddress(addressInput);
    const previousHash = this.tokensByUser.get(userId);
    if (previousHash) this.grants.delete(previousHash);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = Date.now() + this.ttlMs;
    this.grants.set(tokenHash, { userId, address, expiresAt });
    this.tokensByUser.set(userId, tokenHash);
    return { token, address, expiresAt };
  }

  consume(token: unknown) {
    this.purge();
    if (typeof token !== "string" || token.length < 32) return null;
    const tokenHash = hashToken(token);
    const grant = this.grants.get(tokenHash);
    if (!grant) return null;
    this.grants.delete(tokenHash);
    if (this.tokensByUser.get(grant.userId) === tokenHash) this.tokensByUser.delete(grant.userId);
    return grant.expiresAt > Date.now() ? grant : null;
  }

  private purge() {
    const now = Date.now();
    for (const [hash, grant] of this.grants) {
      if (grant.expiresAt <= now) {
        this.grants.delete(hash);
        if (this.tokensByUser.get(grant.userId) === hash) this.tokensByUser.delete(grant.userId);
      }
    }
  }
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function readTtl() {
  const value = Number(process.env.REAL_TRADING_REALTIME_TOKEN_TTL_MS);
  return Number.isFinite(value) && value >= 5_000 && value <= 5 * 60_000 ? Math.floor(value) : 60_000;
}
