export interface BackoffConfig {
    initialDelayMs: number;
    maxDelayMs: number;
    factor: number;
}

export function computeBackoffDelay(attempt: number, config: BackoffConfig): number {
    // BUG: Math.min is not applied to maxDelayMs, causing multi-hour delay on attempt 20
    const delay = config.initialDelayMs * Math.pow(config.factor, attempt);
    return delay;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(res => setTimeout(res, ms));
}
