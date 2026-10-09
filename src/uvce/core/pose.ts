import type { CompiledFrame, CompiledPart, ImageRegion, ManifestIndex } from '../schema/compiled-manifest.ts';
import { ROOT_SOCKET } from '../schema/common.ts';
import type { ResolvedAppearance } from './appearance-resolver.ts';
import type { Direction8 } from './directions.ts';
import type { Rect, Vec2 } from './geometry.ts';
import { unionRect } from './geometry.ts';
import { type Issue, issue } from './issues.ts';

export interface PoseRequest {
  clipId: string;
  direction: Direction8;
  frameIndex: number;
  /** Runtime layer toggles (debug). Hidden layers are skipped, order of the rest is unchanged. */
  hiddenLayers?: ReadonlySet<string>;
}

export interface ResolvedLayer {
  layer: string;
  slot: string;
  itemId: string;
  image: string;
  region: ImageRegion;
  /** Integer rect on the canonical canvas (foot pivot = rig.footPivot) where the image is drawn 1:1. */
  dest: Rect;
  /** Painter index inside the character (0 = farthest back). */
  order: number;
}

export interface ResolvedPose {
  clipId: string;
  direction: Direction8;
  frameIndex: number;
  /** Absolute socket positions for this frame, including "root" (= foot pivot). */
  sockets: Readonly<Record<string, Vec2>>;
  layers: readonly ResolvedLayer[];
  /** Union of all layer rects, or null when nothing is drawn. */
  bounds: Rect | null;
  issues: Issue[];
}

/** Clip frames win over static frames; absent => the part is not drawn in this direction. */
export function partFrame(part: CompiledPart, clipId: string, direction: Direction8, frameIndex: number): CompiledFrame | undefined {
  const clipFrames = part.clips?.[clipId]?.[direction];
  if (clipFrames) return clipFrames[frameIndex];
  return part.static?.[direction];
}

/**
 * Resolves one character pose into ordered, pixel-aligned layers. Pure and renderer-independent: the WebGL
 * renderer and the CPU reference compositor consume the same output, which is what makes them comparable.
 */
export function resolvePose(index: ManifestIndex, appearance: ResolvedAppearance, request: PoseRequest): ResolvedPose {
  const issues: Issue[] = [];
  const { rig } = appearance;
  const { clipId, direction } = request;
  const clip = index.clips.get(clipId);
  if (!clip) {
    issues.push(issue('error', 'pose.clip', '/clipId', `unknown clip "${clipId}"`));
    return { clipId, direction, frameIndex: 0, sockets: { [ROOT_SOCKET]: rig.footPivot }, layers: [], bounds: null, issues };
  }
  const frameIndex = Math.min(Math.max(0, Math.trunc(request.frameIndex)), clip.frameDurationsMs.length - 1);
  const sockets: Record<string, Vec2> = { ...rig.restSockets[direction] };
  const driver = appearance.layers.get(rig.socketDriverLayer);
  const driverFrame = driver ? partFrame(driver.part, clipId, direction, frameIndex) : undefined;
  if (driverFrame?.sockets) Object.assign(sockets, driverFrame.sockets);
  else issues.push(issue('warning', 'pose.rest-sockets', '/sockets', `no driver frame for ${clipId}/${direction}/${frameIndex}; using rest sockets`));
  sockets[ROOT_SOCKET] = rig.footPivot;

  const layers: ResolvedLayer[] = [];
  let bounds: Rect | null = null;
  for (const layer of rig.layerOrder[direction]) {
    if (request.hiddenLayers?.has(layer)) continue;
    const source = appearance.layers.get(layer);
    if (!source) continue;
    const frame = partFrame(source.part, clipId, direction, frameIndex);
    if (!frame) continue;
    const socket = sockets[source.part.attach];
    if (!socket) {
      issues.push(issue('error', 'pose.socket', `/layers/${layer}`, `socket "${source.part.attach}" unavailable; layer skipped`));
      continue;
    }
    const region = index.manifest.images[frame.image];
    if (!region) {
      issues.push(issue('error', 'pose.image', `/layers/${layer}`, `image ${frame.image} missing from manifest`));
      continue;
    }
    const dest: Rect = {
      x: frame.trim.x + socket.x - frame.anchor.x,
      y: frame.trim.y + socket.y - frame.anchor.y,
      w: frame.trim.w,
      h: frame.trim.h,
    };
    bounds = unionRect(bounds, dest);
    layers.push({ layer, slot: source.slot.slot, itemId: source.slot.item.id, image: frame.image, region, dest, order: layers.length });
  }
  return { clipId, direction, frameIndex, sockets, layers, bounds, issues };
}
