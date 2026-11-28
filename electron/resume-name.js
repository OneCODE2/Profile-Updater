const fs = require("fs");
const path = require("path");
const {
  sanitizePart,
  identityFromResumePath,
  resolveIdentity,
  buildResumeFileName,
} = require("../shared/filename");

/**
 * Copy source PDF into destDir under the standard name. Returns absolute path.
 * Blank identity fields are filled from the source file name when possible.
 */
const prepareResumeCopy = (sourcePath, destDir, identity, now = new Date()) => {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`resume file missing: ${sourcePath || "(empty)"}`);
  }
  if (path.extname(sourcePath).toLowerCase() !== ".pdf") {
    throw new Error("resume must be a PDF file");
  }
  fs.mkdirSync(destDir, { recursive: true });
  const resolved = resolveIdentity(identity, sourcePath);
  const fileName = buildResumeFileName(resolved, now);
  const destPath = path.join(destDir, fileName);
  fs.copyFileSync(sourcePath, destPath);
  return destPath;
};

module.exports = {
  sanitizePart,
  identityFromResumePath,
  resolveIdentity,
  buildResumeFileName,
  prepareResumeCopy,
};
