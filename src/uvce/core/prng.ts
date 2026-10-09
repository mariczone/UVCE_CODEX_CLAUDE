/**
 * Small seeded PRNG (mulberry32) for reproducible fixtures, crowd placement and appearance selection.
 * Not cryptographic. Same seed => same sequence on every JS engine (32-bit integer arithmetic only).
 */
export interface Prng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
}

export function seedFromString(text: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function createPrng(seed: number): Prng {
  let state = seed >>> 0;
  const nextUint = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const next = (): number => nextUint() / 4294967296;
  return {
    next,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError(`bad int range ${min}..${max}`);
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('pick from empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    range(min, max) {
      return min + next() * (max - min);
    },
  };
}
