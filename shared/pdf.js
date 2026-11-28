/** PDF screening. Format check only — not malware scanning. */

const PDF_MAX_BYTES = 6000000;

const headerText = (bytes) => {
  if (!bytes) return "";
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = Math.min(u8.length, 1024);
  let out = "";
  for (let i = 0; i < n; i++) out += String.fromCharCode(u8[i]);
  return out;
};

const mimeAllowed = (mime) => {
  if (mime == null) return true;
  const m = String(mime).trim().toLowerCase();
  if (!m) return true;
  return (
    m === "application/pdf" ||
    m === "application/x-pdf" ||
    m === "application/octet-stream" ||
    m === "application/binary"
  );
};

/**
 * Accept only a non-empty PDF of at most 6_000_000 bytes.
 * User-facing rejection text is always the exact required sentence.
 */
const screenPdf = ({ name, byteLength, mime, header } = {}) => {
  const fail = (detail) => ({
    ok: false,
    message: "Choose a PDF under 6 MB",
    detail,
  });
  const fileName = String(name || "");
  if (!fileName.toLowerCase().endsWith(".pdf")) return fail("Use a .pdf file.");
  const size = Number(byteLength);
  if (!Number.isFinite(size) || size <= 0) return fail("The file is empty.");
  if (size > PDF_MAX_BYTES) return fail("The file is larger than 6 MB.");
  if (!mimeAllowed(mime)) return fail("The file type is not a PDF.");
  if (!headerText(header).includes("%PDF-")) {
    return fail("The file does not look like a PDF.");
  }
  return { ok: true };
};

const resumeMetaFrom = (record) => {
  if (!record) return null;
  return {
    originalName: String(record.name || "resume.pdf"),
    size: Number(record.byteLength || record.size || 0),
    mime: record.mime ? String(record.mime) : "",
    revision: Number(record.revision || 0),
    selectedAt: record.selectedAt || null,
  };
};

/**
 * IndexedDB is the authority. If metadata lagged a successful byte write, adopt the record.
 * Missing or corrupt bytes block upload until the user picks a file again.
 */
const reconcileResume = (meta, record) => {
  if (!record) {
    if (!meta) return { meta: null, status: "empty" };
    return {
      meta: null,
      status: "missing",
      message: "Saved resume is unavailable. Please select it again.",
    };
  }
  const headerOk =
    record.headerOk === true ||
    headerText(record.header).includes("%PDF-");
  const size = Number(record.byteLength || record.size || 0);
  if (!headerOk || size <= 0 || size > PDF_MAX_BYTES) {
    return {
      meta: null,
      status: "corrupt",
      message: "Saved resume is unavailable. Please select it again.",
    };
  }
  const aligned = resumeMetaFrom(record);
  if (!meta || meta.revision !== aligned.revision || meta.size !== aligned.size) {
    return { meta: aligned, status: "reconciled" };
  }
  return { meta, status: "ok" };
};

module.exports = {
  PDF_MAX_BYTES,
  screenPdf,
  resumeMetaFrom,
  reconcileResume,
  headerText,
};
