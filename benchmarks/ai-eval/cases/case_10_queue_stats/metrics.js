function calculateThroughput(metrics) {
    // BUG: throws or returns Infinity when elapsedSeconds is 0.0
    return metrics.processedCount / metrics.elapsedSeconds;
}

function formatThroughput(rate) {
    return `${rate.toFixed(2)} jobs/sec`;
}

module.exports = { calculateThroughput, formatThroughput };
