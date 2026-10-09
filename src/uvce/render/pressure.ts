/**
 * GPU-pressure signal for the render planner, from frame timing only (GPU timer queries proved too noisy on the
 * measured hardware: docs/benchmark-results/gpu/2026-10-09-rtx3070/README.md).
 *
 *   refresh  = the shortest frame period ever observed (running minimum of per-window p25 intervals): vsync cannot be
 *              faster than the display, so this converges on the refresh period after the first quiet window;
 *   pressure = frames are being missed (median interval > missFactor × refresh) although the main thread is not the
 *              reason (median CPU time < cpuShare × interval) => the GPU (or compositor) is the bottleneck.
 *
 * A CPU-bound frame (CPU time ~ interval) is NOT pressure: caching saves GPU work, its bakes cost CPU. Frames that
 * fit vsync are not pressure either: nothing to save. Pure logic, unit-tested.
 */

export interface PressureOptions {
  windowFrames: number;
  missFactor: number;
  cpuShare: number;
}

export interface PressureReading {
  pressure: boolean;
  refreshMs: number | null;
  intervalP50: number | null;
  cpuP50: number | null;
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] as number;
};
const quantile = (v: number[], q: number): number => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
};

export class GpuPressureDetector {
  readonly options: PressureOptions;
  private intervals: number[] = [];
  private cpu: number[] = [];
  private refresh = Number.POSITIVE_INFINITY;
  private reading: PressureReading = { pressure: false, refreshMs: null, intervalP50: null, cpuP50: null };

  constructor(options: Partial<PressureOptions> = {}) {
    this.options = { windowFrames: 60, missFactor: 1.2, cpuShare: 0.75, ...options };
  }

  /** One rendered frame: time since the previous frame and main-thread CPU time of this frame (ms). */
  push(intervalMs: number, cpuMs: number): PressureReading {
    if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) return this.reading;
    this.intervals.push(intervalMs);
    this.cpu.push(cpuMs);
    if (this.intervals.length >= this.options.windowFrames) {
      this.refresh = Math.max(4, Math.min(this.refresh, quantile(this.intervals, 0.25)));
      const intervalP50 = median(this.intervals);
      const cpuP50 = median(this.cpu);
      this.reading = {
        pressure: intervalP50 > this.options.missFactor * this.refresh && cpuP50 < this.options.cpuShare * intervalP50,
        refreshMs: this.refresh,
        intervalP50,
        cpuP50,
      };
      this.intervals = [];
      this.cpu = [];
    }
    return this.reading;
  }

  get current(): PressureReading {
    return this.reading;
  }
}
