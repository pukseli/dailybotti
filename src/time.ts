// Calendar helpers. Days are "YYYY-MM-DD" strings in the group's timezone, so they compare and sort as text.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Local date ("2026-10-23") and time ("21:05") of an instant in a timezone. */
export function localParts(instant: Date, timeZone: string): { date: string; time: string } {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function isValidCloseTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number) as [number, number, number];
  const [y2, m2, d2] = to.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5);
}

/** Monday ("YYYY-MM-DD") of the ISO week (Mon–Sun) containing `day`. */
export function weekMonday(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDays(day, offset);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-23" → "Fri 23 Oct" */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

/**
 * A day closes at closeTime on that day, or at the following midnight when closeTime is "00:00".
 * Compares wall-clock values in the group's timezone, so daylight saving changes need no special care.
 */
export function isClosed(day: string, now: Date, timeZone: string, closeTime: string): boolean {
  const { date, time } = localParts(now, timeZone);
  if (date > day) return true;
  if (date < day) return false;
  return closeTime !== "00:00" && time >= closeTime;
}
