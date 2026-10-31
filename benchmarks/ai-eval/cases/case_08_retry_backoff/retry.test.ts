import { computeBackoffDelay } from "./retry";

const delay = computeBackoffDelay(20, { initialDelayMs: 1000, maxDelayMs: 30000, factor: 2 });
if (delay > 30000) throw new Error("Backoff delay exceeded maxDelayMs");
