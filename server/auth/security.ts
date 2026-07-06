import crypto from "node:crypto";

const passwordKeyLength = 64;
const scryptCost = 16_384;
const scryptBlockSize = 8;
const scryptParallelization = 1;

export type SessionRole = "user" | "admin";

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(password, salt, passwordKeyLength, {
    N: scryptCost,
    r: scryptBlockSize,
    p: scryptParallelization,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    scryptCost,
    scryptBlockSize,
    scryptParallelization,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export function verifyPassword(password: string, storedPassword: string) {
  const parts = storedPassword.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return secureTextEqual(password, storedPassword);
  }

  const [, costRaw, blockSizeRaw, parallelizationRaw, saltRaw, expectedRaw] = parts;
  const cost = Number(costRaw);
  const blockSize = Number(blockSizeRaw);
  const parallelization = Number(parallelizationRaw);
  if (![cost, blockSize, parallelization].every(Number.isSafeInteger)) {
    return false;
  }

  try {
    const expected = Buffer.from(expectedRaw, "base64url");
    const actual = crypto.scryptSync(password, Buffer.from(saltRaw, "base64url"), expected.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function isHashedPassword(value: string) {
  return value.startsWith("scrypt$");
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function secureTextEqual(left: string, right: string) {
  const leftDigest = crypto.createHash("sha256").update(left).digest();
  const rightDigest = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}
