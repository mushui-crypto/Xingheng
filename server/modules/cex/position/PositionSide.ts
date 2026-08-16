export const POSITION_SIDES = ["LONG", "SHORT", "FLAT"] as const;

export type PositionSide = typeof POSITION_SIDES[number];

export function isPositionSide(value: unknown): value is PositionSide {
  return POSITION_SIDES.some((side) => side === value);
}
