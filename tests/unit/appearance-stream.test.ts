import { describe, expect, it } from 'vitest';
import { companionAppearance, heroAppearance } from '../../src/uvce/bench/crowd.ts';
import { SyntheticAppearanceServer } from '../../src/uvce/bench/synthetic-network.ts';
import { type AppearanceChangedEvent, type AppearanceSnapshotEvent, AppearanceStream } from '../../src/uvce/net/appearance-stream.ts';
import { compiledAssets } from './helpers.ts';

const snapshot = (version: string, revision: number, appearance = heroAppearance()): AppearanceSnapshotEvent => ({ type: 'appearance.snapshot', entityId: 'p2', appearanceRevision: revision, appearance, assetManifestVersion: version });
const changed = (version: string, revision: number, changes: Record<string, string | null>): AppearanceChangedEvent => ({ type: 'appearance.changed', entityId: 'p2', appearanceRevision: revision, changes, assetManifestVersion: version });
const slotsOf = (s: AppearanceStream): Record<string, string> => Object.fromEntries(Object.entries(s.get('p2')?.appearance.slots ?? {}).map(([k, v]) => [k, v.itemId]));

describe('appearance stream (client side of appearance.changed)', () => {
  it('applies a snapshot, then deltas in order; every change is a new appearance object with its dependencies', async () => {
    const { index } = await compiledAssets();
    const v = index.manifest.manifestVersion;
    const seen: string[][] = [];
    const s = new AppearanceStream(index, { onChange: (_, e) => seen.push([...e.items]) });
    expect(s.apply(snapshot(v, 37), 0)).toBe('applied');
    const before = s.get('p2')?.appearance;
    expect(s.apply(changed(v, 38, { hat: 'hat_03', weapon: null }), 10)).toBe('applied');
    expect(s.get('p2')?.appearance).not.toBe(before);
    expect(slotsOf(s).hat).toBe('hat_03');
    expect(slotsOf(s).weapon).toBeUndefined();
    expect(s.get('p2')?.items).toContain('hat_03');
    expect(s.get('p2')?.items).not.toContain('weapon_01');
    expect(seen).toHaveLength(2);
  });

  it('drops stale and duplicate deltas; holds future ones until the gap fills (out-of-order delivery)', async () => {
    const { index } = await compiledAssets();
    const v = index.manifest.manifestVersion;
    const s = new AppearanceStream(index);
    s.apply(snapshot(v, 10), 0);
    expect(s.apply(changed(v, 12, { weapon: 'weapon_03' }), 1)).toBe('held');
    expect(s.apply(changed(v, 12, { weapon: 'weapon_03' }), 2)).toBe('stale'); // duplicate of a held delta
    expect(s.apply(changed(v, 13, { hat: 'hat_02' }), 3)).toBe('held');
    expect(s.get('p2')?.revision).toBe(10);
    expect(s.apply(changed(v, 11, { armor: 'armor_02' }), 4)).toBe('applied'); // fills the gap: 11, 12, 13 apply
    expect(s.get('p2')?.revision).toBe(13);
    expect(slotsOf(s)).toMatchObject({ armor: 'armor_02', weapon: 'weapon_03', hat: 'hat_02' });
    expect(s.apply(changed(v, 12, { weapon: 'weapon_01' }), 5)).toBe('stale'); // late duplicate: must not revert
    expect(slotsOf(s).weapon).toBe('weapon_03');
    expect(s.stats()).toMatchObject({ held: 2, stale: 2 });
  });

  it('a gap that stays open asks for a snapshot once; the snapshot replaces state and drops covered deltas', async () => {
    const { index } = await compiledAssets();
    const v = index.manifest.manifestVersion;
    const resyncs: string[] = [];
    const s = new AppearanceStream(index, { gapTimeoutMs: 300, onResync: (id) => resyncs.push(id) });
    s.apply(snapshot(v, 1), 0);
    s.apply(changed(v, 3, { hat: 'hat_02' }), 100); // revision 2 was lost
    s.apply(changed(v, 5, { weapon: 'weapon_02' }), 120);
    s.update(350);
    expect(resyncs).toEqual([]);
    s.update(400);
    s.update(500);
    expect(resyncs).toEqual(['p2']); // once, not every tick
    expect(s.apply(snapshot(v, 4, companionAppearance()), 520)).toBe('applied'); // covers 3; 5 now applies on top
    expect(s.get('p2')?.revision).toBe(5);
    expect(slotsOf(s)).toMatchObject({ hat: 'hat_03', weapon: 'weapon_02' });
    expect(s.apply(snapshot(v, 4), 530)).toBe('stale');
  });

  it('rejects other manifest versions and deltas without a base; entity.left forgets the entity', async () => {
    const { index } = await compiledAssets();
    const v = index.manifest.manifestVersion;
    const s = new AppearanceStream(index);
    expect(s.apply(snapshot('m-other', 1), 0)).toBe('version-mismatch');
    expect(s.apply(changed(v, 2, { hat: 'hat_02' }), 0)).toBe('unknown-entity');
    s.apply(snapshot(v, 1), 0);
    expect(s.apply({ type: 'entity.left', entityId: 'p2' }, 1)).toBe('left');
    expect(s.get('p2')).toBeUndefined();
  });
});

describe('synthetic appearance network', () => {
  it('100 players over a lossy, reordering, duplicating link: every client state converges to the server state', async () => {
    const { index } = await compiledAssets();
    const v = index.manifest.manifestVersion;
    const server = new SyntheticAppearanceServer({
      seed: 7,
      manifestVersion: v,
      slotPool: { hat: ['hat_01', 'hat_02', 'hat_03', null], armor: ['armor_01', 'armor_02', 'armor_03'], weapon: ['weapon_01', 'weapon_02', 'weapon_03', null] },
      latencyMs: [20, 180],
      duplicateRate: 0.1,
      lossRate: 0.05,
      changeEveryMs: 400,
      heartbeatMs: 250,
    });
    const stream = new AppearanceStream(index, { gapTimeoutMs: 400, onResync: (id) => server.requestSnapshot(id, now) });
    let now = 0;
    for (let i = 0; i < 100; i++) server.addPlayer(`p${i}`, heroAppearance(), 0);
    for (let i = 0; i < 100; i++) server.join(`p${i}`, i * 10); // players arrive over 1 s
    const outcomes: Record<string, number> = {};
    for (now = 0; now <= 10_000; now += 16) {
      if (now > 8_000) server.pauseChanges(); // changes stop at 8 s so the link can drain; heartbeats go on
      server.step(now);
      for (const e of server.deliver(now)) {
        const o = stream.apply(e, now);
        outcomes[o] = (outcomes[o] ?? 0) + 1;
      }
      stream.update(now);
    }
    expect(server.counters.lost).toBeGreaterThan(0);
    expect(server.counters.duplicated).toBeGreaterThan(0);
    expect(outcomes.held).toBeGreaterThan(0); // reordering really happened
    expect(stream.stats().resyncRequests).toBeGreaterThan(0); // losses were repaired by snapshots
    for (let i = 0; i < 100; i++) {
      const truth = server.truth(`p${i}`);
      const client = stream.get(`p${i}`);
      expect(client?.revision, `p${i}`).toBe(truth?.revision);
      expect(client?.appearance.slots).toEqual(truth?.appearance.slots);
    }
  });

  it('is deterministic for a seed', async () => {
    const { index } = await compiledAssets();
    const run = (): string => {
      const server = new SyntheticAppearanceServer({ seed: 3, manifestVersion: index.manifest.manifestVersion, slotPool: { hat: ['hat_01', 'hat_02'] }, latencyMs: [10, 90], duplicateRate: 0.2, lossRate: 0.1, changeEveryMs: 200, heartbeatMs: 300 });
      server.addPlayer('a', heroAppearance(), 0);
      server.join('a', 0);
      const log: string[] = [];
      for (let t = 0; t < 2000; t += 16) {
        server.step(t);
        for (const e of server.deliver(t)) log.push(`${t}:${e.type}:${'appearanceRevision' in e ? e.appearanceRevision : ''}`);
      }
      return log.join(',');
    };
    expect(run()).toBe(run());
  });
});
