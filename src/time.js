// Timezone helpers without a date library. All schedule math happens in the
// business's own timezone; timestamps stored in the DB are ISO UTC.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function parts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** "2026-10-01" in the given timezone */
export function localDate(date, timeZone) {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localWeekday(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Offset (ms) of timeZone from UTC at a given instant. */
function tzOffsetMs(date, timeZone) {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC Date for local wall-clock "YYYY-MM-DD" + "HH:MM" in timeZone. */
export function zonedTime(dateStr, hhmm, timeZone) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const offset = tzOffsetMs(guess, timeZone);
  const result = new Date(guess.getTime() - offset);
  // second pass handles DST boundaries
  const offset2 = tzOffsetMs(result, timeZone);
  return offset2 === offset ? result : new Date(guess.getTime() - offset2);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Overridable clock so tests (and `--now`) can simulate any time of day. */
let fixedNow = null;
export function now() {
  return fixedNow ? new Date(fixedNow) : new Date();
}
export function setNow(value) {
  fixedNow = value ? new Date(value) : null;
}
