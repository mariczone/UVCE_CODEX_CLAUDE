import { describe, expect, it } from 'vitest';
import { heroAppearance } from '../../src/uvce/bench/crowd.ts';
import { type ResolvedAppearance, resolveAppearance, withSlot } from '../../src/uvce/core/appearance-resolver.ts';
import { appearanceCanonical, appearanceKey, compositeFrameKey, partGroupKey } from '../../src/uvce/core/cache-keys.ts';
import { canonicalJson, fnv1a64Hex } from '../../src/uvce/core/hash.ts';
import type { AppearanceDefinition } from '../../src/uvce/schema/appearance.ts';
import type { ManifestIndex } from '../../src/uvce/schema/compiled-manifest.ts';
import { compiledAssets } from './helpers.ts';

const HEAD = ['head', 'hair_back', 'hair_front', 'hat'];
const TORSO = ['body', 'arm_front', 'armor'];

async function resolver(): Promise<(a: AppearanceDefinition) => ResolvedAppearance> {
  const { index } = await compiledAssets();
  return (a) => {
    const r = resolveAppearance(index, a);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  };
}

describe('hash primitives', () => {
  it('FNV-1a 64 matches published test vectors', () => {
    expect(fnv1a64Hex('')).toBe('cbf29ce484222325');
    expect(fnv1a64Hex('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64Hex('foobar')).toBe('85944171f73967e8');
  });

  it('canonicalJson is key-order independent and rejects ambiguous values', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 'x' }] })).toBe(canonicalJson({ a: [1, { c: 'x', d: 2 }], b: 1 }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson([undefined])).toThrow();
  });
});

describe('appearance key semantics', () => {
  it('is identical for equal looks regardless of slot insertion order or owning entity', async () => {
    const resolve = await resolver();
    const a = heroAppearance();
    const reversed: AppearanceDefinition = { ...a, slots: Object.fromEntries(Object.entries(a.slots).reverse()) };
    expect(appearanceKey(resolve(a))).toBe(appearanceKey(resolve(reversed)));
    // The key never contains runtime identity.
    expect(appearanceCanonical(resolve(a))).not.toMatch(/entity|position|hero/);
  });

  it('changes when equipment, dye or variant change (dye/variant keyed conservatively)', async () => {
    const resolve = await resolver();
    const base = heroAppearance();
    const key = appearanceKey(resolve(base));
    expect(appearanceKey(resolve(withSlot(base, 'hat', 'hat_02')))).not.toBe(key);
    const dyed = { ...base, slots: { ...base.slots, armor: { itemId: 'armor_01', dye: { primary: '#ff0000' } } } };
    expect(appearanceKey(resolve(dyed))).not.toBe(key);
    const variant = { ...base, slots: { ...base.slots, armor: { itemId: 'armor_01', variant: 'worn' } } };
    expect(appearanceKey(resolve(variant))).not.toBe(key);
  });

  it('treats a hidden slot exactly like an empty slot (same pixels => same key)', async () => {
    const resolve = await resolver();
    const base = heroAppearance();
    const hidden = { ...base, slots: { ...base.slots, hat: { itemId: 'hat_02', hidden: true } } };
    expect(appearanceKey(resolve(hidden))).toBe(appearanceKey(resolve(withSlot(base, 'hat', null))));
  });

  it('changes when an item content hash changes (hot patch invalidation)', async () => {
    const { index } = await compiledAssets();
    const resolve = await resolver();
    const before = appearanceKey(resolve(heroAppearance()));
    const hat = index.items.get('hat_01');
    if (!hat) throw new Error('missing hat_01');
    const patchedItems = new Map(index.items);
    patchedItems.set('hat_01', { ...hat, contentHash: 'f'.repeat(64) });
    const patched: ManifestIndex = { ...index, items: patchedItems };
    const r = resolveAppearance(patched, heroAppearance());
    expect(r.ok && appearanceKey(r.value)).not.toBe(before);
  });

  it('includes the render-semantics version', async () => {
    const resolve = await resolver();
    const r = resolve(heroAppearance());
    expect(appearanceKey(r, 'uvce-render-v1')).not.toBe(appearanceKey(r, 'uvce-render-v2'));
  });
});

describe('partial group keys (future PARTIAL_CACHE)', () => {
  it('swapping the hat invalidates the HEAD group only', async () => {
    const resolve = await resolver();
    const a = resolve(heroAppearance());
    const b = resolve(withSlot(heroAppearance(), 'hat', 'hat_03'));
    expect(partGroupKey(a, HEAD)).not.toBe(partGroupKey(b, HEAD));
    expect(partGroupKey(a, TORSO)).toBe(partGroupKey(b, TORSO));
    expect(partGroupKey(a, ['weapon'])).toBe(partGroupKey(b, ['weapon']));
  });

  it('swapping armor invalidates TORSO only', async () => {
    const resolve = await resolver();
    const a = resolve(heroAppearance());
    const b = resolve(withSlot(heroAppearance(), 'armor', 'armor_02'));
    expect(partGroupKey(a, TORSO)).not.toBe(partGroupKey(b, TORSO));
    expect(partGroupKey(a, HEAD)).toBe(partGroupKey(b, HEAD));
  });
});

describe('composite frame keys (future FULL_CACHE)', () => {
  const base = { appearanceKey: 'ap-0123456789abcdef', clipId: 'walk', direction: 'SE' as const, frameIndex: 3, resolutionTier: 0, compilerVersion: 'uvce-compiler/0.1.0' };

  it('depends on the logical frame, not on time or phase (shared across phase offsets)', () => {
    expect(compositeFrameKey(base)).toBe(compositeFrameKey({ ...base }));
    expect(compositeFrameKey({ ...base, frameIndex: 4 })).not.toBe(compositeFrameKey(base));
  });

  it('changes with direction, clip, tier, compiler version and debug layer toggles', () => {
    const k = compositeFrameKey(base);
    expect(compositeFrameKey({ ...base, direction: 'NW' })).not.toBe(k);
    expect(compositeFrameKey({ ...base, clipId: 'idle' })).not.toBe(k);
    expect(compositeFrameKey({ ...base, resolutionTier: 1 })).not.toBe(k);
    expect(compositeFrameKey({ ...base, compilerVersion: 'uvce-compiler/0.2.0' })).not.toBe(k);
    expect(compositeFrameKey({ ...base, hiddenLayers: new Set(['hat']) })).not.toBe(k);
    expect(compositeFrameKey({ ...base, hiddenLayers: new Set(['weapon', 'hat']) })).toBe(compositeFrameKey({ ...base, hiddenLayers: new Set(['hat', 'weapon']) }));
  });
});
