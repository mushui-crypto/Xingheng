export function sanitizeRwaAutomationError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error ?? "unknown provider error");
  let message = raw.slice(0, 600);
  message = message
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/file:\/\/\/[^\s]+/gi, "[path]")
    .replace(/(^|[\s"'(])(?:\/[A-Za-z0-9._~:@%+-]+)+/g, "$1[path]")
    .replace(/(^|[\s"'(])\.\.?\/[A-Za-z0-9._~:@%+-/]+/g, "$1[path]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [secret]")
    .replace(
      /\b(api[_-]?key|secret|signature|token|authorization|password|passphrase|private[_-]?key)\b\s*(?::|=|\s)\s*("[^"]*"|'[^']*'|[^\s,;}]*)?/gi,
      (_match, key) => `${key} [secret]`,
    );
  return message || "provider_error";
}

export function categoryFromRwaAutomationError(error: unknown) {
  if (
    error
    && typeof error === "object"
    && "category" in error
    && typeof (error as { category?: unknown }).category === "string"
  ) {
    return (error as { category: string }).category;
  }
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (/timeout|abort/i.test(text)) return "provider_timeout";
  if (/429|rate.?limit/i.test(text)) return "provider_rate_limited";
  if (/credential|permission|api.?key|secret/i.test(text)) return "provider_permission_error";
  if (/stale/i.test(text)) return "provider_stale";
  return "provider_unknown";
}

export function stableHash(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
