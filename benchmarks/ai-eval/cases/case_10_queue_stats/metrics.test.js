const { calculateThroughput } = require("./metrics");
const assert = require("assert");

const rate = calculateThroughput({ processedCount: 10, elapsedSeconds: 0 });
assert.ok(Number.isFinite(rate), "Rate should be 0 or finite when elapsed is 0");
console.log("All tests passed.");
