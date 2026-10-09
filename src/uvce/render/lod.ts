/**
 * Milestone 4: projected-size LOD and the visual animation budget. Pure, renderer-independent.
 *
 * Only the VISUAL pose is affected: a small character samples its clip clock at a lower rate (e.g. 8–12 Hz) while the
 * world still renders every frame; positions, facing and the simulation are untouched (blueprint §10).
 *
 * Projected height = on-screen height in CSS px of the rig canvas (256 sprite px = 2 world units), not of the drawn
 * body; with the 256 px canvas, "HIGH" means at least ~0.6 screen px per sprite px.
 */

export type LodName = 'HIGH' | 'MEDIUM' | 'LOW' | 'TINY';

export interface LodLevel {
  name: LodName;
  /** The level applies while the projected canvas height is >= this (px). */
  minHeightPx: number;
  /** Visual animation rate; null = sample the clip every frame. */
  animationHz: number | null;
}

export interface LodPolicy {
  /** Finest first; the last level must have minHeightPx 0. */
  levels: readonly LodLevel[];
  /** Relative band around each threshold: finer needs h >= t·(1+hysteresis), coarser needs h < t·(1−hysteresis). */
  hysteresis: number;
}

/** Blueprint §10 example policy (tunable). MEDIUM keeps full-rate animation; texture detail comes from mipmaps. */
export const DEFAULT_LOD_POLICY: LodPolicy = {
  levels: [
    { name: 'HIGH', minHeightPx: 150, animationHz: null },
    { name: 'MEDIUM', minHeightPx: 80, animationHz: null },
    { name: 'LOW', minHeightPx: 30, animationHz: 12 },
    { name: 'TINY', minHeightPx: 0, animationHz: 8 },
  ],
  hysteresis: 0.1,
};

/**
 * Level index for a projected height, starting from the previous level (-1 = none yet: no hysteresis). A character
 * hovering around a threshold keeps its level until it leaves the band, so LOD never flickers frame to frame.
 */
export function lodLevelFor(heightPx: number, previous: number, policy: LodPolicy = DEFAULT_LOD_POLICY): number {
  const { levels, hysteresis } = policy;
  const n = levels.length;
  if (previous < 0 || previous >= n) {
    for (let i = 0; i < n; i++) if (heightPx >= (levels[i] as LodLevel).minHeightPx) return i;
    return n - 1;
  }
  let up = previous;
  while (up > 0 && heightPx >= (levels[up - 1] as LodLevel).minHeightPx * (1 + hysteresis)) up--;
  if (up < previous) return up;
  let down = previous;
  while (down < n - 1 && heightPx < (levels[down] as LodLevel).minHeightPx * (1 - hysteresis)) down++;
  return down;
}

/**
 * The clip-clock time a throttled character shows: the clock sampled at `hz`, held between samples. `phaseMs`
 * staggers characters so their updates spread over frames instead of all landing on one. The shown time lags the
 * clock by less than one period and never runs backwards, so frames advance in order (no skips beyond what the lower
 * rate implies) and switching LOD at most shortens or lengthens one hold.
 */
export function throttledTimeMs(nowMs: number, hz: number | null, phaseMs: number): number {
  if (hz === null || hz <= 0) return nowMs;
  const period = 1000 / hz;
  return Math.floor((nowMs + phaseMs) / period) * period - phaseMs;
}

/** Stable per-entity stagger in [0, 1000) ms (FNV-1a of the id): the same entity always gets the same phase. */
export function lodPhaseMs(entityId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < entityId.length; i++) {
    h ^= entityId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 1000;
}

/**
 * Adaptive visual animation budget: at most `maxPerFrame` animation-only pose updates per frame for characters below
 * the finest level. A deferred character keeps its current frame; after `maxDeferFrames` consecutive deferrals it
 * updates regardless, so nothing freezes. Updates caused by appearance, direction or residency changes never count
 * (they are correctness, not animation smoothness).
 */
export class AnimationBudget {
  private used = 0;
  deferred = 0;
  readonly maxPerFrame: number;
  readonly maxDeferFrames: number;
  constructor(maxPerFrame: number, maxDeferFrames = 3) {
    this.maxPerFrame = maxPerFrame;
    this.maxDeferFrames = maxDeferFrames;
  }

  beginFrame(): void {
    this.used = 0;
    this.deferred = 0;
  }

  /** True = update now; false = defer (caller increments its own deferral count). */
  admit(deferredFrames: number): boolean {
    if (deferredFrames >= this.maxDeferFrames || this.used < this.maxPerFrame) {
      this.used++;
      return true;
    }
    this.deferred++;
    return false;
  }
}
