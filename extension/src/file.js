/** Build a browser File for one authorized upload. */
const toUploadFile = (bytes, fileName) => {
  const blob = new Blob([bytes], { type: "application/pdf" });
  return new File([blob], fileName, { type: "application/pdf" });
};

module.exports = { toUploadFile };
