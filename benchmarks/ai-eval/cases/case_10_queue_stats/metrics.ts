export interface QueueMetrics {
    processedCount: number;
    elapsedSeconds: number;
}

export function calculateThroughput(metrics: QueueMetrics): number {
    // BUG: throws or returns Infinity when elapsedSeconds is 0.0
    return metrics.processedCount / metrics.elapsedSeconds;
}

export function formatThroughput(rate: number): string {
    return `${rate.toFixed(2)} jobs/sec`;
}
