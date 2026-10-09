/**
 * Milestone 4: client side of multiplayer appearance streaming (blueprint §11). The server sends ids and revisions,
 * never images:
 *
 *   appearance.snapshot  full look of an entity at a revision (on entering interest, or answering a resync)
 *   appearance.changed   slot delta at revision r (applies only on top of r − 1)
 *   appearance.revision  heartbeat: the entity's current revision (piggybacks on state updates; unreliable)
 *   entity.left          the entity left this client's interest
 *
 * Rules:
 * - Revisions are monotonic per entity. A delta at or below the current revision is stale or a duplicate and is
 *   dropped. A delta from the future is held until the gap fills; a gap that stays open for `gapTimeoutMs` (a lost
 *   packet) asks the server for a snapshot instead of guessing (deltas are partial: skipping one could leave a slot
 *   wrong forever). A snapshot newer than the current state replaces it and drops held deltas it covers.
 * - Losing the LAST delta leaves no later delta to reveal the gap: the revision heartbeat does. A heartbeat ahead of
 *   the current revision opens a gap like a held delta would (resync after the timeout unless the delta arrives).
 * - Events for another asset-manifest version are rejected (the ids may mean other pixels).
 * - Every applied change produces a NEW AppearanceDefinition object (renderers detect changes by identity) and
 *   reports the entity's item dependencies, so the caller can prefetch what an entity about to appear will need.
 * Pure TS, no timers of its own: the caller passes the clock.
 */
import { resolveAppearance } from '../core/appearance-resolver.ts';
import type { AppearanceDefinition } from '../schema/appearance.ts';
import type { ManifestIndex } from '../schema/compiled-manifest.ts';

export interface AppearanceSnapshotEvent {
  type: 'appearance.snapshot';
  entityId: string;
  appearanceRevision: number;
  appearance: AppearanceDefinition;
  assetManifestVersion: string;
}

export interface AppearanceChangedEvent {
  type: 'appearance.changed';
  entityId: string;
  appearanceRevision: number;
  /** slot -> item id, or null to empty the slot. */
  changes: Record<string, string | null>;
  assetManifestVersion: string;
}

export interface EntityLeftEvent {
  type: 'entity.left';
  entityId: string;
}

export interface AppearanceRevisionEvent {
  type: 'appearance.revision';
  entityId: string;
  appearanceRevision: number;
}

export type AppearanceEvent = AppearanceSnapshotEvent | AppearanceChangedEvent | AppearanceRevisionEvent | EntityLeftEvent;

export type ApplyOutcome = 'applied' | 'held' | 'stale' | 'version-mismatch' | 'unknown-entity' | 'left' | 'behind' | 'current';

export interface StreamEntity {
  revision: number;
  appearance: AppearanceDefinition;
  /** Item ids the current appearance depends on (resolved through the manifest, aliases included). */
  items: readonly string[];
}

export interface AppearanceStreamStats {
  applied: number;
  held: number;
  stale: number;
  versionMismatches: number;
  unknownEntity: number;
  resyncRequests: number;
  entities: number;
}

export interface AppearanceStreamOptions {
  /** A held delta older than this (ms) means a lost packet: request a snapshot. */
  gapTimeoutMs: number;
  /** Called when an entity's appearance changed (new object) with its item dependencies. */
  onChange?: (entityId: string, entity: StreamEntity) => void;
  /** Called when the stream needs a fresh snapshot of an entity (gap timeout). */
  onResync?: (entityId: string) => void;
}

interface Held {
  event: AppearanceChangedEvent;
  sinceMs: number;
}

export class AppearanceStream {
  private readonly entities = new Map<string, StreamEntity>();
  private readonly held = new Map<string, Map<number, Held>>();
  private readonly resyncPending = new Set<string>();
  /** Heartbeat said the server is at a newer revision: entity -> (revision, first seen). */
  private readonly behind = new Map<string, { revision: number; sinceMs: number }>();
  private readonly counters = { applied: 0, held: 0, stale: 0, versionMismatches: 0, unknownEntity: 0, resyncRequests: 0 };
  private readonly index: ManifestIndex;
  private readonly options: AppearanceStreamOptions;

  constructor(index: ManifestIndex, options: Partial<AppearanceStreamOptions> = {}) {
    this.index = index;
    this.options = { gapTimeoutMs: 500, ...options };
  }

  get(entityId: string): StreamEntity | undefined {
    return this.entities.get(entityId);
  }

  entityIds(): string[] {
    return [...this.entities.keys()];
  }

  apply(event: AppearanceEvent, nowMs: number): ApplyOutcome {
    if (event.type === 'entity.left') {
      this.entities.delete(event.entityId);
      this.held.delete(event.entityId);
      this.resyncPending.delete(event.entityId);
      this.behind.delete(event.entityId);
      return 'left';
    }
    if (event.type === 'appearance.revision') {
      const known = this.entities.get(event.entityId);
      if (!known || event.appearanceRevision <= known.revision) return 'current';
      const b = this.behind.get(event.entityId);
      if (!b || b.revision < event.appearanceRevision) this.behind.set(event.entityId, { revision: event.appearanceRevision, sinceMs: b?.sinceMs ?? nowMs });
      return 'behind';
    }
    if (event.assetManifestVersion !== this.index.manifest.manifestVersion) {
      this.counters.versionMismatches++;
      return 'version-mismatch';
    }
    const current = this.entities.get(event.entityId);
    if (event.type === 'appearance.snapshot') {
      if (current && event.appearanceRevision <= current.revision) return this.stale();
      this.set(event.entityId, event.appearanceRevision, event.appearance);
      this.resyncPending.delete(event.entityId);
      this.drainHeld(event.entityId, nowMs);
      return 'applied';
    }
    if (!current) {
      // A delta for an entity we have no base for: it cannot be applied; the snapshot that must follow wins.
      this.counters.unknownEntity++;
      return 'unknown-entity';
    }
    if (event.appearanceRevision <= current.revision) return this.stale();
    if (event.appearanceRevision > current.revision + 1) {
      const byRev = this.held.get(event.entityId) ?? new Map<number, Held>();
      if (byRev.has(event.appearanceRevision)) return this.stale(); // duplicate of a held delta
      byRev.set(event.appearanceRevision, { event, sinceMs: nowMs });
      this.held.set(event.entityId, byRev);
      this.counters.held++;
      return 'held';
    }
    this.applyDelta(event.entityId, current, event);
    this.drainHeld(event.entityId, nowMs);
    return 'applied';
  }

  /** Clock tick: requests a snapshot for every entity whose oldest held delta waited longer than the timeout. */
  update(nowMs: number): void {
    for (const [entityId, b] of this.behind) {
      const known = this.entities.get(entityId);
      if (!known || known.revision >= b.revision) {
        this.behind.delete(entityId);
        continue;
      }
      if (!this.resyncPending.has(entityId) && nowMs - b.sinceMs >= this.options.gapTimeoutMs) this.requestResync(entityId);
    }
    for (const [entityId, byRev] of this.held) {
      if (this.resyncPending.has(entityId)) continue;
      for (const h of byRev.values()) {
        if (nowMs - h.sinceMs >= this.options.gapTimeoutMs) {
          this.requestResync(entityId);
          break;
        }
      }
    }
  }

  stats(): AppearanceStreamStats {
    return { ...this.counters, entities: this.entities.size };
  }

  private requestResync(entityId: string): void {
    this.resyncPending.add(entityId);
    this.counters.resyncRequests++;
    this.options.onResync?.(entityId);
  }

  private stale(): ApplyOutcome {
    this.counters.stale++;
    return 'stale';
  }

  private applyDelta(entityId: string, current: StreamEntity, event: AppearanceChangedEvent): void {
    const slots = { ...current.appearance.slots };
    for (const [slot, itemId] of Object.entries(event.changes)) {
      if (itemId === null) delete slots[slot];
      else slots[slot] = { itemId };
    }
    this.set(entityId, event.appearanceRevision, { ...current.appearance, slots });
  }

  private drainHeld(entityId: string, nowMs: number): void {
    const byRev = this.held.get(entityId);
    if (!byRev) return;
    for (;;) {
      const current = this.entities.get(entityId) as StreamEntity;
      for (const rev of [...byRev.keys()]) if (rev <= current.revision) byRev.delete(rev);
      const next = byRev.get(current.revision + 1);
      if (!next) break;
      byRev.delete(current.revision + 1);
      this.applyDelta(entityId, current, next.event);
    }
    if (byRev.size === 0) this.held.delete(entityId);
    else for (const h of byRev.values()) h.sinceMs = Math.min(h.sinceMs, nowMs);
  }

  private set(entityId: string, revision: number, appearance: AppearanceDefinition): void {
    const r = resolveAppearance(this.index, appearance);
    const items = r.ok ? [...new Set([...r.value.layers.values()].map((l) => l.slot.item.id))] : [];
    const entity: StreamEntity = { revision, appearance, items };
    this.entities.set(entityId, entity);
    this.counters.applied++;
    this.options.onChange?.(entityId, entity);
  }
}
