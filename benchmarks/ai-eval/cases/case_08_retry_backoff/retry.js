function computeBackoffDelay(attempt, config) {
    // BUG: Math.min is not applied to maxDelayMs, causing unbounded delay
    const delay = config.initialDelayMs * Math.pow(config.factor, attempt);
    return delay;
}

function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}

module.exports = { computeBackoffDelay, sleep };
