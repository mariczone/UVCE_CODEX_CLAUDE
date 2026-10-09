/**
 * Milestone 4: a deterministic synthetic "server" for appearance streaming tests and benchmarks. No sockets: events
 * are queued with a simulated latency and handed out by `deliver(nowMs)`.
 *
 * - Deltas (`appearance.changed`) travel on an unreliable channel: random latency (so they reorder), duplicates and
 *   losses at configurable rates.
 * - Snapshots (join, resync answer) travel on a reliable channel: latency only.
 * - Every joined player's current revision is broadcast every `heartbeatMs` (unreliable, like a state update),
 *   which lets a client notice that the newest delta was lost.
 * - Each player changes one random slot on average every `changeEveryMs`; revisions are monotonic per player.
 * The server state (`truth`) is the reference a client must converge to.
 */
import { createPrng } from '../core/prng.ts';
import type { AppearanceEvent } from '../net/appearance-stream.ts';
import type { AppearanceDefinition } from '../schema/appearance.ts';

export interface SyntheticNetworkOptions {
  seed: number;
  manifestVersion: string;
  /** Candidate item ids per slot; null = the slot may be emptied. */
  slotPool: Record<string, (string | null)[]>;
  latencyMs: [number, number];
  duplicateRate: number;
  lossRate: number;
  /** Mean interval between appearance changes of one player (ms); 0 = players never change. */
  changeEveryMs: number;
  /** Revision heartbeat period per joined player (ms); 0 = none. */
  heartbeatMs: number;
}

interface Player {
  revision: number;
  appearance: AppearanceDefinition;
  nextChangeMs: number;
  nextHeartbeatMs: number;
  joined: boolean;
}

interface InFlight {
  at: number;
  seq: number;
  event: AppearanceEvent;
}

export class SyntheticAppearanceServer {
  private readonly players = new Map<string, Player>();
  private readonly queue: InFlight[] = [];
  private readonly rng: ReturnType<typeof createPrng>;
  private seq = 0;
  private changesPaused = false;
  readonly options: SyntheticNetworkOptions;
  readonly counters = { deltas: 0, snapshots: 0, duplicated: 0, lost: 0 };

  constructor(options: SyntheticNetworkOptions) {
    this.options = options;
    this.rng = createPrng(options.seed >>> 0);
  }

  /** Registers a player (not yet visible to the client). */
  addPlayer(entityId: string, appearance: AppearanceDefinition, nowMs: number): void {
    this.players.set(entityId, { revision: 1, appearance, nextChangeMs: nowMs + this.nextInterval(), nextHeartbeatMs: nowMs, joined: false });
  }

  /** The player enters this client's interest: a snapshot is sent (reliable). */
  join(entityId: string, nowMs: number): void {
    const p = this.players.get(entityId);
    if (!p) throw new Error(`unknown player ${entityId}`);
    p.joined = true;
    this.sendSnapshot(entityId, p, nowMs);
  }

  leave(entityId: string, nowMs: number): void {
    const p = this.players.get(entityId);
    if (!p) return;
    p.joined = false;
    this.send({ type: 'entity.left', entityId }, nowMs, this.latency());
  }

  /** Client asked for a resync (lost delta). */
  requestSnapshot(entityId: string, nowMs: number): void {
    const p = this.players.get(entityId);
    if (p?.joined) this.sendSnapshot(entityId, p, nowMs);
  }

  /** Advances the simulation: players whose change time has come change one slot and broadcast the delta. */
  step(nowMs: number): void {
    if (this.options.heartbeatMs > 0) {
      for (const [entityId, p] of this.players) {
        if (!p.joined || p.nextHeartbeatMs > nowMs) continue;
        p.nextHeartbeatMs = nowMs + this.options.heartbeatMs;
        if (this.rng.next() < this.options.lossRate) continue;
        this.send({ type: 'appearance.revision', entityId, appearanceRevision: p.revision }, nowMs, this.latency());
      }
    }
    if (this.options.changeEveryMs <= 0 || this.changesPaused) return;
    const slots = Object.keys(this.options.slotPool).sort();
    for (const [entityId, p] of this.players) {
      while (p.nextChangeMs <= nowMs) {
        const slot = this.rng.pick(slots);
        const itemId = this.rng.pick(this.options.slotPool[slot] as (string | null)[]);
        const nextSlots = { ...p.appearance.slots };
        if (itemId === null) delete nextSlots[slot];
        else nextSlots[slot] = { itemId };
        p.appearance = { ...p.appearance, slots: nextSlots };
        p.revision++;
        const at = p.nextChangeMs;
        p.nextChangeMs += this.nextInterval();
        if (!p.joined) continue; // out of interest: the next snapshot carries it
        this.counters.deltas++;
        const event: AppearanceEvent = { type: 'appearance.changed', entityId, appearanceRevision: p.revision, changes: { [slot]: itemId }, assetManifestVersion: this.options.manifestVersion };
        if (this.rng.next() < this.options.lossRate) {
          this.counters.lost++;
          continue;
        }
        this.send(event, at, this.latency());
        if (this.rng.next() < this.options.duplicateRate) {
          this.counters.duplicated++;
          this.send(event, at, this.latency());
        }
      }
    }
  }

  /** Stops appearance changes (heartbeats and resync answers continue), e.g. to let a link drain in tests. */
  pauseChanges(): void {
    this.changesPaused = true;
  }

  /** Events whose delivery time has come, in arrival order. */
  deliver(nowMs: number): AppearanceEvent[] {
    this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
    let n = 0;
    while (n < this.queue.length && (this.queue[n] as InFlight).at <= nowMs) n++;
    return this.queue.splice(0, n).map((f) => f.event);
  }

  truth(entityId: string): { revision: number; appearance: AppearanceDefinition } | undefined {
    const p = this.players.get(entityId);
    return p ? { revision: p.revision, appearance: p.appearance } : undefined;
  }

  get inFlight(): number {
    return this.queue.length;
  }

  private sendSnapshot(entityId: string, p: Player, nowMs: number): void {
    this.counters.snapshots++;
    this.send({ type: 'appearance.snapshot', entityId, appearanceRevision: p.revision, appearance: p.appearance, assetManifestVersion: this.options.manifestVersion }, nowMs, this.latency());
  }

  private send(event: AppearanceEvent, nowMs: number, latency: number): void {
    this.queue.push({ at: nowMs + latency, seq: this.seq++, event });
  }

  private latency(): number {
    const [lo, hi] = this.options.latencyMs;
    return this.rng.range(lo, hi);
  }

  private nextInterval(): number {
    const mean = this.options.changeEveryMs;
    return mean <= 0 ? Number.POSITIVE_INFINITY : mean * (0.5 + this.rng.next());
  }
}
