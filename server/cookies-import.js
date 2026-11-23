/**
 * Convert pasted Cookie-Editor / Playwright JSON into Playwright storageState.
 */

function isNaukriDomain(domain) {
  const d = String(domain || "")
    .replace(/^\./, "")
    .toLowerCase();
  return d === "naukri.com" || d.endsWith(".naukri.com");
}

function mapSameSite(value) {
  const v = String(value || "Lax").toLowerCase();
  if (v === "no_restriction" || v === "none") return "None";
  if (v === "strict") return "Strict";
  if (v === "unspecified" || v === "lax") return "Lax";
  if (value === "None" || value === "Lax" || value === "Strict") return value;
  return "Lax";
}

function normalizeCookie(raw) {
  const name = String(raw.name || "").trim();
  const value = raw.value == null ? "" : String(raw.value);
  let domain = String(raw.domain || "").trim();
  if (!name || !domain) return null;
  if (!domain.startsWith(".") && domain.split(".").length >= 2) {
    // Cookie-Editor hostOnly cookies often omit leading dot; keep as-is.
  }
  const path = String(raw.path || "/");
  let expires = -1;
  if (typeof raw.expires === "number") {
    expires = raw.expires;
  } else if (typeof raw.expirationDate === "number") {
    expires = raw.expirationDate;
  }
  return {
    name,
    value,
    domain,
    path,
    expires,
    httpOnly: Boolean(raw.httpOnly),
    secure: Boolean(raw.secure),
    sameSite: mapSameSite(raw.sameSite),
  };
}

function parseSessionImport(rawText) {
  let parsed;
  try {
    parsed = typeof rawText === "string" ? JSON.parse(rawText) : rawText;
  } catch {
    throw new Error("Paste valid JSON (Cookie-Editor export or Playwright storageState).");
  }

  let cookies = [];
  if (parsed && Array.isArray(parsed.cookies)) {
    cookies = parsed.cookies;
  } else if (Array.isArray(parsed)) {
    cookies = parsed;
  } else {
    throw new Error(
      "Unrecognized format. Export cookies as JSON from Cookie-Editor, or paste Playwright storageState.",
    );
  }

  const normalized = cookies
    .map(normalizeCookie)
    .filter(Boolean)
    .filter((c) => isNaukriDomain(c.domain));

  if (!normalized.length) {
    throw new Error(
      "No Naukri cookies found. On naukri.com, export cookies for this site and paste the JSON.",
    );
  }

  return {
    cookies: normalized,
    origins: Array.isArray(parsed && parsed.origins) ? parsed.origins : [],
  };
}

module.exports = { parseSessionImport, isNaukriDomain };
