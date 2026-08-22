import type { InstrumentVenue } from "../Instrument";
import type { PositionMode, PositionSnapshot } from "./PositionSnapshot";
import type { PositionSide } from "./PositionSide";

export type PositionReadRequest = Readonly<{
  accountId: string;
  instrumentId: string;
  expectedSide?: PositionSide;
  positionMode?: PositionMode;
}>;

export interface PositionReader {
  readonly venue: InstrumentVenue;
  readPosition(request: PositionReadRequest): Promise<PositionSnapshot>;
}
