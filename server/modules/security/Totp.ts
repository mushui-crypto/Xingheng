import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret() {
  return encodeBase32(randomBytes(20));
}

export function totpCode(secret: string, counter: number) {
  const key = decodeBase32(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  key.fill(0);
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret: string, code: string, now: number, window = 1) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30_000);
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = current + offset;
    if (counter < 0) continue;
    const expected = Buffer.from(totpCode(secret, counter));
    const actual = Buffer.from(code);
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
    expected.fill(0);
    actual.fill(0);
    if (matches) return counter;
  }
  return null;
}

export function provisioningUri(secret: string, accountLabel: string) {
  const issuer = "StellaX";
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function encodeBase32(value: Buffer) {
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string) {
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of value.replace(/=+$/g, "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("invalid base32");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
