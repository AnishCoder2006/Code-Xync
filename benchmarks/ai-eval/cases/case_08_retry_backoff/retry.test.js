const { computeBackoffDelay } = require("./retry");
const assert = require("assert");

const delay = computeBackoffDelay(20, { initialDelayMs: 1000, maxDelayMs: 30000, factor: 2 });
assert.ok(delay <= 30000, "Backoff delay exceeded maxDelayMs");
console.log("All tests passed.");
