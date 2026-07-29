// No imports needed — logger used only by setInterval which moved to index.ts

interface Metric {
  name: string;
  value: number;
  timestamp: number;
  tags?: Record<string, string>;
}

interface MetricsSnapshot {
  uploadLatency: { p50: number; p95: number; p99: number };
  uploadThroughput: number;
  queueSize: number;
  errorRate: number;
  cacheHitRate: number;
  botUtilization: number;
  timestamp: number;
}

class MetricsCollector {
  private metrics: Metric[] = [];
  private uploadTimes: number[] = [];
  private errorCount = 0;
  private totalRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private maxMetricsSize = 10000;

  recordUploadTime(durationMs: number): void {
    this.uploadTimes.push(durationMs);
    this.totalRequests++;

    // Keep only last 1000 measurements
    if (this.uploadTimes.length > 1000) {
      this.uploadTimes.shift();
    }
  }

  recordError(): void {
    this.errorCount++;
  }

  recordCacheHit(): void {
    this.cacheHits++;
  }

  recordCacheMiss(): void {
    this.cacheMisses++;
  }

  recordMetric(name: string, value: number, tags?: Record<string, string>): void {
    this.metrics.push({
      name,
      value,
      timestamp: Date.now(),
      tags,
    });

    // Keep metrics bounded
    if (this.metrics.length > this.maxMetricsSize) {
      this.metrics = this.metrics.slice(-this.maxMetricsSize);
    }
  }

  private calculatePercentile(arr: number[], percentile: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  getSnapshot(): MetricsSnapshot {
    const errorRate = this.totalRequests > 0 ? (this.errorCount / this.totalRequests) * 100 : 0;
    const cacheHitRate =
      this.cacheHits + this.cacheMisses > 0
        ? (this.cacheHits / (this.cacheHits + this.cacheMisses)) * 100
        : 0;

    return {
      uploadLatency: {
        p50: this.calculatePercentile(this.uploadTimes, 50),
        p95: this.calculatePercentile(this.uploadTimes, 95),
        p99: this.calculatePercentile(this.uploadTimes, 99),
      },
      uploadThroughput: this.totalRequests > 0 ? this.totalRequests / 60 : 0,
      queueSize: 0, // Will be updated by queue
      errorRate,
      cacheHitRate,
      botUtilization: 0, // Will be updated by bot tracker
      timestamp: Date.now(),
    };
  }

  reset(): void {
    this.uploadTimes = [];
    this.errorCount = 0;
    this.totalRequests = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.metrics = [];
  }

  getMetrics(name?: string): Metric[] {
    if (!name) return this.metrics;
    return this.metrics.filter((m) => m.name === name);
  }
}

export const metricsCollector = new MetricsCollector();

export { MetricsCollector };
