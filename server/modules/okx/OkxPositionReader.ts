import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { OkxAccountIdentity, OkxPerpetualPosition } from "./OkxTypes";

export type OkxPositionReaderClient = Readonly<{
  getAccountIdentity(): Promise<OkxAccountIdentity>;
  getPosition(instId: string): Promise<readonly OkxPerpetualPosition[]>;
}>;

export type OkxPositionReadRequest = Readonly<{
  record: ExecutionRecord;
  instId: string;
}>;

export type OkxPositionReadResult = Readonly<{
  account: OkxAccountIdentity;
  positions: readonly OkxPerpetualPosition[];
  instId: string;
}>;

export class OkxPositionReader {
  constructor(private readonly client: OkxPositionReaderClient) {}

  async read(request: OkxPositionReadRequest): Promise<OkxPositionReadResult> {
    if (request.record.venue !== "okx") {
      throw new Error("OKX position read requires an OKX execution record.");
    }
    const account = await this.client.getAccountIdentity();
    const positions = await this.client.getPosition(request.instId);
    return Object.freeze({
      account,
      positions: Object.freeze([...positions]),
      instId: request.instId,
    });
  }
}
