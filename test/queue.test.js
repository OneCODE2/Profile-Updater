const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { withQueue, isBusy } = require("../server/queue");

describe("withQueue", () => {
  it("runs jobs one at a time", async () => {
    const order = [];
    const a = withQueue(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
      return 1;
    });
    const b = withQueue(async () => {
      order.push("b-start");
      order.push("b-end");
      return 2;
    });
    const results = await Promise.all([a, b]);
    assert.deepEqual(results, [1, 2]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
    assert.equal(isBusy(), false);
  });
});
