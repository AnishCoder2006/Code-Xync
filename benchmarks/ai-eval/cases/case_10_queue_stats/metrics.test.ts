import { calculateThroughput } from "./metrics";

const rate = calculateThroughput({ processedCount: 10, elapsedSeconds: 0 });
if (!Number.isFinite(rate)) throw new Error("Rate should be 0 or finite when elapsed is 0");
