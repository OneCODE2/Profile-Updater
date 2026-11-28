/** Redaction, bounds, and tiny hashing. No profile or PDF contents in logs. */

const LOG_MAX_BYTES = 20 * 1024;
const HISTORY_MAX = 50;
const HISTORY_MAX_BYTES = 128 * 1024;

const utf8Size = (value) => new TextEncoder().encode(String(value)).length;

const fnv1a = (value) => {
  let hash = 0x811c9dc5;
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
};

const redact = (input) => {
  let text = String(input ?? "");
  text = text.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    "[redacted-email]",
  );
  text = text.replace(/\b\d{10,}\b/g, "[redacted-number]");
  text = text.replace(/%PDF-[\s\S]{0,80}/g, "[redacted-pdf]");
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (text.length > 400) text = `${text.slice(0, 400)}…`;
  return text;
};

const escapeText = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[ch],
  );

const appendLog = (existing, line, maxBytes = LOG_MAX_BYTES) => {
  const safe = redact(line);
  let next = existing ? `${existing}\n${safe}` : safe;
  while (utf8Size(next) > maxBytes) {
    const cut = next.indexOf("\n");
    if (cut === -1) {
      next = next.slice(Math.max(0, next.length - 200));
      break;
    }
    next = next.slice(cut + 1);
  }
  return next;
};

const pushHistory = (history, item, maxItems = HISTORY_MAX, maxBytes = HISTORY_MAX_BYTES) => {
  const list = Array.isArray(history) ? history : [];
  const next = [item, ...list.filter((row) => row && row.runId !== item.runId)];
  const capped = next.slice(0, maxItems);
  while (utf8Size(JSON.stringify(capped)) > maxBytes && capped.length > 1) {
    capped.pop();
  }
  return capped;
};

module.exports = {
  LOG_MAX_BYTES,
  HISTORY_MAX,
  HISTORY_MAX_BYTES,
  utf8Size,
  fnv1a,
  redact,
  escapeText,
  appendLog,
  pushHistory,
};
