/**
 * Install Chromium into the project tree so Render's build upload includes it.
 * PLAYWRIGHT_BROWSERS_PATH=0 => node_modules/playwright-core/.local-browsers
 */
const { execSync } = require("child_process");
const path = require("path");

process.env.PLAYWRIGHT_BROWSERS_PATH = "0";

execSync("npx playwright install chromium", {
  stdio: "inherit",
  env: process.env,
  cwd: path.join(__dirname, ".."),
});
