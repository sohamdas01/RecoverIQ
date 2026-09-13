/**
 * RecoverIQ Prometheus-Compatible Metrics Registry
 * Phase 6 - Step 2: Metrics, Health Checks & Readiness Probes
 *
 * Lightweight, zero-external-dependency in-memory metrics engine supporting:
 * - Counters, Histograms, Gauges
 * - Strict low-cardinality label serialization
 * - Standard Prometheus Exposition Format (text/plain; version=0.0.4)
 */

const DEFAULT_HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Normalizes label object into sorted key-value pairs for map hashing
 */
function serializeLabels(labels = {}) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys
    .map((k) => {
      const val = labels[k] !== undefined && labels[k] !== null ? String(labels[k]) : '';
      const safeVal = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
      return `${k}="${safeVal}"`;
    })
    .join(',');
}

/**
 * Counter Metric
 */
export class Counter {
  constructor({ name, help, labelNames = [] }) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.type = 'counter';
    this.values = new Map();
  }

  inc(labels = {}, value = 1) {
    if (value < 0) {
      throw new Error(`Counter ${this.name} cannot be decremented`);
    }
    const key = serializeLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  get(labels = {}) {
    const key = serializeLabels(labels);
    return this.values.get(key) || 0;
  }

  reset() {
    this.values.clear();
  }

  toPrometheusText() {
    let lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [labelStr, val] of this.values.entries()) {
        if (labelStr) {
          lines.push(`${this.name}{${labelStr}} ${val}`);
        } else {
          lines.push(`${this.name} ${val}`);
        }
      }
    }
    return lines.join('\n');
  }
}

/**
 * Gauge Metric
 */
export class Gauge {
  constructor({ name, help, labelNames = [] }) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.type = 'gauge';
    this.values = new Map();
  }

  set(labels = {}, value = 0) {
    const key = serializeLabels(labels);
    this.values.set(key, Number(value));
  }

  inc(labels = {}, value = 1) {
    const key = serializeLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  dec(labels = {}, value = 1) {
    const key = serializeLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current - value);
  }

  get(labels = {}) {
    const key = serializeLabels(labels);
    return this.values.get(key) || 0;
  }

  reset() {
    this.values.clear();
  }

  toPrometheusText() {
    let lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [labelStr, val] of this.values.entries()) {
        if (labelStr) {
          lines.push(`${this.name}{${labelStr}} ${val}`);
        } else {
          lines.push(`${this.name} ${val}`);
        }
      }
    }
    return lines.join('\n');
  }
}

/**
 * Histogram Metric
 */
export class Histogram {
  constructor({ name, help, labelNames = [], buckets = DEFAULT_HISTOGRAM_BUCKETS }) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.type = 'histogram';
    this.data = new Map();
  }

  _getOrCreateSeries(key) {
    if (!this.data.has(key)) {
      this.data.set(key, {
        bucketCounts: new Array(this.buckets.length).fill(0),
        infCount: 0,
        sum: 0,
        count: 0,
      });
    }
    return this.data.get(key);
  }

  observe(labels = {}, value = 0) {
    const num = Number(value);
    const key = serializeLabels(labels);
    const series = this._getOrCreateSeries(key);

    series.count += 1;
    series.sum += num;

    for (let i = 0; i < this.buckets.length; i++) {
      if (num <= this.buckets[i]) {
        series.bucketCounts[i] += 1;
      }
    }
    series.infCount += 1;
  }

  startTimer(labels = {}) {
    const start = process.hrtime.bigint();
    return () => {
      const end = process.hrtime.bigint();
      const durationSeconds = Number(end - start) / 1e9;
      this.observe(labels, durationSeconds);
      return durationSeconds;
    };
  }

  reset() {
    this.data.clear();
  }

  toPrometheusText() {
    let lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];

    if (this.data.size === 0) {
      for (const b of this.buckets) {
        lines.push(`${this.name}_bucket{le="${b}"} 0`);
      }
      lines.push(`${this.name}_bucket{le="+Inf"} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
    } else {
      for (const [labelStr, series] of this.data.entries()) {
        const prefix = labelStr ? `${labelStr},` : '';

        for (let i = 0; i < this.buckets.length; i++) {
          lines.push(`${this.name}_bucket{${prefix}le="${this.buckets[i]}"} ${series.bucketCounts[i]}`);
        }
        lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${series.infCount}`);

        const sumLabelStr = labelStr ? `{${labelStr}}` : '';
        lines.push(`${this.name}_sum${sumLabelStr} ${series.sum.toFixed(6)}`);
        lines.push(`${this.name}_count${sumLabelStr} ${series.count}`);
      }
    }

    return lines.join('\n');
  }
}

/**
 * Central Metrics Registry
 */
export class MetricsRegistry {
  constructor() {
    this.metrics = new Map();
    this.contentType = 'text/plain; version=0.0.4; charset=utf-8';
  }

  register(metric) {
    if (this.metrics.has(metric.name)) {
      return this.metrics.get(metric.name);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  getMetric(name) {
    return this.metrics.get(name);
  }

  getMetrics() {
    const parts = [];
    for (const metric of this.metrics.values()) {
      parts.push(metric.toPrometheusText());
    }
    return parts.join('\n\n') + '\n';
  }

  reset() {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
  }

  createCounter(options) {
    const counter = new Counter(options);
    return this.register(counter);
  }

  createGauge(options) {
    const gauge = new Gauge(options);
    return this.register(gauge);
  }

  createHistogram(options) {
    const histogram = new Histogram(options);
    return this.register(histogram);
  }
}

export const defaultRegistry = new MetricsRegistry();
