export type HyperliquidCloid = `0x${string}`;

const cloidPattern = /^0x[0-9a-f]{32}$/;

export function createHyperliquidCloid(randomBytes?: Uint8Array): HyperliquidCloid {
  const bytes = randomBytes ?? secureRandomBytes();
  if (bytes.length !== 16) throw new Error("Hyperliquid cloid 必须使用 128-bit 随机值。");
  return assertHyperliquidCloid(`0x${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`);
}

export function deriveHyperliquidCloid(parent: HyperliquidCloid, discriminator: string | number): HyperliquidCloid {
  const normalizedParent = assertHyperliquidCloid(parent);
  const tag = fnv1a32(String(discriminator)).toString(16).padStart(8, "0");
  return assertHyperliquidCloid(`${normalizedParent.slice(0, 26)}${tag}`);
}

export function assertHyperliquidCloid(value: string): HyperliquidCloid {
  const normalized = value.toLowerCase();
  if (!cloidPattern.test(normalized)) throw new Error("Hyperliquid cloid 必须是 0x + 32 位十六进制字符串。");
  return normalized as HyperliquidCloid;
}

function secureRandomBytes() {
  if (!globalThis.crypto?.getRandomValues) throw new Error("当前浏览器缺少安全随机数能力，禁止创建真实订单。");
  return globalThis.crypto.getRandomValues(new Uint8Array(16));
}

function fnv1a32(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
