import { describe, expect, it } from 'vitest';
import { type ClipTimeline, clipDurationMs, clipTimeAt, collectClipEvents, frameStartMs, sampleClip, switchClip } from '../../src/uvce/core/animation.ts';

const uneven: ClipTimeline = { id: 'idle', version: '1', loop: true, frameDurationsMs: [180, 120, 120, 180] };
const once: ClipTimeline = { id: 'attack', version: '1', loop: false, frameDurationsMs: [100, 50, 150] };
const walk: ClipTimeline = { id: 'walk', version: '1', loop: true, frameDurationsMs: [100, 100, 100, 100], events: [{ name: 'step', timeMs: 0 }, { name: 'step', timeMs: 200 }] };

describe('clip timing', () => {
  it('computes durations and frame starts', () => {
    expect(clipDurationMs(uneven)).toBe(600);
    expect(frameStartMs(uneven, 2)).toBe(300);
  });

  it('frame i covers [start, start + duration) with uneven durations', () => {
    const at = (t: number): number => sampleClip(uneven, t).frameIndex;
    expect(at(0)).toBe(0);
    expect(at(179.999)).toBe(0);
    expect(at(180)).toBe(1);
    expect(at(299.9)).toBe(1);
    expect(at(300)).toBe(2);
    expect(at(420)).toBe(3);
    expect(at(599.999)).toBe(3);
  });

  it('wraps looping clips forward and backward', () => {
    expect(sampleClip(uneven, 600)).toMatchObject({ frameIndex: 0, clipTimeMs: 0, loopCount: 1 });
    expect(sampleClip(uneven, 1380)).toMatchObject({ frameIndex: 1, loopCount: 2 });
    expect(sampleClip(uneven, -1)).toMatchObject({ frameIndex: 3, loopCount: -1 });
    expect(sampleClip(uneven, -600).frameIndex).toBe(0);
  });

  it('holds the last frame of one-shot clips and clamps negative time', () => {
    expect(sampleClip(once, -50)).toMatchObject({ frameIndex: 0, finished: false });
    expect(sampleClip(once, 120).frameIndex).toBe(1);
    expect(sampleClip(once, 300)).toMatchObject({ frameIndex: 2, finished: true, clipTimeMs: 300 });
    expect(sampleClip(once, 10_000)).toMatchObject({ frameIndex: 2, finished: true });
  });

  it('rejects non-finite time and empty clips', () => {
    expect(() => sampleClip(uneven, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => sampleClip({ ...uneven, frameDurationsMs: [] }, 0)).toThrow(RangeError);
  });

  it('applies speed and per-character phase offset to one authoritative clock', () => {
    const state = { clipId: 'walk', clipStartMs: 1000, speed: 2, phaseOffsetMs: 50 };
    expect(clipTimeAt(state, 1100)).toBe(250);
    expect(sampleClip(walk, clipTimeAt(state, 1100)).frameIndex).toBe(2);
    expect(clipTimeAt({ ...state, speed: 0 }, 99_999)).toBe(50);
  });

  it('two characters with different phase offsets resolve to different frames of the same clip', () => {
    const a = { clipId: 'walk', clipStartMs: 0, speed: 1, phaseOffsetMs: 0 };
    const b = { ...a, phaseOffsetMs: 250 };
    expect(sampleClip(walk, clipTimeAt(a, 0)).frameIndex).toBe(0);
    expect(sampleClip(walk, clipTimeAt(b, 0)).frameIndex).toBe(2);
  });

  it('switching clips restarts at frame 0 with no inherited drift; same clip is a no-op', () => {
    const walking = { clipId: 'walk', clipStartMs: 0, speed: 1, phaseOffsetMs: 37 };
    const idle = switchClip(walking, 'idle', 5_123);
    expect(idle).toEqual({ clipId: 'idle', clipStartMs: 5_123, speed: 1, phaseOffsetMs: 0 });
    expect(sampleClip(uneven, clipTimeAt(idle, 5_123)).frameIndex).toBe(0);
    expect(switchClip(idle, 'idle', 9_999)).toBe(idle);
  });

  it('collects events across loop boundaries exactly once per crossing', () => {
    expect(collectClipEvents(walk, -1, 0).map((e) => e.timeMs)).toEqual([0]);
    expect(collectClipEvents(walk, 0, 400).map((e) => e.timeMs)).toEqual([200, 0]);
    expect(collectClipEvents(walk, 150, 950)).toHaveLength(4);
    expect(collectClipEvents(walk, 300, 300)).toEqual([]);
  });
});
