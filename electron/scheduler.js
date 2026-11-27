const MAX_SLOTS = 4;

/** Normalize HH:MM; returns null if invalid. */
const normalizeSlot = (raw) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
};

/**
 * Dedupe + cap at 4 sorted slots. Throws if any slot is invalid.
 */
const normalizeSlots = (slots) => {
  const list = Array.isArray(slots) ? slots : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const s = normalizeSlot(raw);
    if (!s) throw new Error(`invalid time slot: ${raw}`);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_SLOTS) break;
  }
  return out.sort();
};

/** Local HH:MM for a Date. */
const currentHhMm = (now = new Date()) =>
  `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

/** YYYY-MM-DD local. */
const currentDayKey = (now = new Date()) => {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

/**
 * Which slots should fire now and have not already fired today.
 * `firedKeys` is a Set of `${day}|${HH:MM}`.
 */
const slotsDueNow = (slots, firedKeys, now = new Date()) => {
  const hhmm = currentHhMm(now);
  const day = currentDayKey(now);
  return normalizeSlots(slots).filter((s) => {
    if (s !== hhmm) return false;
    return !firedKeys.has(`${day}|${s}`);
  });
};

/**
 * Fired-keys to pre-mark when slots are saved: slots newly added/edited whose time is
 * already past or is the current minute. They are skipped for today and first run tomorrow,
 * so adding or editing a time never triggers an unneeded run.
 */
const passedNewSlotKeys = (prevSlots, nextSlots, now = new Date()) => {
  const prev = new Set(normalizeSlots(prevSlots));
  const hhmm = currentHhMm(now);
  const day = currentDayKey(now);
  return normalizeSlots(nextSlots)
    .filter((s) => !prev.has(s) && s <= hhmm)
    .map((s) => `${day}|${s}`);
};

/**
 * Next upcoming slot today or tomorrow (for UI display).
 * Returns { day, slot } or null.
 */
const nextSlotAfter = (slots, now = new Date()) => {
  const sorted = normalizeSlots(slots);
  if (!sorted.length) return null;
  const hhmm = currentHhMm(now);
  const today = currentDayKey(now);
  for (const s of sorted) {
    if (s > hhmm) return { day: today, slot: s };
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return { day: currentDayKey(tomorrow), slot: sorted[0] };
};

/**
 * Build up to 4 daily slots every `intervalHours` starting at `startHhMm`.
 * Wraps past midnight (e.g. 20:00 + 4h → 00:00).
 */
const slotsEveryHours = (startHhMm, intervalHours = 4) => {
  const start = normalizeSlot(startHhMm);
  if (!start) throw new Error(`invalid start time: ${startHhMm}`);
  const step = Number(intervalHours);
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`invalid interval hours: ${intervalHours}`);
  }
  const [h0, m0] = start.split(":").map(Number);
  const out = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const total = h0 * 60 + m0 + Math.round(i * step * 60);
    const hh = ((Math.floor(total / 60) % 24) + 24) % 24;
    const mm = ((total % 60) + 60) % 60;
    out.push(
      `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
    );
  }
  return normalizeSlots(out);
};

module.exports = {
  MAX_SLOTS,
  normalizeSlot,
  normalizeSlots,
  currentHhMm,
  currentDayKey,
  slotsDueNow,
  passedNewSlotKeys,
  nextSlotAfter,
  slotsEveryHours,
};
