/**
 * Feature status beyond the Milestone 0 baseline. Disabled features are listed with the reason so the UI can
 * explain them; requesting an unimplemented render mode falls back to the correct baseline.
 */
import type { RenderMode } from './contracts.ts';

export type FeatureId = RenderMode | 'WEBGPU' | 'VIRTUAL_ATLAS' | 'STREAMING' | 'KTX2' | 'AI_ASSET_PIPELINE';

export interface FeatureInfo {
  id: FeatureId;
  implemented: boolean;
  enabled: boolean;
  milestone: string;
  note: string;
}

export const FEATURES: readonly FeatureInfo[] = [
  { id: 'LAYERED', implemented: true, enabled: true, milestone: 'M0', note: 'Reference baseline: one quad per layer, exact painter order.' },
  { id: 'SHADER', implemented: false, enabled: false, milestone: 'M3', note: 'Single-quad shader composition; needs parity tests vs LAYERED.' },
  { id: 'PARTIAL_CACHE', implemented: false, enabled: false, milestone: 'M3', note: 'Group composite cache; keys exist (partGroupKey), cache does not.' },
  { id: 'FULL_CACHE', implemented: false, enabled: false, milestone: 'M3', note: 'Full frame composite cache; keys exist (compositeFrameKey), cache does not.' },
  { id: 'WEBGPU', implemented: false, enabled: false, milestone: 'M5', note: 'WebGL2 is the baseline; sprite material is isolated for a future TSL port.' },
  { id: 'VIRTUAL_ATLAS', implemented: true, enabled: true, milestone: 'M2', note: 'Compile-time atlas groups (mip-safe) + generation-checked page handles; no runtime repacking yet.' },
  { id: 'STREAMING', implemented: true, enabled: true, milestone: 'M2', note: 'Budget (URL budgetMiB=), LRU eviction, retry/backoff, abortable fetches, prefetch, context-loss recovery.' },
  { id: 'KTX2', implemented: false, enabled: false, milestone: 'M2+', note: 'Only after the PNG baseline is proven correct.' },
  { id: 'AI_ASSET_PIPELINE', implemented: false, enabled: false, milestone: 'M6', note: 'Server-side only; never from the browser. Not connected.' },
];

const RENDER_MODES: ReadonlySet<string> = new Set<RenderMode>(['LAYERED', 'SHADER', 'PARTIAL_CACHE', 'FULL_CACHE']);

export function resolveRenderMode(requested: string | null): { mode: RenderMode; fallbackReason: string | null } {
  if (!requested || requested === 'LAYERED') return { mode: 'LAYERED', fallbackReason: null };
  const feature = RENDER_MODES.has(requested) ? FEATURES.find((f) => f.id === requested) : undefined;
  if (!feature) return { mode: 'LAYERED', fallbackReason: `unknown render mode "${requested}"` };
  return { mode: 'LAYERED', fallbackReason: `${requested} is not implemented (${feature.milestone}): ${feature.note}` };
}
