/**
 * Parse a relative snooze argument like "2h", "30m", "1d", "1w".
 * Returns the target Date (from `from`) or null if unparseable.
 */
const UNITS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

export function parseRelativeDuration(arg: string, from: Date = new Date()): Date | null {
  const m = arg.trim().toLowerCase().match(/^(\d+)\s*(m|h|d|w)$/);
  if (!m || !m[1] || !m[2]) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = UNITS[m[2]];
  if (unit === undefined) return null;
  return new Date(from.getTime() + n * unit);
}

// Weekday name → 0-based index (Sun=0) in English and Russian.
const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, воскресенье: 0, вс: 0,
  mon: 1, monday: 1, понедельник: 1, пн: 1,
  tue: 2, tuesday: 2, вторник: 2, вт: 2,
  wed: 3, wednesday: 3, среда: 3, ср: 3,
  thu: 4, thursday: 4, четверг: 4, чт: 4,
  fri: 5, friday: 5, пятница: 5, пт: 5,
  sat: 6, saturday: 6, суббота: 6, сб: 6,
};

function getZonedParts(
  date: Date,
  tz: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number; dayOfWeek: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(date);
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
    second: Number(pick('second')),
    dayOfWeek: weekdayMap[pick('weekday')] ?? 0,
  };
}

/**
 * Given Y-M-D-H-M in a local TZ, find the UTC Date that represents that wall
 * clock. Works by iterative correction against the reverse formatter (handles
 * DST transitions accurately within ~1 iteration).
 */
function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  // First guess: treat wall clock as UTC
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = getZonedParts(new Date(guess), tz);
    const delta =
      (year - p.year) * 365 * 86_400_000 +
      (month - p.month) * 30 * 86_400_000 +
      (day - p.day) * 86_400_000 +
      (hour - p.hour) * 3_600_000 +
      (minute - p.minute) * 60_000;
    if (Math.abs(delta) < 30_000) break;
    guess += delta;
  }
  // Final polish: reuse the offset implied by the current guess
  const p = getZonedParts(new Date(guess), tz);
  const finalDelta =
    (year - p.year) * 365 * 86_400_000 +
    (month - p.month) * 30 * 86_400_000 +
    (day - p.day) * 86_400_000 +
    (hour - p.hour) * 3_600_000 +
    (minute - p.minute) * 60_000;
  guess += finalDelta;
  return new Date(guess);
}

/**
 * Parse an absolute time-of-day or weekday reference like:
 *   - "17:00" / "9:30" / "9"           → today at that hour (or tomorrow if past)
 *   - "tomorrow 9" / "завтра 18:30"    → next day at given hour
 *   - "monday" / "понедельник" / "пн"  → upcoming weekday at noon
 *   - "monday 10" / "пт 18:00"         → upcoming weekday at given hour
 * Returns the target Date (in UTC) or null if unparseable.
 */
export function parseAbsoluteTime(
  arg: string,
  tz: string,
  from: Date = new Date(),
): Date | null {
  const trimmed = arg.trim().toLowerCase();
  if (!trimmed) return null;
  const now = getZonedParts(from, tz);

  // "tomorrow 9:00" or "завтра 18"
  const tomMatch = trimmed.match(/^(?:tomorrow|завтра|ертең|ertan)\s*(\d{1,2})(?::(\d{2}))?$/);
  if (tomMatch && tomMatch[1]) {
    const h = parseInt(tomMatch[1], 10);
    const mm = tomMatch[2] ? parseInt(tomMatch[2], 10) : 0;
    if (h >= 0 && h < 24 && mm >= 0 && mm < 60) {
      const tomorrow = new Date(Date.UTC(now.year, now.month - 1, now.day, 0, 0, 0) + 86_400_000);
      const tp = getZonedParts(tomorrow, tz);
      return zonedWallClockToUtc(tp.year, tp.month, tp.day, h, mm, tz);
    }
  }

  // Weekday optionally followed by time: "monday 10:00", "пн 18", "пятница"
  const wdMatch = trimmed.match(/^([a-zа-яё]+)(?:\s+(\d{1,2})(?::(\d{2}))?)?$/i);
  if (wdMatch && wdMatch[1] && WEEKDAYS[wdMatch[1]] !== undefined) {
    const target = WEEKDAYS[wdMatch[1]]!;
    const h = wdMatch[2] ? parseInt(wdMatch[2], 10) : 12;
    const mm = wdMatch[3] ? parseInt(wdMatch[3], 10) : 0;
    if (h >= 0 && h < 24 && mm >= 0 && mm < 60) {
      // Compute day offset: nearest future occurrence (same-day if still in the future)
      let delta = (target - now.dayOfWeek + 7) % 7;
      if (delta === 0 && (h < now.hour || (h === now.hour && mm <= now.minute))) {
        delta = 7;
      }
      const t = new Date(Date.UTC(now.year, now.month - 1, now.day) + delta * 86_400_000);
      const tp = getZonedParts(t, tz);
      return zonedWallClockToUtc(tp.year, tp.month, tp.day, h, mm, tz);
    }
  }

  // Bare "HH:MM" or "H"
  const timeMatch = trimmed.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (timeMatch && timeMatch[1]) {
    const h = parseInt(timeMatch[1], 10);
    const mm = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    if (h >= 0 && h < 24 && mm >= 0 && mm < 60) {
      let y = now.year;
      let mo = now.month;
      let d = now.day;
      // If the specified time is not strictly after `now`, roll forward a day.
      if (h < now.hour || (h === now.hour && mm <= now.minute)) {
        const t = new Date(Date.UTC(y, mo - 1, d) + 86_400_000);
        const tp = getZonedParts(t, tz);
        y = tp.year;
        mo = tp.month;
        d = tp.day;
      }
      return zonedWallClockToUtc(y, mo, d, h, mm, tz);
    }
  }

  return null;
}

/** Try relative duration first, then absolute time. */
export function parseWhen(arg: string, from: Date = new Date(), tz: string): Date | null {
  return parseRelativeDuration(arg, from) ?? parseAbsoluteTime(arg, tz, from);
}
