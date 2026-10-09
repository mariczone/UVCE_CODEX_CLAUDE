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
  { id: 'LAYERED', implemented: true, enabled: true, milestone: 'M0', note: 'Reference baseline and automatic fallback: one quad per layer (URL mode=LAYERED).' },
  { id: 'SHADER', implemented: true, enabled: true, milestone: 'M3', note: 'DEFAULT: one composited quad per character; won or tied every workload on the RTX 3070 (1080p and 4K).' },
  { id: 'PARTIAL_CACHE', implemented: false, enabled: false, milestone: 'M3', note: 'Group composite cache; keys exist (partGroupKey), cache does not.' },
  { id: 'FULL_CACHE', implemented: true, enabled: false, milestone: 'M3', note: 'Baked whole frames in a render-target cache (URL mode=FULL_CACHE, cacheMiB=); falls back to SHADER on a miss.' },
  { id: 'AUTO', implemented: true, enabled: false, milestone: 'M3', note: 'Adaptive planner: SHADER per default, FULL_CACHE per appearance group when measured frame reuse >= 0.9 (URL mode=AUTO).' },
  { id: 'WEBGPU', implemented: false, enabled: false, milestone: 'M5', note: 'WebGL2 is the baseline; sprite material is isolated for a future TSL port.' },
  { id: 'VIRTUAL_ATLAS', implemented: true, enabled: true, milestone: 'M2', note: 'Compile-time atlas groups (mip-safe) + generation-checked page handles; no runtime repacking yet.' },
  { id: 'STREAMING', implemented: true, enabled: true, milestone: 'M2', note: 'Budget (URL budgetMiB=), LRU eviction, retry/backoff, abortable fetches, prefetch, context-loss recovery.' },
  { id: 'KTX2', implemented: false, enabled: false, milestone: 'M2+', note: 'Only after the PNG baseline is proven correct.' },
  { id: 'AI_ASSET_PIPELINE', implemented: false, enabled: false, milestone: 'M6', note: 'Server-side only; never from the browser. Not connected.' },
];

/** Default since the RTX 3070 matrix (docs/benchmark-results/gpu/2026-10-09-rtx3070-pending-runs). */
export const DEFAULT_RENDER_MODE: RenderMode = 'SHADER';

const RENDER_MODES: ReadonlySet<string> = new Set<RenderMode>(['LAYERED', 'SHADER', 'PARTIAL_CACHE', 'FULL_CACHE', 'AUTO']);

export function resolveRenderMode(requested: string | null): { mode: RenderMode; fallbackReason: string | null } {
  if (!requested) return { mode: DEFAULT_RENDER_MODE, fallbackReason: null };
  if (requested === 'LAYERED') return { mode: 'LAYERED', fallbackReason: null };
  const feature = RENDER_MODES.has(requested) ? FEATURES.find((f) => f.id === requested) : undefined;
  if (!feature) return { mode: 'LAYERED', fallbackReason: `unknown render mode "${requested}"` };
  if (feature.implemented) return { mode: requested as RenderMode, fallbackReason: null };
  return { mode: 'LAYERED', fallbackReason: `${requested} is not implemented (${feature.milestone}): ${feature.note}` };
}
