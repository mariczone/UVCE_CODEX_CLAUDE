import { describe, expect, it } from 'vitest';
import { heroAppearance } from '../../src/uvce/bench/crowd.ts';
import { resolveAppearance, withSlot } from '../../src/uvce/core/appearance-resolver.ts';
import { DIRECTIONS, type Direction8 } from '../../src/uvce/core/directions.ts';
import { resolvePose } from '../../src/uvce/core/pose.ts';
import { APPEARANCE_SCHEMA_V2, type AppearanceDefinition, parseAppearance } from '../../src/uvce/schema/appearance.ts';
import { readFile } from 'node:fs/promises';
import { compiledAssets } from './helpers.ts';

async function setup() {
  const { index } = await compiledAssets();
  const resolve = (a: AppearanceDefinition) => {
    const r = resolveAppearance(index, a);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  };
  return { index, resolve };
}

const order = (layers: readonly { layer: string }[]): string[] => layers.map((l) => l.layer);

describe('equipment resolution', () => {
  it('resolves the default look to content-addressed refs, sorted by slot', async () => {
    const { resolve } = await setup();
    const r = resolve(heroAppearance());
    expect(r.slots.map((s) => s.slot)).toEqual(['armor', 'body', 'hair', 'hat', 'head', 'weapon']);
    for (const s of r.slots) expect(s.ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.issues).toEqual([]);
    expect([...r.layers.keys()].sort()).toEqual(['arm_front', 'armor', 'body', 'hair_back', 'hair_front', 'hat', 'head', 'weapon']);
  });

  it('allows 3 variants per hat/armor/weapon slot, each changing only its own layer source', async () => {
    const { resolve } = await setup();
    const base = resolve(heroAppearance());
    for (const [slot, layer] of [['hat', 'hat'], ['armor', 'armor'], ['weapon', 'weapon']] as const) {
      for (const n of ['01', '02', '03']) {
        const r = resolve(withSlot(heroAppearance(), slot, `${slot}_${n}`));
        expect(r.layers.get(layer)?.slot.item.id).toBe(`${slot}_${n}`);
        for (const [l, src] of r.layers) if (l !== layer) expect(src.slot.item.id).toBe(base.layers.get(l)?.slot.item.id);
      }
    }
  });

  it('drops unknown items and wrong-slot items with errors but still renders', async () => {
    const { index } = await setup();
    const a = { ...heroAppearance(), slots: { ...heroAppearance().slots, hat: { itemId: 'hat_99' }, weapon: { itemId: 'hat_02' } } };
    const r = resolveAppearance(index, a);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['appearance.unknown-item', 'appearance.slot-mismatch']));
    expect(r.value.layers.has('hat')).toBe(false);
    expect(r.value.layers.has('weapon')).toBe(false);
  });

  it('falls back for empty required slots, warns on alias and version pins, rejects unknown rigs', async () => {
    const { index } = await setup();
    const r = resolveAppearance(index, { schemaVersion: APPEARANCE_SCHEMA_V2, rigProfileId: 'humanoid_2d_v1', slots: { weapon: { itemId: 'sword_01', version: '7' } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const codes = r.value.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['appearance.alias', 'appearance.version', 'appearance.fallback']));
    expect(r.value.layers.get('weapon')?.slot.item.id).toBe('weapon_01');
    expect(r.value.layers.get('body')?.slot.item.id).toBe('body_base');
    expect(resolveAppearance(index, { ...heroAppearance(), rigProfileId: 'quadruped_v1' }).ok).toBe(false);
  });

  it('resolves the migrated starter-pack example via explicit aliases, dropping unknown slots', async () => {
    const { index } = await setup();
    const parsed = parseAppearance(JSON.parse(await readFile('examples/appearance.example.json', 'utf8')) as unknown);
    if (!parsed.ok) throw new Error('example did not parse');
    const r = resolveAppearance(index, parsed.appearance);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.layers.get('body')?.slot.item.id).toBe('body_base');
    expect(r.value.layers.get('weapon')?.slot.item.id).toBe('weapon_01');
    expect(r.value.issues.filter((i) => i.code === 'appearance.unknown-slot').map((i) => i.path).sort()).toEqual(['/slots/hair_back', '/slots/hair_front']);
  });

  it('withSlot never mutates the source appearance', () => {
    const a = heroAppearance();
    const before = JSON.stringify(a);
    withSlot(a, 'hat', 'hat_03');
    withSlot(a, 'weapon', null);
    expect(JSON.stringify(a)).toBe(before);
  });
});

describe('pose resolution (draw order, sockets, pivots)', () => {
  it('puts the right-hand weapon in front for S/SE/E/NE and behind the body for SW/W/NW/N', async () => {
    const { index, resolve } = await setup();
    const r = resolve(heroAppearance());
    for (const d of DIRECTIONS) {
      const layers = order(resolvePose(index, r, { clipId: 'idle', direction: d, frameIndex: 0 }).layers);
      const front = layers.indexOf('weapon') > layers.indexOf('body');
      expect([d, front]).toEqual([d, ['S', 'SE', 'E', 'NE'].includes(d)]);
    }
  });

  it('draws the hair mass over the head in back views and the fringe only in front/side views', async () => {
    const { index, resolve } = await setup();
    const r = resolve(heroAppearance());
    const layersFor = (d: Direction8) => order(resolvePose(index, r, { clipId: 'idle', direction: d, frameIndex: 0 }).layers);
    for (const d of ['N', 'NE', 'NW'] as const) {
      const l = layersFor(d);
      expect(l.indexOf('hair_back')).toBeGreaterThan(l.indexOf('head'));
      expect(l).not.toContain('hair_front');
    }
    for (const d of ['S', 'SE', 'SW', 'E', 'W'] as const) {
      const l = layersFor(d);
      expect(l.indexOf('hair_back')).toBeLessThan(l.indexOf('head'));
      expect(l.indexOf('hair_front')).toBeGreaterThan(l.indexOf('head'));
    }
  });

  it('draws the near arm above the armor only where an arm crosses the torso', async () => {
    const { index, resolve } = await setup();
    const r = resolve(heroAppearance());
    for (const d of DIRECTIONS) {
      const l = order(resolvePose(index, r, { clipId: 'walk', direction: d, frameIndex: 2 }).layers);
      if (d === 'S' || d === 'N') expect(l).not.toContain('arm_front');
      else expect(l.indexOf('arm_front')).toBeGreaterThan(l.indexOf('armor'));
    }
  });

  it('moves socket-attached equipment with the per-frame sockets of the animated body', async () => {
    const { index, resolve } = await setup();
    const r = resolve(heroAppearance());
    const rest = resolvePose(index, r, { clipId: 'idle', direction: 'E', frameIndex: 0 });
    for (let f = 0; f < 8; f++) {
      const p = resolvePose(index, r, { clipId: 'walk', direction: 'E', frameIndex: f });
      const rel = (layer: string, socket: string) => {
        const l = p.layers.find((x) => x.layer === layer);
        const r0 = rest.layers.find((x) => x.layer === layer);
        const s = p.sockets[socket];
        const s0 = rest.sockets[socket];
        if (!l || !r0 || !s || !s0) throw new Error(`missing ${layer}/${socket}`);
        return { moved: { x: l.dest.x - r0.dest.x, y: l.dest.y - r0.dest.y }, socketDelta: { x: s.x - s0.x, y: s.y - s0.y } };
      };
      for (const [layer, socket] of [['hat', 'head_top'], ['weapon', 'right_hand'], ['armor', 'chest'], ['head', 'neck']] as const) {
        const { moved, socketDelta } = rel(layer, socket);
        expect(moved).toEqual(socketDelta);
      }
      // The same static image is reused for every frame (no per-frame equipment art).
      expect(p.layers.find((x) => x.layer === 'hat')?.image).toBe(rest.layers.find((x) => x.layer === 'hat')?.image);
    }
  });

  it('keeps the foot pivot as the root socket and body frames registered on the canonical canvas', async () => {
    const { index, resolve } = await setup();
    const r = resolve(heroAppearance());
    for (const d of DIRECTIONS) {
      const p = resolvePose(index, r, { clipId: 'idle', direction: d, frameIndex: 0 });
      expect(p.sockets.root).toEqual({ x: 128, y: 228 });
      const body = p.layers.find((l) => l.layer === 'body');
      expect(body && body.dest.y + body.dest.h).toBe(228); // shoes end exactly on the pivot line
    }
  });

  it('hides toggled layers without reordering the rest', async () => {
    const { index, resolve } = await setup();
    const r = resolve(heroAppearance());
    const full = order(resolvePose(index, r, { clipId: 'idle', direction: 'SE', frameIndex: 0 }).layers);
    const hidden = order(resolvePose(index, r, { clipId: 'idle', direction: 'SE', frameIndex: 0, hiddenLayers: new Set(['hat', 'armor']) }).layers);
    expect(hidden).toEqual(full.filter((l) => l !== 'hat' && l !== 'armor'));
  });

  it('resolves every equipment combination x clip x direction x frame to integer, in-canvas rects', async () => {
    const { index, resolve } = await setup();
    const choices = (slot: string) => [null, ...[...(index.itemsBySlot.get(slot) ?? [])].map((i) => i.id)];
    let poses = 0;
    for (const hair of choices('hair'))
      for (const hat of choices('hat'))
        for (const armor of choices('armor'))
          for (const weapon of choices('weapon')) {
            let a = heroAppearance();
            a = withSlot(withSlot(withSlot(withSlot(a, 'hair', hair), 'hat', hat), 'armor', armor), 'weapon', weapon);
            const r = resolve(a);
            for (const clip of ['idle', 'walk'])
              for (const d of DIRECTIONS)
                for (let f = 0; f < 8; f++) {
                  const p = resolvePose(index, r, { clipId: clip, direction: d, frameIndex: f });
                  poses++;
                  expect(p.issues).toEqual([]);
                  for (const l of p.layers) {
                    expect(Number.isInteger(l.dest.x) && Number.isInteger(l.dest.y)).toBe(true);
                    expect(l.dest.x >= 0 && l.dest.y >= 0 && l.dest.x + l.dest.w <= 256 && l.dest.y + l.dest.h <= 256).toBe(true);
                  }
                }
          }
    expect(poses).toBe(3 * 4 * 4 * 4 * 2 * 8 * 8);
  });
});
