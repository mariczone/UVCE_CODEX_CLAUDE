import type { AppearanceDefinition, SlotAssignment } from '../schema/appearance.ts';
import type { RigProfile } from '../schema/common.ts';
import type { CompiledItem, CompiledPart, ManifestIndex } from '../schema/compiled-manifest.ts';
import { type Issue, issue } from './issues.ts';

/** Immutable reference to versioned, content-addressed asset data. */
export interface AssetRef {
  id: string;
  version: string;
  contentHash: string;
}

export interface ResolvedSlot {
  slot: string;
  item: CompiledItem;
  ref: AssetRef;
  assignment: SlotAssignment;
}

export interface LayerSource {
  slot: ResolvedSlot;
  part: CompiledPart;
}

export interface ResolvedAppearance {
  rig: RigProfile;
  /** Visible equipped slots, sorted by slot name. Hidden slots are excluded: they do not affect pixels. */
  slots: readonly ResolvedSlot[];
  /** layer -> the equipped item part that provides it */
  layers: ReadonlyMap<string, LayerSource>;
  /** 'error' = part of the request was invalid and dropped; 'warning' = fallback/alias/migration notes. */
  issues: Issue[];
}

export type AppearanceResolution = { ok: true; value: ResolvedAppearance } | { ok: false; issues: Issue[] };

/**
 * Resolves logical equipment ids against the compiled manifest. Unknown or mismatched equipment is dropped
 * with an issue (the character still renders); a missing required slot falls back to the first manifest
 * item for that slot. Only an unknown rig or an unfillable required slot is fatal.
 */
export function resolveAppearance(index: ManifestIndex, appearance: AppearanceDefinition): AppearanceResolution {
  const issues: Issue[] = [];
  const rig = index.rigs.get(appearance.rigProfileId);
  if (!rig) {
    return { ok: false, issues: [issue('error', 'appearance.rig', '/rigProfileId', `unknown rig "${appearance.rigProfileId}"`)] };
  }
  const resolved: ResolvedSlot[] = [];
  const slotNames = Object.keys(appearance.slots).sort();
  for (const slotName of slotNames) {
    const assignment = appearance.slots[slotName] as SlotAssignment;
    const path = `/slots/${slotName}`;
    const slotDef = rig.slots.find((s) => s.name === slotName);
    if (!slotDef) {
      issues.push(issue('error', 'appearance.unknown-slot', path, `rig ${rig.id} has no slot "${slotName}"; dropped`));
      continue;
    }
    if (assignment.hidden) continue;
    let itemId = assignment.itemId;
    const alias = index.manifest.aliases[itemId];
    if (alias) {
      issues.push(issue('warning', 'appearance.alias', `${path}/itemId`, `"${itemId}" is an alias of "${alias}"`));
      itemId = alias;
    }
    const item = index.items.get(itemId);
    if (!item) {
      issues.push(issue('error', 'appearance.unknown-item', `${path}/itemId`, `unknown item "${assignment.itemId}"; slot left empty`));
      continue;
    }
    if (item.slot !== slotName) {
      issues.push(issue('error', 'appearance.slot-mismatch', `${path}/itemId`, `item "${item.id}" belongs to slot "${item.slot}", not "${slotName}"; dropped`));
      continue;
    }
    if (item.rigProfileId !== rig.id) {
      issues.push(issue('error', 'appearance.rig-mismatch', `${path}/itemId`, `item "${item.id}" targets rig "${item.rigProfileId}"`));
      continue;
    }
    if (assignment.version !== undefined && assignment.version !== item.version) {
      issues.push(issue('warning', 'appearance.version', `${path}/version`, `requested v${assignment.version}, manifest has v${item.version}; using manifest version`));
    }
    resolved.push({ slot: slotName, item, ref: { id: item.id, version: item.version, contentHash: item.contentHash }, assignment });
  }
  for (const slotDef of rig.slots) {
    if (!slotDef.required || resolved.some((r) => r.slot === slotDef.name)) continue;
    const fallback = [...(index.itemsBySlot.get(slotDef.name) ?? [])].filter((i) => i.rigProfileId === rig.id).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (!fallback) {
      return { ok: false, issues: [...issues, issue('error', 'appearance.required-slot', `/slots/${slotDef.name}`, `required slot "${slotDef.name}" cannot be filled`)] };
    }
    issues.push(issue('warning', 'appearance.fallback', `/slots/${slotDef.name}`, `required slot empty; using fallback "${fallback.id}"`));
    resolved.push({ slot: slotDef.name, item: fallback, ref: { id: fallback.id, version: fallback.version, contentHash: fallback.contentHash }, assignment: { itemId: fallback.id } });
  }
  resolved.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  const layers = new Map<string, LayerSource>();
  for (const slot of resolved) {
    for (const part of slot.item.parts) {
      const prev = layers.get(part.layer);
      if (prev) {
        // Cannot happen with a validated manifest (a layer is owned by one slot); kept as a guard.
        issues.push(issue('error', 'appearance.layer-conflict', `/slots/${slot.slot}`, `layer "${part.layer}" already provided by slot "${prev.slot.slot}"`));
        continue;
      }
      layers.set(part.layer, { slot, part });
    }
  }
  return { ok: true, value: { rig, slots: resolved, layers, issues } };
}

/** Returns a new appearance with one slot changed (null = unequip). Never mutates the input. */
export function withSlot(appearance: AppearanceDefinition, slot: string, itemId: string | null): AppearanceDefinition {
  const slots = { ...appearance.slots };
  if (itemId === null) delete slots[slot];
  else slots[slot] = { itemId };
  return { ...appearance, slots };
}
