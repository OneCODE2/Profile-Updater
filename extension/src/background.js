const { createApp, chromePlatform } = require("./app");

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onInstalled) {
  let major = null;
  const brands = globalThis.navigator?.userAgentData?.brands || [];
  const chromeBrand = brands.find((brand) => /Chrom/i.test(brand.brand || ""));
  if (chromeBrand) major = Number(String(chromeBrand.version).split(".")[0]);
  const app = createApp(chromePlatform(chrome, { chromeMajor: major }));
  chrome.runtime.onInstalled.addListener(() => {
    void app.onInstalled();
  });
  chrome.runtime.onStartup.addListener(() => {
    void app.onStartup();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    void app.onAlarm(alarm);
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    app.onMessage(msg, sender).then(sendResponse, (err) => {
      sendResponse({ ok: false, message: err?.message || "Could not save local extension data." });
    });
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void app.onTabRemoved(tabId);
  });
}
