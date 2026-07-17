import type { RealPosition } from "../../../api/realTrading";
import type { HyperliquidCloid } from "../lib/hyperliquidCloid";

export type RealPositionCloseRequest = {
  cloid: HyperliquidCloid;
  limitPrice?: string;
  mode: "limit" | "market" | "reverse";
  positions: RealPosition[];
  scope: "all" | "single";
};

export type RealPositionTpslRequest = {
  cloid: HyperliquidCloid;
  position: RealPosition;
  slPrice?: string;
  tpPrice?: string;
};
