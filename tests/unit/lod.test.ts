import { describe, expect, it } from 'vitest';
import { AnimationBudget, DEFAULT_LOD_POLICY, lodLevelFor, lodPhaseMs, throttledTimeMs } from '../../src/uvce/render/lod.ts';

describe('projected-size LOD levels', () => {
  it('maps heights to the blueprint example thresholds on first assessment', () => {
    expect([400, 150, 149, 80, 79, 30, 29, 0].map((h) => DEFAULT_LOD_POLICY.levels[lodLevelFor(h, -1)]?.name)).toEqual(['HIGH', 'HIGH', 'MEDIUM', 'MEDIUM', 'LOW', 'LOW', 'TINY', 'TINY']);
  });

  it('hysteresis: hovering around a threshold never flickers, leaving the band switches once', () => {
    let level = lodLevelFor(160, -1); // HIGH
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      level = lodLevelFor(150 + 10 * Math.sin(i), level); // 140..160, inside the ±10 % band of 150
      seen.add(level);
    }
    expect([...seen]).toEqual([0]);
    level = lodLevelFor(130, level); // below 150·0.9 = 135
    expect(level).toBe(1);
    for (let i = 0; i < 200; i++) level = lodLevelFor(150 + 10 * Math.sin(i), level);
    expect(level).toBe(1); // coming back needs >= 165
    expect(lodLevelFor(166, level)).toBe(0);
  });

  it('jumps several levels at once when the size changes a lot', () => {
    expect(lodLevelFor(10, 0)).toBe(3);
    expect(lodLevelFor(500, 3)).toBe(0);
  });
});

describe('throttled visual animation clock', () => {
  it('holds between samples, lags by less than one period and never runs backwards', () => {
    const phase = lodPhaseMs('npc-0042');
    let prev = -Infinity;
    for (let now = 0; now < 5000; now += 7) {
      const t = throttledTimeMs(now, 8, phase);
      expect(t).toBeLessThanOrEqual(now);
      expect(now - t).toBeLessThan(125);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    expect(throttledTimeMs(1234, null, phase)).toBe(1234);
  });

  it('staggers entities: phases are stable per id and spread out', () => {
    expect(lodPhaseMs('npc-1')).toBe(lodPhaseMs('npc-1'));
    const phases = new Set(Array.from({ length: 100 }, (_, i) => Math.floor(lodPhaseMs(`npc-${i}`) / 125)));
    expect(phases.size).toBe(8); // all 8 slots of an 8 Hz period are used
  });
});

describe('animation budget', () => {
  it('admits up to the budget per frame, then defers; a character deferred maxDeferFrames times goes through', () => {
    const b = new AnimationBudget(2, 3);
    b.beginFrame();
    expect([b.admit(0), b.admit(0), b.admit(0), b.admit(2), b.admit(3)]).toEqual([true, true, false, false, true]);
    expect(b.deferred).toBe(2);
    b.beginFrame();
    expect(b.deferred).toBe(0);
    expect(b.admit(0)).toBe(true);
  });
});
