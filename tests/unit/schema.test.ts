import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { APPEARANCE_SCHEMA_V2, parseAppearance } from '../../src/uvce/schema/appearance.ts';
import { type CompiledManifest, parseCompiledManifest } from '../../src/uvce/schema/compiled-manifest.ts';
import { parseSourceManifest } from '../../tools/uvce/source-schema.ts';
import { fixtures, manifestJson } from './helpers.ts';

function codes(m: unknown): string[] {
  const r = parseCompiledManifest(m);
  return r.ok ? [] : r.issues.map((i) => i.code);
}

describe('compiled manifest validation', () => {
  it('accepts the compiler output', async () => {
    const r = parseCompiledManifest(await manifestJson());
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown schema version', async () => {
    const m = await manifestJson();
    (m as { schemaVersion: string }).schemaVersion = 'uvce-compiled-manifest-v0';
    expect(codes(m)).toContain('schema.invalid_value');
  });

  it('rejects a layer order that is not a permutation of the rig layers', async () => {
    const m = await manifestJson();
    const order = m.rigs[0]?.layerOrder.SE as string[];
    order[1] = order[0] as string; // duplicate one layer, drop another
    expect(codes(m)).toEqual(expect.arrayContaining(['rig.order']));
  });

  it('rejects a missing rest socket and an undeclared one', async () => {
    const m = await manifestJson();
    const rest = m.rigs[0]?.restSockets.N as Record<string, unknown>;
    delete rest.right_hand;
    rest.tail = { x: 1, y: 1 };
    const c = codes(m);
    expect(c.filter((x) => x === 'rig.rest-socket').length).toBeGreaterThanOrEqual(2);
  });

  it('rejects clip frame counts that disagree with the clip timeline', async () => {
    const m = await manifestJson();
    const body = m.items.find((i) => i.id === 'body_base');
    const frames = body?.parts.find((p) => p.layer === 'body')?.clips?.walk?.E;
    frames?.pop();
    expect(codes(m)).toContain('part.frame-count');
  });

  it('rejects driver frames without sockets and sockets on non-driver frames', async () => {
    const m = await manifestJson();
    const body = m.items.find((i) => i.id === 'body_base');
    const f = body?.parts.find((p) => p.layer === 'body')?.clips?.idle?.S?.[0];
    if (f) delete f.sockets;
    const hat = m.items.find((i) => i.id === 'hat_01');
    const hs = hat?.parts[0]?.static?.S;
    if (hs) hs.sockets = { neck: { x: 1, y: 1 } };
    const c = codes(m);
    expect(c.filter((x) => x === 'frame.sockets').length).toBeGreaterThanOrEqual(7); // 6 missing + 1 forbidden
  });

  it('rejects equipment in the wrong slot layer, unknown sockets and unknown images', async () => {
    const m = await manifestJson();
    const hat = m.items.find((i) => i.id === 'hat_01') as CompiledManifest['items'][number];
    (hat.parts[0] as { layer: string }).layer = 'weapon';
    const weapon = m.items.find((i) => i.id === 'weapon_01') as CompiledManifest['items'][number];
    (weapon.parts[0] as { attach: string }).attach = 'tail';
    const armor = m.items.find((i) => i.id === 'armor_01') as CompiledManifest['items'][number];
    const s = armor.parts[0]?.static?.N;
    if (s) s.image = 'img-000000000000000000000000';
    expect(codes(m)).toEqual(expect.arrayContaining(['part.layer', 'part.attach', 'frame.image']));
  });

  it('rejects non-FRAME representations in this milestone with an explicit message', async () => {
    const m = await manifestJson();
    (m.items[0]?.parts[0] as { representation: string }).representation = 'RIG';
    const r = parseCompiledManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.find((i) => i.code === 'part.representation')?.message).toMatch(/FRAME only/);
  });

  it('rejects atlas regions outside their page and dangling aliases', async () => {
    const m = await manifestJson();
    const [key, region] = Object.entries(m.images)[0] as [string, { x: number }];
    region.x = 99_999;
    m.aliases.ghost = 'does_not_exist';
    const c = codes(m);
    expect(c).toEqual(expect.arrayContaining(['image.bounds', 'alias.target']));
    expect(key).toMatch(/^img-/);
  });

  it('rejects trim rectangles outside the canonical canvas', async () => {
    const m = await manifestJson();
    const f = m.items.find((i) => i.id === 'hat_02')?.parts[0]?.static?.E;
    if (f) f.trim.x = 250;
    expect(codes(m)).toContain('frame.trim');
  });
});

describe('source manifest validation', () => {
  it('accepts the generator output and rejects missing anchors', async () => {
    const json = JSON.parse(await readFile(`${fixtures().sourceDir}/source-manifest.json`, 'utf8')) as {
      items: { id: string; parts: { static?: Record<string, { anchor?: unknown }> }[] }[];
    };
    expect(parseSourceManifest(json).ok).toBe(true);
    const hat = json.items.find((i) => i.id === 'hat_01');
    delete hat?.parts[0]?.static?.S?.anchor;
    const r = parseSourceManifest(json);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain('frame.anchor');
  });

  it('rejects path traversal in frame file names', async () => {
    const json = JSON.parse(await readFile(`${fixtures().sourceDir}/source-manifest.json`, 'utf8')) as {
      items: { id: string; parts: { static?: Record<string, { file: string }> }[] }[];
    };
    const frame = json.items.find((i) => i.id === 'hat_01')?.parts[0]?.static?.S;
    if (frame) frame.file = '../../etc/passwd.png';
    expect(parseSourceManifest(json).ok).toBe(false);
  });
});

describe('appearance schema + migration', () => {
  it('accepts a canonical v2 appearance', () => {
    const r = parseAppearance({ schemaVersion: APPEARANCE_SCHEMA_V2, rigProfileId: 'humanoid_2d_v1', slots: { body: { itemId: 'body_base' } } });
    expect(r.ok && r.migratedFrom).toBe(null);
  });

  it('migrates the starter-pack v1 example and reports every dropped field', async () => {
    const example = JSON.parse(await readFile('examples/appearance.example.json', 'utf8')) as unknown;
    const r = parseAppearance(example);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBe('uvce-appearance-v1');
    expect(r.appearance.slots.body?.itemId).toBe('body_novice');
    expect(r.appearance.slots.armor?.dye).toEqual({ primary: '#467f8e' });
    const codes = r.issues.map((i) => i.code);
    expect(codes.filter((c) => c === 'migrate.content-hash-dropped')).toHaveLength(7);
    expect(codes.filter((c) => c === 'migrate.field-moved')).toHaveLength(3);
  });

  it('rejects unknown versions, bad ids and bad dye colours', () => {
    expect(parseAppearance({ schemaVersion: 'uvce-appearance-v9' }).ok).toBe(false);
    expect(parseAppearance(null).ok).toBe(false);
    expect(parseAppearance({ schemaVersion: APPEARANCE_SCHEMA_V2, rigProfileId: 'humanoid_2d_v1', slots: { hat: { itemId: 'Hat 01' } } }).ok).toBe(false);
    expect(parseAppearance({ schemaVersion: APPEARANCE_SCHEMA_V2, rigProfileId: 'humanoid_2d_v1', slots: { hat: { itemId: 'hat_01', dye: { primary: 'red' } } } }).ok).toBe(false);
    expect(parseAppearance({ schemaVersion: APPEARANCE_SCHEMA_V2, rigProfileId: 'humanoid_2d_v1', slots: {}, extra: 1 }).ok).toBe(false);
  });
});
