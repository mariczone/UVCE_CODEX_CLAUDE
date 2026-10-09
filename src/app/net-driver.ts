/**
 * Milestone 4 multiplayer-style streaming in the app (net=1): NPC appearances come from a synthetic server through
 * the AppearanceStream instead of being set locally.
 *
 * - Players arrive one after another (`arrivalMs`). Arriving = entering this client's interest radius: the server
 *   sends a snapshot. The player becomes visible `leadMs` later (walking into view), so the client has that long to
 *   prefetch the player's items (deduplicated by the registry; resident items cost nothing).
 * - Afterwards each player changes equipment now and then (lossy, reordering link; heartbeats + resync repair it).
 * - Pop-in metric: characters whose first visible frame still had layers loading. With enough lead this stays 0.
 */
import type { SourceAssetRegistry } from '../uvce/assets/source-registry.ts';
import { SyntheticAppearanceServer } from '../uvce/bench/synthetic-network.ts';
import { AppearanceStream, type AppearanceStreamStats } from '../uvce/net/appearance-stream.ts';
import type { CharacterInstance } from '../uvce/render/contracts.ts';
import type { ManifestIndex } from '../uvce/schema/compiled-manifest.ts';

export interface NetDriverOptions {
  arrivalMs: number;
  leadMs: number;
  lossRate: number;
  changeEveryMs: number;
  seed: number;
}

export interface NetDriverStats extends AppearanceStreamStats {
  arrived: number;
  visible: number;
  prefetchRequests: number;
  popIns: number;
  lost: number;
}

/** Equipment the synthetic players switch between: every manifest item of the optional slots (hat/weapon may be empty). */
function slotPool(index: ManifestIndex): Record<string, (string | null)[]> {
  const pool: Record<string, (string | null)[]> = {};
  for (const slot of ['hair', 'hat', 'armor', 'weapon']) {
    const ids = [...(index.itemsBySlot.get(slot) ?? [])].map((it) => it.id).sort();
    if (ids.length > 0) pool[slot] = slot === 'hat' || slot === 'weapon' ? [...ids, null] : ids;
  }
  return pool;
}

interface Pending {
  instance: CharacterInstance;
  joinAtMs: number;
  visibleAtMs: number;
  joined: boolean;
  hasSnapshot: boolean;
  shown: boolean;
}

export class NetCrowdDriver {
  readonly server: SyntheticAppearanceServer;
  readonly stream: AppearanceStream;
  private readonly players = new Map<string, Pending>();
  private readonly registry: Pick<SourceAssetRegistry<unknown, unknown>, 'prefetchItem'>;
  private now = 0;
  private prefetchRequests = 0;
  private popIns = 0;
  private arrived = 0;
  /** Entities that became visible this frame; checked for pop-in after the renderer prepared them. */
  private justShown: string[] = [];

  /** `instances[1..]` are driven by the network (index 0 is the local hero); `startMs` = sim time of arrival 0. */
  constructor(index: ManifestIndex, registry: Pick<SourceAssetRegistry<unknown, unknown>, 'prefetchItem'>, instances: CharacterInstance[], startMs: number, options: NetDriverOptions) {
    this.registry = registry;
    this.now = startMs;
    this.server = new SyntheticAppearanceServer({
      seed: options.seed,
      manifestVersion: index.manifest.manifestVersion,
      slotPool: slotPool(index),
      latencyMs: [30, 150],
      duplicateRate: 0.05,
      lossRate: options.lossRate,
      changeEveryMs: options.changeEveryMs,
      heartbeatMs: 500,
    });
    this.stream = new AppearanceStream(index, {
      gapTimeoutMs: 400,
      onResync: (id) => this.server.requestSnapshot(id, this.now),
      onChange: (id, entity) => {
        const p = this.players.get(id);
        if (!p) return;
        p.instance.appearance = entity.appearance;
        p.hasSnapshot = true;
        if (!p.shown) {
          for (const item of entity.items) this.registry.prefetchItem(item);
          this.prefetchRequests++;
        }
      },
    });
    instances.slice(1).forEach((inst, i) => {
      inst.visible = false;
      this.server.addPlayer(inst.entityId, inst.appearance, startMs);
      const joinAtMs = startMs + i * options.arrivalMs;
      this.players.set(inst.entityId, { instance: inst, joinAtMs, visibleAtMs: joinAtMs + options.leadMs, joined: false, hasSnapshot: false, shown: false });
    });
  }

  /** Before the renderer's prepareFrame: advance the simulated network to `nowMs`. */
  update(nowMs: number): void {
    this.now = nowMs;
    this.justShown = [];
    for (const [id, p] of this.players) {
      if (!p.joined && nowMs >= p.joinAtMs) {
        p.joined = true;
        this.arrived++;
        this.server.join(id, nowMs);
      }
    }
    this.server.step(nowMs);
    for (const e of this.server.deliver(nowMs)) this.stream.apply(e, nowMs);
    this.stream.update(nowMs);
    for (const [id, p] of this.players) {
      if (!p.shown && p.hasSnapshot && nowMs >= p.visibleAtMs) {
        p.shown = true;
        p.instance.visible = true;
        this.justShown.push(id);
      }
    }
  }

  /** After prepareFrame: count characters that appeared with layers still loading. */
  afterPrepare(pendingLayersOf: (entityId: string) => number): void {
    for (const id of this.justShown) if (pendingLayersOf(id) > 0) this.popIns++;
  }

  stats(): NetDriverStats {
    let visible = 0;
    for (const p of this.players.values()) if (p.shown) visible++;
    return { ...this.stream.stats(), arrived: this.arrived, visible, prefetchRequests: this.prefetchRequests, popIns: this.popIns, lost: this.server.counters.lost };
  }
}
