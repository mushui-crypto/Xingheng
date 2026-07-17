const formatters = new Map<string, Intl.DateTimeFormat>();

export function newYorkTime(timestampSeconds: number) {
  return timeInZone(timestampSeconds, "America/New_York");
}

export function timeInZone(timestampSeconds: number, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestampSeconds * 1000))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.type === "weekday" ? part.value : Number(part.value)]),
  );
  return {
    dateKey: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: String(parts.weekday),
    isWeekend: parts.weekday === "Sat" || parts.weekday === "Sun",
  };
}

export function isWithinNewYorkSession(timestampSeconds: number, startMinute: number, endMinute: number) {
  return isWithinTimeZoneSession(timestampSeconds, "America/New_York", startMinute, endMinute);
}

export function isWithinTimeZoneSession(
  timestampSeconds: number,
  timeZone: string,
  startMinute: number,
  endMinute: number,
) {
  const minute = timeInZone(timestampSeconds, timeZone).minuteOfDay;
  if (startMinute === endMinute) return true;
  if (startMinute < endMinute) return minute >= startMinute && minute < endMinute;
  return minute >= startMinute || minute < endMinute;
}
