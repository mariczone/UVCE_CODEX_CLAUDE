/**
 * Runtime contracts (adapted from blueprint §6). World state, appearance, animation and GPU resources stay
 * separate: a CharacterInstance never references textures, UVs or atlas slots.
 */
import type { AnimationState } from '../core/animation.ts';
import type { Rect, Size, Vec3 } from '../core/geometry.ts';
import type { AppearanceDefinition } from '../schema/appearance.ts';

export type RenderMode = 'LAYERED' | 'SHADER' | 'PARTIAL_CACHE' | 'FULL_CACHE';
export type RendererBackend = 'webgl2' | 'webgpu';

export interface CharacterInstance {
  /** Runtime reference only; never part of an appearance/cache key. */
  entityId: string;
  /** Ground-contact (foot) position in world units, Y up. */
  position: Vec3;
  /** Compass yaw, see core/directions.ts. */
  facingYaw: number;
  appearance: AppearanceDefinition;
  animation: AnimationState;
  visible: boolean;
}

export interface CharacterRenderMetrics {
  backend: RendererBackend;
  mode: RenderMode;
  visibleCharacters: number;
  culledCharacters: number;
  visibleLayers: number;
  /** Layers not drawn yet because their page is still loading. */
  pendingLayers: number;
  /** Layers drawn with the missing-asset placeholder. */
  failedLayers: number;
  uniqueVisibleAppearances: number;
  /** Pose re-resolutions this frame (frame/direction/appearance changes). */
  poseUpdates: number;
  /** CPU time of prepareFrame (resolve, update, cull, sort) in ms. */
  prepareCpuMs: number;
  /** Filled by the frame loop from renderer stats when available; null = not measured. */
  drawCalls: number | null;
  gpuFrameMs: number | null;
  sourceEstimatedBytes: number;
  compositeEstimatedBytes: number;
  pendingDownloads: number;
  cacheHitRatio: number | null;
  cacheEvictions: number;
  /** Visible layers caught holding a texture their residency handle no longer resolves to (must be 0). */
  staleBindings: number;
  /** SHADER mode: visible characters drawn as one composited quad (the rest fell back to LAYERED). */
  compositedCharacters: number;
  /** FULL_CACHE mode: visible characters drawn from a baked frame-cache cell. */
  cachedCharacters: number;
  /** FULL_CACHE mode: frames baked into the cache this frame. */
  frameCacheBakes: number;
  /** FULL_CACHE mode: cache cells reassigned to another frame since start (LRU eviction). */
  frameCacheEvictions: number;
  /** FULL_CACHE thrash breaker: baking is paused because the working set does not fit the cache. */
  frameCachePaused: boolean;
  /** FULL_CACHE: how often the thrash breaker paused baking since start. */
  frameCachePauses: number;
}

/**
 * The character renderer prepares GPU objects INSIDE the shared world scene; the world pass then draws
 * world geometry and characters in one coordinated depth pipeline (no separate character render()).
 */
export interface ICharacterRenderer {
  prepareFrame(characters: readonly CharacterInstance[], nowMs: number): void;
  getMetrics(): CharacterRenderMetrics;
  dispose(): void;
}

/** Reserved for Milestone 2 (virtual atlas / logical sprite handles). Declared, not implemented. */
export interface VirtualSpriteHandle {
  index: number;
  /** Guards recycled slots (ABA). */
  generation: number;
}

export interface PhysicalSpriteRegion {
  atlasClass: string;
  pageId: number;
  uvRect: Rect;
  pixelSize: Size;
  residentVersion: number;
}
