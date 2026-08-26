import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import { canonicalInstrumentFromId } from "../cex/Instrument";

/**
 * SPOT_PERPETUAL opening must start with Spot so that the second leg is the
 * Perpetual hedge. Other strategy types retain their existing leg ordering.
 */
export function validOpeningFirstLeg(instance: ArbitrageInstance, firstLegId: string) {
  if (instance.strategyType !== "SPOT_PERPETUAL") return true;
  const first = instance.legs.find((leg) => leg.legId === firstLegId);
  const second = instance.legs.find((leg) => leg.legId !== firstLegId);
  if (!first || !second) return false;
  try {
    return canonicalInstrumentFromId(first.instrumentId).contractType === "spot"
      && canonicalInstrumentFromId(second.instrumentId).contractType === "perpetual";
  } catch {
    return false;
  }
}
