/** Rolling frame statistics (ring buffers) with nearest-rank percentiles. */
export class RollingSeries {
  private readonly values: Float64Array;
  private count = 0;
  private head = 0;

  constructor(capacity: number) {
    this.values = new Float64Array(capacity);
  }

  push(v: number): void {
    this.values[this.head] = v;
    this.head = (this.head + 1) % this.values.length;
    if (this.count < this.values.length) this.count++;
  }

  get size(): number {
    return this.count;
  }

  snapshot(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.values[(this.head - this.count + i + this.values.length) % this.values.length] as number);
    return out;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
  }
}

/** Nearest-rank percentile (p in [0,100]) of an unsorted list; NaN for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] as number;
}

export interface SeriesSummary {
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function summarize(values: readonly number[]): SeriesSummary {
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN;
  return {
    samples: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : Number.NaN,
    mean,
  };
}
