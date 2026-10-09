/**
 * Adaptive render planner (Milestone 3, blueprint §4.3): chooses per appearance group between SHADER (default) and
 * FULL_CACHE, from measurements rather than guesses.
 *
 * Measured basis (RTX 3070 matrix, docs/benchmark-results/gpu/2026-10-09-rtx3070-pending-runs): FULL_CACHE beat SHADER
 * only where its hit ratio was ~0.98 (a formation crowd); at 0.73–0.79 it lost 3–11 %. Hence:
 *  - a group's *potential* hit ratio is estimated while it is still on SHADER, without baking anything:
 *    1 - distinct frame keys / requests over a window (the hits a large enough cache would have had);
 *  - promotion needs potential >= promoteHitRatio (0.9) and room in the cache: the frames all cached groups need AT
 *    THE SAME TIME (peak distinct keys in one frame; LRU recycles frames that are no longer shown) must fit in
 *    capacityShare (80 %) of the cells; the biggest groups win the room first;
 *  - demotion when the measured hit ratio falls below demoteHitRatio (0.6);
 *  - hysteresis: a group keeps its mode for at least minResidenceFrames (240 frames ≈ 4 s) before switching again,
 *    so no mode thrashing;
 *  - GPU-pressure gate (requirePressure): FULL_CACHE saves GPU fill, not draw calls or CPU. On a machine that is not
 *    GPU-bound the RTX 3070 runs showed AUTO losing 4–15 %, so groups are promoted only while setPressure(true) says
 *    the GPU is the bottleneck (see pressure.ts). Demotion does not need pressure.
 *
 * Feeding: the renderer calls request() for every visible character every frame (a counter) and enter()/leave() only
 * when a character starts/stops showing a frame, so steady frames cost O(1) per character. observe() is the
 * stateless form (one request of one frame key) used by tests and simple callers.
 * Pure logic (no three.js), unit-tested in Node. The renderer feeds observe()/recordLookup() and asks isCached().
 */

export interface PlannerOptions {
  windowFrames: number;
  promoteHitRatio: number;
  demoteHitRatio: number;
  minResidenceFrames: number;
  /** Requests a group needs in a window before any decision about it (avoids deciding on noise). */
  minRequests: number;
  /** Frame-cache cells available to the planner. */
  capacityCells: number;
  capacityShare: number;
  /** Promote only while the GPU is the measured bottleneck (setPressure). */
  requirePressure: boolean;
}

export const DEFAULT_PLANNER_OPTIONS: Omit<PlannerOptions, 'capacityCells'> = {
  windowFrames: 60,
  promoteHitRatio: 0.9,
  demoteHitRatio: 0.6,
  minResidenceFrames: 240,
  minRequests: 30,
  capacityShare: 0.8,
  requirePressure: true,
};

export interface PlannerDecision {
  group: string;
  to: 'FULL_CACHE' | 'SHADER';
  reason: string;
}

export interface PlannerStats {
  groups: number;
  cachedGroups: number;
  promotions: number;
  demotions: number;
  /** Distinct frames of the cached groups in the last window vs the planner's share of the cache. */
  capacityUsed: number;
  capacityLimit: number;
  pressure: boolean;
}

interface Group {
  cached: boolean;
  /** Frame of the last mode switch (or first sight). */
  since: number;
  lastSeen: number;
  requests: number;
  keys: Set<string>;
  lookups: number;
  hits: number;
  /** Peak distinct frames requested in a single frame during the previous window (capacity accounting). */
  distinct: number;
  /** Frames requested in the current frame, and the peak of their count over the window. */
  frameKeys: Set<string>;
  keysFrame: number;
  peak: number;
  /** Frames currently shown by this group's characters (enter/leave), with the number of characters on each. */
  live: Map<string, number>;
}

export class RenderPlanner {
  readonly options: PlannerOptions;
  private readonly groups = new Map<string, Group>();
  private frame = 0;
  private windowStart = 0;
  private promotions = 0;
  private demotions = 0;
  private capacityUsed = 0;
  private pressure = false;

  constructor(options: Partial<PlannerOptions> & { capacityCells: number }) {
    this.options = { ...DEFAULT_PLANNER_OPTIONS, ...options };
  }

  beginFrame(frame: number): void {
    this.frame = frame;
  }

  private group(key: string): Group {
    let g = this.groups.get(key);
    if (!g) {
      g = { cached: false, since: this.frame - this.options.minResidenceFrames, lastSeen: this.frame, requests: 0, keys: new Set(), lookups: 0, hits: 0, distinct: 0, frameKeys: new Set(), keysFrame: -1, peak: 0, live: new Map() };
      this.groups.set(key, g);
    }
    return g;
  }

  /** One visible character of `group` wants frame `frameKey` this frame. */
  observe(group: string, frameKey: string): void {
    const g = this.group(group);
    g.lastSeen = this.frame;
    g.requests++;
    g.keys.add(frameKey);
    if (g.keysFrame !== this.frame) {
      g.keysFrame = this.frame;
      g.frameKeys.clear();
    }
    g.frameKeys.add(frameKey);
    if (g.frameKeys.size > g.peak) g.peak = g.frameKeys.size;
  }

  /** A visible character of group is drawn this frame (call every frame; O(1)). */
  request(group: string): void {
    const g = this.group(group);
    g.lastSeen = this.frame;
    g.requests++;
  }

  /** A character of group starts showing rameKey (call only when its frame changes). */
  enter(group: string, frameKey: string): void {
    const g = this.group(group);
    g.live.set(frameKey, (g.live.get(frameKey) ?? 0) + 1);
    g.keys.add(frameKey);
    if (g.live.size > g.peak) g.peak = g.live.size;
  }

  /** A character of group stops showing rameKey (frame change, hidden, culled or removed). */
  leave(group: string, frameKey: string): void {
    const g = this.groups.get(group);
    if (!g) return;
    const n = (g.live.get(frameKey) ?? 0) - 1;
    if (n > 0) g.live.set(frameKey, n);
    else g.live.delete(frameKey);
  }

  /** Latest GPU-pressure reading (see pressure.ts). */
  setPressure(pressure: boolean): void {
    this.pressure = pressure;
  }

  /** Outcome of a cache lookup for a character of a cached group. */
  recordLookup(group: string, hit: boolean): void {
    const g = this.groups.get(group);
    if (!g) return;
    g.lookups++;
    if (hit) g.hits++;
  }

  isCached(group: string): boolean {
    return this.groups.get(group)?.cached === true;
  }

  /** Call once per frame after all observations; evaluates and switches modes at window boundaries. */
  endFrame(): PlannerDecision[] {
    if (this.frame - this.windowStart < this.options.windowFrames) return [];
    const o = this.options;
    const decisions: PlannerDecision[] = [];
    const settled = (g: Group): boolean => this.frame - g.since >= o.minResidenceFrames;
    for (const [key, g] of this.groups) {
      if (g.lastSeen < this.windowStart && g.live.size === 0) {
        this.groups.delete(key); // gone from view for a whole window: forget it, free its capacity
        continue;
      }
      g.distinct = g.peak;
      if (g.cached && settled(g) && g.lookups >= o.minRequests && g.hits / g.lookups < o.demoteHitRatio) {
        g.cached = false;
        g.since = this.frame;
        this.demotions++;
        decisions.push({ group: key, to: 'SHADER', reason: `hit ratio ${(g.hits / g.lookups).toFixed(2)} < ${o.demoteHitRatio}` });
      }
    }
    let used = 0;
    for (const g of this.groups.values()) if (g.cached) used += g.distinct;
    const limit = Math.floor(o.capacityCells * o.capacityShare);
    const mayPromote = this.pressure || !o.requirePressure;
    const candidates = [...this.groups.entries()]
      .filter(([, g]) => mayPromote && !g.cached && settled(g) && g.requests >= o.minRequests && 1 - g.keys.size / g.requests >= o.promoteHitRatio)
      .sort((a, b) => b[1].requests - a[1].requests || (a[0] < b[0] ? -1 : 1));
    for (const [key, g] of candidates) {
      if (used + g.distinct > limit) continue;
      g.cached = true;
      g.since = this.frame;
      used += g.distinct;
      this.promotions++;
      decisions.push({ group: key, to: 'FULL_CACHE', reason: `potential hit ratio ${(1 - g.keys.size / g.requests).toFixed(2)}, ${g.distinct} frames at once` });
    }
    this.capacityUsed = used;
    for (const g of this.groups.values()) {
      g.requests = 0;
      // Frames still on screen carry over into the next window (they keep being requested).
      g.keys = new Set(g.live.keys());
      g.peak = g.live.size;
      g.lookups = 0;
      g.hits = 0;
    }
    this.windowStart = this.frame;
    return decisions;
  }

  /** Context loss etc.: everything back to SHADER (caches are empty), decisions start over. */
  reset(): void {
    this.groups.clear();
    this.capacityUsed = 0;
    this.windowStart = this.frame;
  }

  stats(): PlannerStats {
    let cachedGroups = 0;
    if (this.promotions > this.demotions) for (const g of this.groups.values()) if (g.cached) cachedGroups++; // nothing cached => no walk
    return {
      groups: this.groups.size,
      cachedGroups,
      promotions: this.promotions,
      demotions: this.demotions,
      capacityUsed: this.capacityUsed,
      capacityLimit: Math.floor(this.options.capacityCells * this.options.capacityShare),
      pressure: this.pressure,
    };
  }
}
