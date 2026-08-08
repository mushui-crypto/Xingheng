import type { BinanceCredentials } from "./BinanceTypes";

export class BinanceCredential {
  private constructor(readonly apiKey: string, readonly apiSecret: string) {}

  static fromEnvironment(source: NodeJS.ProcessEnv = process.env) {
    const apiKey = source.BINANCE_API_KEY ?? "";
    const apiSecret = source.BINANCE_API_SECRET ?? "";
    if (!apiKey || !apiSecret) return null;
    return BinanceCredential.fromValues(apiKey, apiSecret);
  }

  static fromValues(apiKeyInput: string, apiSecretInput: string) {
    const apiKey = apiKeyInput.trim();
    const apiSecret = apiSecretInput.trim();
    if (!apiKey || !apiSecret) throw new Error("Binance credential is incomplete.");
    if (apiKey.length > 256 || apiSecret.length > 256) {
      throw new Error("Binance credential format is invalid.");
    }
    return new BinanceCredential(apiKey, apiSecret);
  }

  toClientCredentials(): BinanceCredentials {
    return { apiKey: this.apiKey, apiSecret: this.apiSecret };
  }

  maskedApiKey() {
    if (this.apiKey.length < 8) return "configured";
    return `${this.apiKey.slice(0, 4)}...${this.apiKey.slice(-4)}`;
  }
}
