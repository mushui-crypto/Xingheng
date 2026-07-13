import type { RealPosition } from "../../../api/realTrading";

export type RealPositionCloseRequest = {
  limitPrice?: string;
  mode: "limit" | "market" | "reverse";
  positions: RealPosition[];
  scope: "all" | "single";
};

export type RealPositionTpslRequest = {
  position: RealPosition;
  slPrice?: string;
  tpPrice?: string;
};
