import type { ResolvedAppearance, ResolvedSlot } from './appearance-resolver.ts';
import type { Direction8 } from './directions.ts';
import { canonicalJson, fnv1a64Hex } from './hash.ts';

/**
 * Version of the composition semantics (blend math, filtering, order rules). Bump it whenever the same inputs
 * would produce different pixels, so every derived cache key changes.
 */
export const RENDER_SEMANTICS_VERSION = 'uvce-render-v1';

function slotEntry(s: ResolvedSlot): Record<string, unknown> {
  return {
    slot: s.slot,
    id: s.ref.id,
    version: s.ref.version,
    contentHash: s.ref.contentHash,
    // Not rendered yet in Milestone 0, but they will change pixels: keyed conservatively now.
    variant: s.assignment.variant ?? null,
    dye: s.assignment.dye ?? null,
  };
}

/**
 * Canonical description of everything that affects a character's pixels. Excludes entity id, position,
 * facing and animation time (those never change the source art), and hidden slots (they draw nothing).
 */
export function appearanceCanonical(appearance: ResolvedAppearance, renderVersion = RENDER_SEMANTICS_VERSION): string {
  return canonicalJson({
    kind: 'appearance',
    renderVersion,
    rig: { id: appearance.rig.id, version: appearance.rig.version },
    slots: appearance.slots.map(slotEntry),
  });
}

export function appearanceKey(appearance: ResolvedAppearance, renderVersion = RENDER_SEMANTICS_VERSION): string {
  return `ap-${fnv1a64Hex(appearanceCanonical(appearance, renderVersion))}`;
}

/**
 * Key of a sub-group of layers (e.g. HEAD = head+hair+hat). Only the slots that provide those layers take part,
 * so swapping a hat changes the HEAD key and leaves the TORSO key untouched.
 * NOTE: a group key is only valid for caching if the group's layers are contiguous in the painter order of
 * the direction being cached (see ordered segments in the blueprint §9.1); callers must check that.
 */
export function partGroupKey(appearance: ResolvedAppearance, groupLayers: readonly string[], renderVersion = RENDER_SEMANTICS_VERSION): string {
  const wanted = new Set(groupLayers);
  const slots = new Set<string>();
  for (const [layer, src] of appearance.layers) if (wanted.has(layer)) slots.add(src.slot.slot);
  const entries = appearance.slots.filter((s) => slots.has(s.slot)).map(slotEntry);
  return `pg-${fnv1a64Hex(
    canonicalJson({ kind: 'part-group', renderVersion, rig: { id: appearance.rig.id, version: appearance.rig.version }, layers: [...wanted].sort(), slots: entries }),
  )}`;
}

export interface CompositeFrameKeyInput {
  appearanceKey: string;
  clipId: string;
  direction: Direction8;
  /** Logical frame index, NOT time: characters with different phase offsets on the same frame share it. */
  frameIndex: number;
  resolutionTier: number;
  compilerVersion: string;
  /** Debug layer toggles change pixels, so they are part of the key when present. */
  hiddenLayers?: ReadonlySet<string>;
}

export function compositeFrameKey(input: CompositeFrameKeyInput): string {
  return `cf-${fnv1a64Hex(
    canonicalJson({
      kind: 'composite-frame',
      appearanceKey: input.appearanceKey,
      clipId: input.clipId,
      direction: input.direction,
      frameIndex: input.frameIndex,
      resolutionTier: input.resolutionTier,
      compilerVersion: input.compilerVersion,
      hiddenLayers: input.hiddenLayers ? [...input.hiddenLayers].sort() : [],
    }),
  )}`;
}
