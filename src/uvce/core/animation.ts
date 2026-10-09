/**
 * Clip timelines are pure timing data, independent of artwork: a clip says how long each logical frame lasts.
 * Every layer of a character samples the SAME clip time (one authoritative clock per character), so layers
 * cannot drift apart; equipment follows sockets of the sampled body frame.
 */
export interface ClipEvent {
  name: string;
  timeMs: number;
}

export interface ClipTimeline {
  id: string;
  version: string;
  loop: boolean;
  /** Duration of each logical frame in ms (positive integers). Frame counts may differ between clips. */
  frameDurationsMs: readonly number[];
  events?: readonly ClipEvent[];
}

export interface ClipSample {
  frameIndex: number;
  /** Time inside the clip, in [0, duration) for looping clips and [0, duration] for one-shot clips. */
  clipTimeMs: number;
  /** Completed loop count (floor), negative when sampling before the clip start. 0 for one-shot clips. */
  loopCount: number;
  /** One-shot clip reached its end and holds the last frame. */
  finished: boolean;
}

export function clipDurationMs(clip: ClipTimeline): number {
  let total = 0;
  for (const d of clip.frameDurationsMs) total += d;
  return total;
}

function frameAt(clip: ClipTimeline, t: number): number {
  let acc = 0;
  const last = clip.frameDurationsMs.length - 1;
  for (let i = 0; i < last; i++) {
    acc += clip.frameDurationsMs[i] as number;
    if (t < acc) return i;
  }
  return last;
}

/** Frame i covers [start_i, start_i + duration_i). Looping clips wrap (also for negative time). */
export function sampleClip(clip: ClipTimeline, timeMs: number): ClipSample {
  if (!Number.isFinite(timeMs)) throw new RangeError(`clip time must be finite, got ${timeMs}`);
  const duration = clipDurationMs(clip);
  if (clip.frameDurationsMs.length === 0 || duration <= 0) throw new RangeError(`clip ${clip.id} has no duration`);
  if (clip.loop) {
    const loopCount = Math.floor(timeMs / duration);
    let t = timeMs - loopCount * duration;
    if (t >= duration) t -= duration; // guard floating rounding
    if (t < 0) t = 0;
    return { frameIndex: frameAt(clip, t), clipTimeMs: t, loopCount, finished: false };
  }
  if (timeMs <= 0) return { frameIndex: 0, clipTimeMs: 0, loopCount: 0, finished: false };
  if (timeMs >= duration) {
    return { frameIndex: clip.frameDurationsMs.length - 1, clipTimeMs: duration, loopCount: 0, finished: true };
  }
  return { frameIndex: frameAt(clip, timeMs), clipTimeMs: timeMs, loopCount: 0, finished: false };
}

export function frameStartMs(clip: ClipTimeline, frameIndex: number): number {
  let acc = 0;
  for (let i = 0; i < frameIndex; i++) acc += clip.frameDurationsMs[i] ?? 0;
  return acc;
}

/**
 * Events crossed when the (unwrapped) clip time advances from `fromMs` (exclusive) to `toMs` (inclusive).
 * Loop boundaries are handled, so an event at 0 ms fires once per completed loop.
 */
export function collectClipEvents(clip: ClipTimeline, fromMs: number, toMs: number): ClipEvent[] {
  const out: ClipEvent[] = [];
  const events = clip.events ?? [];
  if (events.length === 0 || toMs <= fromMs) return out;
  const duration = clipDurationMs(clip);
  if (!clip.loop) {
    for (const e of events) if (e.timeMs > fromMs && e.timeMs <= toMs) out.push(e);
    return out;
  }
  const firstLoop = Math.floor(fromMs / duration);
  const lastLoop = Math.floor(toMs / duration);
  for (let loop = firstLoop; loop <= lastLoop; loop++) {
    for (const e of events) {
      const t = loop * duration + e.timeMs;
      if (t > fromMs && t <= toMs) out.push(e);
    }
  }
  return out;
}

/**
 * Per-character animation clock. Clip time = (now - clipStart) * speed + phaseOffset.
 * Switching clip restarts at frame 0 (no inherited time drift); identical inputs give identical frames.
 */
export interface AnimationState {
  clipId: string;
  clipStartMs: number;
  speed: number;
  phaseOffsetMs: number;
}

export function clipTimeAt(state: AnimationState, nowMs: number): number {
  return (nowMs - state.clipStartMs) * state.speed + state.phaseOffsetMs;
}

export function switchClip(state: AnimationState, clipId: string, nowMs: number): AnimationState {
  if (state.clipId === clipId) return state;
  return { clipId, clipStartMs: nowMs, speed: state.speed, phaseOffsetMs: 0 };
}
