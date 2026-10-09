import { describe, expect, it } from 'vitest';
import { HERO_ID, generateCrowd, patrolPose } from '../../src/uvce/bench/crowd.ts';
import { percentile, summarize } from '../../src/uvce/bench/frame-stats.ts';
import { resolveAppearance } from '../../src/uvce/core/appearance-resolver.ts';
import { appearanceKey } from '../../src/uvce/core/cache-keys.ts';
import { compiledAssets } from './helpers.ts';

describe('deterministic crowd fixture', () => {
  it('is a pure function of seed and index; members are stable as the crowd grows', async () => {
    const { index } = await compiledAssets();
    const a = generateCrowd(index, { count: 100, seed: 42 });
    const b = generateCrowd(index, { count: 100, seed: 42 });
    expect(a).toEqual(b);
    const small = generateCrowd(index, { count: 20, seed: 42 });
    expect(small).toEqual(a.slice(0, 20));
    const other = generateCrowd(index, { count: 100, seed: 43 });
    expect(other.slice(1)).not.toEqual(a.slice(1));
    expect(a[0]?.entityId).toBe(HERO_ID);
    expect(new Set(a.map((m) => m.entityId)).size).toBe(100);
    expect(generateCrowd(index, { count: 0, seed: 1 })).toEqual([]);
  });

  it('places characters without exact overlaps and with resolvable, varied appearances', async () => {
    const { index } = await compiledAssets();
    const crowd = generateCrowd(index, { count: 300, seed: 7 });
    let minD = Infinity;
    for (let i = 0; i < crowd.length; i++)
      for (let j = i + 1; j < crowd.length; j++) {
        const p = crowd[i];
        const q = crowd[j];
        if (p && q) minD = Math.min(minD, Math.hypot(p.x - q.x, p.z - q.z));
      }
    expect(minD).toBeGreaterThan(0.3);
    const keys = new Set<string>();
    for (const m of crowd) {
      const r = resolveAppearance(index, m.appearance);
      expect(r.ok && r.value.issues).toEqual([]);
      if (r.ok) keys.add(appearanceKey(r.value));
    }
    expect(keys.size).toBeGreaterThan(100); // many unique looks, without any per-combination sheet
    expect(crowd.some((m) => m.clipId === 'walk') && crowd.some((m) => m.clipId === 'idle')).toBe(true);
  });

  it('patrol motion is a pure function of time (deterministic replay)', async () => {
    const { index } = await compiledAssets();
    const walker = generateCrowd(index, { count: 50, seed: 3 }).find((m) => m.patrol);
    if (!walker?.patrol) throw new Error('no walker');
    expect(patrolPose(walker, 12_345)).toEqual(patrolPose(walker, 12_345));
    const period = ((2 * walker.patrol.length) / walker.patrol.speed) * 1000;
    const p0 = patrolPose(walker, 1000);
    const p1 = patrolPose(walker, 1000 + period);
    expect(p1.x).toBeCloseTo(p0.x, 9);
    expect(p1.z).toBeCloseTo(p0.z, 9);
  });
});

describe('frame statistics', () => {
  it('uses nearest-rank percentiles', () => {
    const v = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile([], 50)).toBeNaN();
    expect(summarize([2, 4])).toMatchObject({ samples: 2, mean: 3, max: 4 });
  });
});
