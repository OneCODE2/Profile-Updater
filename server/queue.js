/** Single Playwright job at a time (free Render RAM). */
let busy = false;
const waiters = [];

function isBusy() {
  return busy;
}

async function withQueue(fn) {
  if (busy) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
    const next = waiters.shift();
    if (next) next();
  }
}

module.exports = { withQueue, isBusy };
