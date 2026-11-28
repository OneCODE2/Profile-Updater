/** Calendar and time-zone helpers. Dates are passed in; nothing reads the clock implicitly except the default zone name. */

const systemTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const localParts = (date, timeZone = systemTimeZone()) => {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const bag = {};
  for (const part of fmt.formatToParts(date)) bag[part.type] = part.value;
  let hour = bag.hour === "24" ? "00" : bag.hour;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    dayNum: Number(bag.day),
    day: `${bag.year}-${bag.month}-${bag.day}`,
    hhmm: `${hour}:${bag.minute}`,
    hour: Number(hour),
    minute: Number(bag.minute),
  };
};

/** Add calendar days to a YYYY-MM-DD key. Not an instant plus 86_400_000 ms. */
const addCalendarDays = (day, delta) => {
  const [y, m, d] = String(day).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
};

const slotKey = (day, hhmm) => `${day}|${hhmm}`;

/**
 * UTC epoch for a local civil time. Returns the matching instant when one exists.
 * Nonexistent DST times do not round-trip; callers must check localTimeExists.
 */
const epochFromLocal = (day, hhmm, timeZone = systemTimeZone()) => {
  const [year, month, dayNum] = day.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  let guess = Date.UTC(year, month - 1, dayNum, hour, minute, 0);
  for (let i = 0; i < 6; i++) {
    const parts = localParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.dayNum,
      parts.hour,
      parts.minute,
      0,
    );
    const want = Date.UTC(year, month - 1, dayNum, hour, minute, 0);
    const diff = want - asUtc;
    if (diff === 0) return guess;
    guess += diff;
  }
  return guess;
};

const localTimeExists = (day, hhmm, timeZone = systemTimeZone()) => {
  const epoch = epochFromLocal(day, hhmm, timeZone);
  const parts = localParts(new Date(epoch), timeZone);
  return parts.day === day && parts.hhmm === hhmm;
};

const zoneSignature = (date, timeZone = systemTimeZone()) => {
  let offset = "";
  try {
    offset = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
      hour: "2-digit",
    })
      .formatToParts(date)
      .filter((p) => p.type === "timeZoneName")
      .map((p) => p.value)
      .join("");
  } catch {
    offset = "";
  }
  return `${timeZone}|${offset}`;
};

module.exports = {
  systemTimeZone,
  localParts,
  addCalendarDays,
  slotKey,
  epochFromLocal,
  localTimeExists,
  zoneSignature,
};
