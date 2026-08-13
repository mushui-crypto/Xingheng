import { createAsset, type Asset } from "./Asset";

export interface CanonicalAssetSource {
  getAsset(symbol: string): Asset | null;
}

export class ExplicitCanonicalAssetSource implements CanonicalAssetSource {
  private readonly assets: ReadonlyMap<string, Asset>;

  constructor(definitions: readonly Asset[]) {
    const assets = new Map<string, Asset>();
    for (const definition of definitions) {
      const asset = createAsset(definition);
      if (assets.has(asset.symbol)) {
        throw new Error(`Duplicate canonical asset definition: ${asset.symbol}.`);
      }
      assets.set(asset.symbol, asset);
    }
    this.assets = assets;
  }

  getAsset(symbol: string) {
    return this.assets.get(symbol) ?? null;
  }
}

export const EXECUTION_CANONICAL_ASSET_DEFINITIONS: readonly Asset[] = Object.freeze([
  createAsset({ symbol: "BTC", type: "DIGITAL_ASSET" }),
  createAsset({ symbol: "ETH", type: "DIGITAL_ASSET" }),
  createAsset({ symbol: "DOGE", type: "DIGITAL_ASSET" }),
  createAsset({ symbol: "XAUT", type: "RWA_ASSET" }),
]);

export function createExecutionCanonicalAssetSource() {
  return new ExplicitCanonicalAssetSource(EXECUTION_CANONICAL_ASSET_DEFINITIONS);
}
