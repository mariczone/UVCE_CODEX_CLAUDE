/**
 * LAYERED render mode (Milestone 0 baseline): every visible layer of every character is one screen-aligned
 * quad. Each character is a THREE.Group whose renderOrder is its painter rank (back-to-front by foot
 * depth); inside the group each layer mesh's renderOrder is its per-direction layer index. three.js sorts
 * transparent objects by (groupOrder, renderOrder, ...), which yields exact per-character painter order
 * without interleaving layers of different characters.
 *
 * SHADER mode (Milestone 3) keeps the same records, sort and residency handling but draws each character as one
 * quad composited in the fragment shader (composite-material.ts). A character whose pose the composite cannot
 * show exactly (a FAILED page, too many layers) falls back to LAYERED quads for that pose only.
 */
import * as THREE from 'three';
import { clipTimeAt, sampleClip } from '../../core/animation.ts';
import { type ResolvedAppearance, resolveAppearance } from '../../core/appearance-resolver.ts';
import { appearanceKey } from '../../core/cache-keys.ts';
import { type Direction8, type ViewerPose, spriteDirection, viewYawForCharacter } from '../../core/directions.ts';
import type { Issue } from '../../core/issues.ts';
import { type ResolvedPose, resolvePose } from '../../core/pose.ts';
import { rotatedBounds } from '../../core/secondary-motion.ts';
import type { PageHandle, ResidencyView } from '../../assets/source-registry.ts';
import type { AppearanceDefinition } from '../../schema/appearance.ts';
import type { ManifestIndex } from '../../schema/compiled-manifest.ts';
import type { CharacterInstance, CharacterRenderMetrics, ICharacterRenderer } from '../contracts.ts';
import { type CompositeLayerInput, MAX_COMPOSITE_LAYERS, createCompositeMaterial, layerRotationUniform, layerUvRect, setCompositeLayers } from './composite-material.ts';
import { type BakeJob, type CacheCell, CANVAS_SIZE, CELL_OFFSET, type FrameCacheBackend } from './frame-cache.ts';
import { AnimationBudget, DEFAULT_LOD_POLICY, type LodPolicy, lodLevelFor, lodPhaseMs, throttledTimeMs } from '../lod.ts';
import { type PlannerDecision, type PlannerGroupRef, RenderPlanner } from '../planner.ts';
import { createMissingTexture, createSpriteLayerMaterial, createUnitQuadGeometry } from './sprite-material.ts';

export interface LayeredRendererOptions {
  index: ManifestIndex;
  registry: ResidencyView<THREE.Texture>;
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** World units the sprite depth is pulled toward the camera (feet vs ground). */
  depthBias?: number;
  /** Texels of transparent gutter included around each quad (<= compiler padding) for filtering. */
  filterMargin?: number;
  shadows?: boolean;
  /**
   * LAYERED (default): one quad per layer. SHADER: one composited quad per character. FULL_CACHE: one quad sampling a
   * baked frame from the frame cache. Each falls back per character/pose: FULL_CACHE -> SHADER -> LAYERED.
   */
  /** AUTO: SHADER by default, FULL_CACHE per appearance group when the planner measures enough frame reuse. */
  mode?: 'LAYERED' | 'SHADER' | 'FULL_CACHE' | 'AUTO';
  /** Required for FULL_CACHE (without it FULL_CACHE behaves like SHADER). */
  frameCache?: FrameCacheBackend | null;
  /** FULL_CACHE: at most this many frames are baked per frame (bounds bake hitches); the rest fall back. */
  bakeBudget?: number;
  /**
   * Milestone 4 projected-size LOD (null/absent = off): small characters sample their clip at a lower visual rate,
   * and `animationBudget` caps animation-only pose updates per frame below the finest level. Simulation untouched.
   */
  lod?: { policy?: LodPolicy; animationBudget?: number | null } | null;
  /** Viewport height in CSS px for projected-size LOD (setViewportHeight updates it). */
  viewportHeightPx?: number;
}

/** SHADER-mode quad of one character: all visible layers sampled and composited in one draw. */
interface CompositeQuad {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Handle bound to slot i (uniform uMap<i>); length = layers in use. */
  handles: PageHandle[];
}

interface LayerMesh {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Generation-checked residency handle of the bound page (null for the missing-asset placeholder). */
  handle: PageHandle | null;
}

/** One drawable layer of the current pose: a resident page (texture + handle) or a FAILED one (both null). */
interface LayerBinding {
  layer: ResolvedPose['layers'][number];
  page: { width: number; height: number };
  handle: PageHandle | null;
  texture: THREE.Texture | null;
}

/** Anything ranked by the painter sort: characters (by feet) and registered transparent objects (by anchor). */
interface Rankable {
  key: string;
  group: THREE.Group;
  depth: number;
  rank: number;
}

interface SortedObject extends Rankable {
  anchor: THREE.Object3D;
}

interface ResolvedEntry {
  resolved: ResolvedAppearance | null;
  key: string;
  issues: Issue[];
  /** Item ids of the appearance; one frozen array per appearance object, so identity means "same items". */
  items: readonly string[];
}

const NO_ITEMS: readonly string[] = Object.freeze([]);

/** Farthest first; the key breaks ties so equal depths never flicker. */
const byPainterOrder = (a: Rankable, b: Rankable): number => b.depth - a.depth || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export interface CharacterDebugInfo {
  entityId: string;
  appearanceKey: string;
  appearanceIssues: Issue[];
  resolved: ResolvedAppearance | null;
  pose: ResolvedPose | null;
  direction: Direction8 | null;
  depth: number;
  rank: number;
  visible: boolean;
  position: THREE.Vector3;
  /** Projected-size LOD level (index into the policy; -1 = LOD off or not assessed yet). */
  lodLevel: number;
  /** Layers of the current pose still waiting for their page. */
  pendingLayers: number;
}

interface CharacterRecord extends Rankable {
  entityId: string;
  shadow: THREE.Mesh | null;
  layers: LayerMesh[];
  composite: CompositeQuad | null;
  /** Drawable layers of the current pose (resident or FAILED), collected when the pose key changes. */
  bindings: LayerBinding[];
  /** FULL_CACHE: the cell this character draws, valid while the cell still holds `key` at `generation`. */
  cached: { key: string; cell: CacheCell; generation: number } | null;
  cachedMesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null;
  /** FULL_CACHE: the current pose is shown directly (SHADER/LAYERED) because it is not cached. */
  directShown: boolean;
  /** Frame-cache key of the current pose (appearance|clip|direction|frame|debug toggles), built on pose change. */
  frameKey: string;
  /** AUTO: the group/frame this character is registered with in the planner (null = not registered). */
  plannerEntry: { group: string; key: string; ref: PlannerGroupRef } | null;
  appearanceRef: AppearanceDefinition | null;
  resolved: ResolvedAppearance | null;
  appearanceKey: string;
  appearanceIssues: Issue[];
  items: readonly string[];
  poseKey: string;
  pose: ResolvedPose | null;
  direction: Direction8 | null;
  seenFrame: number;
  /** Layers of the current pose waiting for a page / drawn as missing placeholders; valid while poseKey holds. */
  pendingLayers: number;
  failedLayers: number;
  /** registry.handleEpoch when the layer handles were last bound or audited: unchanged epoch => all still valid. */
  auditedEpoch: number;
  /** Items pinned in the registry because this character is visible (shared array, compared by identity). */
  pinned: readonly string[];
  /** Items prefetched since the character was culled: one prefetch per culling, not one per frame. */
  prefetched: readonly string[] | null;
  /** LOD: current level (-1 = not assessed), stagger phase, frame shown, consecutive budget deferrals. */
  lodLevel: number;
  lodPhaseMs: number;
  shownFrame: number;
  deferFrames: number;
  /** Pose key without the animation frame: equal => only the frame would change (budget-eligible). */
  poseBase: string;
}

const SHADOW_RADIUS = 0.36;
const CACHE_WINDOW_FRAMES = 60;
const CACHE_MIN_HIT_RATIO = 0.6;
const CACHE_PAUSE_FRAMES = 240;

function createShadowTexture(): THREE.DataTexture {
  const n = 64;
  const d = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5;
      const dy = (y + 0.5) / n - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const a = r >= 1 ? 0 : Math.round(255 * (1 - r * r) * (1 - r * r));
      d.set([0, 0, 0, a], (y * n + x) * 4);
    }
  }
  const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export class LayeredCharacterRenderer implements ICharacterRenderer {
  readonly root = new THREE.Group();
  readonly shadowRoot = new THREE.Group();
  private readonly index: ManifestIndex;
  private readonly registry: ResidencyView<THREE.Texture>;
  private camera: THREE.Camera;
  private readonly depthBias: number;
  private readonly margin: number;
  private readonly shadowsEnabled: boolean;
  readonly mode: 'LAYERED' | 'SHADER' | 'FULL_CACHE' | 'AUTO';
  /** AUTO mode: chooses SHADER or FULL_CACHE per appearance group (null in other modes). */
  readonly planner: RenderPlanner | null;
  /** AUTO mode: the planner's most recent switches (debug UI). */
  lastPlannerDecisions: PlannerDecision[] = [];
  private readonly pixelsPerUnit: number;
  private readonly frameCache: FrameCacheBackend | null;
  private readonly bakeBudget: number;
  private bakeJobs: BakeJob[] = [];
  private contextLost = false;
  /**
   * FULL_CACHE thrash breaker (hysteresis): when a 60-frame window keeps baking (>= 25 % of the budget per frame,
   * or >= 1 bake per 10 lookups) while the hit ratio stays below 60 %, the working set does not fit the cache; baking pauses for CACHE_PAUSE_FRAMES (misses use SHADER, cached
   * cells keep being served), then the cache tries again.
   */
  private readonly cacheWindow = { frames: 0, bakes: 0, hits: 0, lookups: 0 };
  private cachePausedUntil = 0;
  private cachePauses = 0;
  private readonly quad = createUnitQuadGeometry();
  private readonly missing = createMissingTexture();
  private readonly shadowGeometry = new THREE.CircleGeometry(SHADOW_RADIUS, 24).rotateX(-Math.PI / 2);
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private readonly records = new Map<string, CharacterRecord>();
  private readonly resolvedCache = new WeakMap<AppearanceDefinition, ResolvedEntry>();
  private readonly hiddenLayers = new Set<string>();
  /** Transparent world objects ranked in the same painter sort as characters (glass, water, bridges). */
  private readonly sortables = new Map<string, SortedObject>();
  private readonly ranked: Rankable[] = [];
  private hiddenRevision = 0;
  private frame = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
  private readonly tmp = new THREE.Vector3();
  private readonly tmpTop = new THREE.Vector3();
  private readonly lodPolicy: LodPolicy | null;
  private readonly animationBudget: AnimationBudget | null;
  private viewportHeightPx: number;
  /** World height of the rig canvas (projected-size LOD measures the canvas, see render/lod.ts). */
  private readonly canvasWorldHeight: number;
  private metrics: CharacterRenderMetrics;

  constructor(options: LayeredRendererOptions) {
    this.index = options.index;
    this.registry = options.registry;
    this.camera = options.camera;
    this.depthBias = options.depthBias ?? 0.1;
    this.margin = options.filterMargin ?? 1;
    this.shadowsEnabled = options.shadows ?? true;
    this.frameCache = options.frameCache ?? null;
    const needsCache = options.mode === 'FULL_CACHE' || options.mode === 'AUTO';
    this.mode = needsCache && !this.frameCache ? 'SHADER' : (options.mode ?? 'LAYERED');
    this.planner = this.mode === 'AUTO' && this.frameCache ? new RenderPlanner({ capacityCells: this.frameCache.allocator.capacityCells }) : null;
    this.bakeBudget = options.bakeBudget ?? 24;
    this.pixelsPerUnit = this.index.manifest.rigs[0]?.pixelsPerWorldUnit ?? 128;
    this.canvasWorldHeight = (this.index.manifest.rigs[0]?.canonicalCanvas.height ?? 256) / this.pixelsPerUnit;
    this.lodPolicy = options.lod ? (options.lod.policy ?? DEFAULT_LOD_POLICY) : null;
    const budget = options.lod?.animationBudget;
    this.animationBudget = this.lodPolicy && budget !== undefined && budget !== null ? new AnimationBudget(budget) : null;
    this.viewportHeightPx = options.viewportHeightPx ?? 720;
    this.root.name = 'uvce-characters';
    this.shadowRoot.name = 'uvce-shadows';
    // Shadows are ground decals: drawn after opaque world, before every character.
    this.shadowRoot.renderOrder = -1;
    this.shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, map: createShadowTexture(), transparent: true, opacity: 0.42, depthWrite: false });
    this.shadowMaterial.polygonOffset = true;
    this.shadowMaterial.polygonOffsetFactor = -1;
    this.shadowMaterial.polygonOffsetUnits = -1;
    options.scene.add(this.shadowRoot, this.root);
    this.metrics = this.emptyMetrics();
  }

  private emptyMetrics(): CharacterRenderMetrics {
    return {
      backend: 'webgl2',
      mode: this.mode,
      visibleCharacters: 0,
      culledCharacters: 0,
      visibleLayers: 0,
      pendingLayers: 0,
      failedLayers: 0,
      uniqueVisibleAppearances: 0,
      poseUpdates: 0,
      prepareCpuMs: 0,
      drawCalls: null,
      gpuFrameMs: null,
      sourceEstimatedBytes: 0,
      compositeEstimatedBytes: 0,
      pendingDownloads: 0,
      cacheHitRatio: null,
      cacheEvictions: 0,
      staleBindings: 0,
      compositedCharacters: 0,
      cachedCharacters: 0,
      frameCacheBakes: 0,
      frameCacheEvictions: 0,
      frameCachePaused: false,
      frameCachePauses: 0,
      plannerCachedGroups: 0,
      plannerGroups: 0,
      plannerSwitches: 0,
      lodEnabled: false,
      lodLevels: [0, 0, 0, 0],
      animationDeferred: 0,
    };
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  setLayerHidden(layer: string, hidden: boolean): void {
    const had = this.hiddenLayers.has(layer);
    if (hidden === had) return;
    if (hidden) this.hiddenLayers.add(layer);
    else this.hiddenLayers.delete(layer);
    this.hiddenRevision++;
  }

  /**
   * Registers a transparent world object for painter sorting with the characters. Its depth is the view depth of
   * its world position (use the ground-contact point for upright objects, like character feet). Opaque objects
   * do not need this: they are depth-tested in the opaque pass.
   */
  addSortedObject(id: string, object: THREE.Object3D): void {
    this.removeSortedObject(id);
    const group = new THREE.Group();
    group.name = `sorted:${id}`;
    group.add(object);
    this.root.add(group);
    this.sortables.set(id, { key: `obj:${id}`, group, anchor: object, depth: 0, rank: 0 });
  }

  removeSortedObject(id: string): void {
    const s = this.sortables.get(id);
    if (!s) return;
    this.root.remove(s.group);
    this.sortables.delete(id);
  }

  get hidden(): ReadonlySet<string> {
    return this.hiddenLayers;
  }

  private resolve(appearance: AppearanceDefinition): ResolvedEntry {
    const cached = this.resolvedCache.get(appearance);
    if (cached) return cached;
    const r = resolveAppearance(this.index, appearance);
    const entry: ResolvedEntry = r.ok
      ? { resolved: r.value, key: appearanceKey(r.value), issues: r.value.issues, items: Object.freeze(r.value.slots.map((s) => s.item.id)) }
      : { resolved: null, key: 'unresolvable', issues: r.issues, items: NO_ITEMS };
    this.resolvedCache.set(appearance, entry);
    return entry;
  }

  private createRecord(entityId: string): CharacterRecord {
    const group = new THREE.Group();
    group.name = `character:${entityId}`;
    this.root.add(group);
    let shadow: THREE.Mesh | null = null;
    if (this.shadowsEnabled) {
      shadow = new THREE.Mesh(this.shadowGeometry, this.shadowMaterial);
      shadow.name = `shadow:${entityId}`;
      this.shadowRoot.add(shadow);
    }
    const rec: CharacterRecord = {
      key: entityId,
      entityId,
      group,
      shadow,
      layers: [],
      composite: null,
      bindings: [],
      cached: null,
      cachedMesh: null,
      directShown: false,
      frameKey: '',
      plannerEntry: null,
      appearanceRef: null,
      resolved: null,
      appearanceKey: '',
      appearanceIssues: [],
      items: NO_ITEMS,
      poseKey: '',
      pose: null,
      direction: null,
      seenFrame: 0,
      pendingLayers: 0,
      failedLayers: 0,
      auditedEpoch: -1,
      depth: 0,
      rank: 0,
      pinned: NO_ITEMS,
      prefetched: null,
      lodLevel: -1,
      lodPhaseMs: lodPhaseMs(entityId),
      shownFrame: -1,
      deferFrames: 0,
      poseBase: '',
    };
    this.records.set(entityId, rec);
    return rec;
  }

  /** Pins exactly `items` for this character, releasing what it no longer needs. O(1) while unchanged. */
  private pin(rec: CharacterRecord, items: readonly string[]): void {
    const previous = rec.pinned;
    if (previous === items) return;
    for (const id of items) if (!previous.includes(id)) this.registry.acquireItem(id);
    for (const id of previous) if (!items.includes(id)) this.registry.releaseItem(id);
    rec.pinned = items;
  }

  /** AUTO: keeps the planner's view of which frames are on screen in sync (only on change). */
  private plannerShow(rec: CharacterRecord, show: boolean): void {
    const planner = this.planner;
    if (!planner) return;
    const e = rec.plannerEntry;
    if (show && e && e.group === rec.appearanceKey && e.key === rec.frameKey) return;
    if (e) planner.leave(e.group, e.key);
    rec.plannerEntry = null;
    if (show) rec.plannerEntry = { group: rec.appearanceKey, key: rec.frameKey, ref: planner.enter(rec.appearanceKey, rec.frameKey) };
  }

  private hideRecord(rec: CharacterRecord): void {
    this.plannerShow(rec, false);
    rec.group.visible = false;
    if (rec.shadow) rec.shadow.visible = false;
  }

  private destroyRecord(rec: CharacterRecord): void {
    this.plannerShow(rec, false);
    this.pin(rec, NO_ITEMS);
    for (const l of rec.layers) l.mesh.material.dispose();
    rec.composite?.mesh.material.dispose();
    rec.cachedMesh?.material.dispose();
    this.root.remove(rec.group);
    if (rec.shadow) this.shadowRoot.remove(rec.shadow);
    this.records.delete(rec.entityId);
  }

  private layerMesh(rec: CharacterRecord, i: number): LayerMesh {
    let lm = rec.layers[i];
    if (!lm) {
      const mesh = new THREE.Mesh(this.quad, createSpriteLayerMaterial({ pixelsPerUnit: this.index.manifest.rigs[0]?.pixelsPerWorldUnit ?? 128, depthBias: this.depthBias }));
      mesh.frustumCulled = false; // the quad is expanded in the shader; culling is per character
      mesh.matrixAutoUpdate = false;
      rec.group.add(mesh);
      lm = { mesh, handle: null };
      rec.layers[i] = lm;
    }
    return lm;
  }

  private compositeQuad(rec: CharacterRecord): CompositeQuad {
    if (!rec.composite) {
      const mesh = new THREE.Mesh(this.quad, createCompositeMaterial({ pixelsPerUnit: this.pixelsPerUnit, depthBias: this.depthBias, placeholder: this.missing }));
      mesh.name = `composite:${rec.entityId}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      rec.group.add(mesh);
      rec.composite = { mesh, handles: [] };
    }
    return rec.composite;
  }

  /**
   * SHADER: binds every drawable layer to one composite quad. Returns false (caller uses LAYERED for this pose) when
   * the composite cannot represent the pose exactly: a FAILED page (its placeholder is drawn by the LAYERED path) or
   * more layers than composite slots.
   */
  private applyComposite(rec: CharacterRecord, rig: { footPivot: { x: number; y: number } }, bindings: LayerBinding[]): boolean {
    if (bindings.length === 0 || bindings.length > MAX_COMPOSITE_LAYERS || bindings.some((b) => b.texture === null)) return false;
    const cq = this.compositeQuad(rec);
    const u = cq.mesh.material.uniforms;
    const b = setCompositeLayers(u, bindings as CompositeLayerInput[], rig.footPivot, this.margin, this.missing);
    (u.uBounds?.value as THREE.Vector4).set(b.x, b.y, b.w, b.h);
    cq.handles = [...bindings].sort((x, y) => x.layer.order - y.layer.order).map((x) => x.handle as PageHandle);
    cq.mesh.visible = true;
    for (const l of rec.layers) l.mesh.visible = false;
    if (rec.cachedMesh) rec.cachedMesh.visible = false;
    return true;
  }

  /** Collects the pose's layers as resident (fresh handle) or FAILED bindings; counts layers still loading. */
  private collectBindings(rec: CharacterRecord): void {
    rec.pendingLayers = 0;
    rec.failedLayers = 0;
    rec.bindings = [];
    rec.auditedEpoch = this.registry.handleEpoch;
    const pose = rec.pose;
    if (!pose || !rec.resolved) return;
    for (const layer of pose.layers) {
      const page = this.index.pages.get(layer.region.page);
      if (!page) continue;
      const handle = this.registry.handleFor(page.id);
      const texture = handle ? this.registry.resolve(handle) : null;
      if (!texture && this.registry.pageState(page.id) !== 'FAILED') {
        rec.pendingLayers++;
        continue;
      }
      if (!texture) rec.failedLayers++;
      rec.bindings.push({ layer, page, handle: texture ? handle : null, texture });
    }
  }

  /** Shows the current bindings without the frame cache: SHADER composite if enabled and exact, else LAYERED quads. */
  private presentDirect(rec: CharacterRecord): void {
    const rig = rec.resolved?.rig;
    if (rec.cachedMesh) rec.cachedMesh.visible = false;
    if (!rig) return;
    if (this.mode !== 'LAYERED' && this.applyComposite(rec, rig, rec.bindings)) return;
    if (rec.composite) rec.composite.mesh.visible = false;
    const m = this.margin;
    let drawn = 0;
    for (const { layer, page, handle, texture } of rec.bindings) {
      const lm = this.layerMesh(rec, drawn);
      lm.handle = texture ? handle : null;
      const u = lm.mesh.material.uniforms;
      (u.uQuad?.value as THREE.Vector4).set(layer.dest.x - rig.footPivot.x - m, layer.dest.y - rig.footPivot.y - m, layer.dest.w + 2 * m, layer.dest.h + 2 * m);
      layerRotationUniform(layer.rotation, rig.footPivot, u.uRot?.value as THREE.Vector4);
      const quad = u.uQuad?.value as THREE.Vector4;
      if (layer.rotation) {
        const fp = rig.footPivot;
        const box = rotatedBounds({ x: quad.x + fp.x, y: quad.y + fp.y, w: quad.z, h: quad.w }, layer.rotation);
        (u.uBox?.value as THREE.Vector4).set(box.x - fp.x, box.y - fp.y, box.w, box.h);
      } else (u.uBox?.value as THREE.Vector4).copy(quad);
      if (texture) {
        layerUvRect(layer, page, m, u.uUvRect?.value as THREE.Vector4);
        (u.uMap as THREE.IUniform).value = texture;
        (u.uOpacity as THREE.IUniform).value = 1;
      } else {
        (u.uUvRect?.value as THREE.Vector4).set(0, 0, (layer.dest.w + 2 * m) / 8, (layer.dest.h + 2 * m) / 8);
        (u.uMap as THREE.IUniform).value = this.missing;
        (u.uOpacity as THREE.IUniform).value = 0.75;
      }
      lm.mesh.renderOrder = layer.order;
      lm.mesh.visible = true;
      drawn++;
    }
    for (let i = drawn; i < rec.layers.length; i++) (rec.layers[i] as LayerMesh).mesh.visible = false;
  }

  /** Binds the pose's layers (fresh handles) and shows them; in FULL_CACHE mode presentCached() decides each frame. */
  private applyPose(rec: CharacterRecord): void {
    this.collectBindings(rec);
    rec.cached = null; // a new pose needs its own cache cell
    rec.directShown = false; // ...and whatever is shown directly is the previous pose: present again
    if (!this.usesCache(rec)) {
      this.presentDirect(rec);
      rec.directShown = true;
    }
  }

  /** FULL_CACHE: always; AUTO: when the planner put this character's appearance group on the cache. */
  private usesCache(rec: CharacterRecord): boolean {
    if (this.mode === 'FULL_CACHE') return true;
    if (this.mode !== 'AUTO' || !this.planner) return false;
    const e = rec.plannerEntry; // the group reference saves a map lookup per character per frame
    return e !== null && e.group === rec.appearanceKey ? this.planner.isCachedRef(e.ref) : this.planner.isCached(rec.appearanceKey);
  }

  private cachedQuad(rec: CharacterRecord): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
    if (!rec.cachedMesh) {
      const mesh = new THREE.Mesh(this.quad, createSpriteLayerMaterial({ pixelsPerUnit: this.pixelsPerUnit, depthBias: this.depthBias }));
      mesh.name = `cached:${rec.entityId}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      rec.group.add(mesh);
      rec.cachedMesh = mesh;
    }
    return rec.cachedMesh;
  }

  /**
   * FULL_CACHE, every frame: keep drawing a still-valid cell; else bind the cell already holding this frame; else bake
   * it this frame (budget permitting, all layers resident, bounds inside the cell); else show the pose directly.
   */
  private presentCached(rec: CharacterRecord, key: string, counters: { hits: number; misses: number }): void {
    const cache = this.frameCache;
    const rig = rec.resolved?.rig;
    const pose = rec.pose;
    if (!cache || !rig || !pose) return;
    const alloc = cache.allocator;
    const held = rec.cached;
    if (held && held.key === key && alloc.isValid(held.cell, key, held.generation)) {
      alloc.touch(held.cell);
      counters.hits++;
      return;
    }
    let cell = this.contextLost ? null : alloc.lookup(key);
    if (cell) counters.hits++;
    else {
      counters.misses++;
      const b = pose.bounds;
      const m = this.margin;
      const bakeable =
        !this.contextLost &&
        this.frame >= this.cachePausedUntil &&
        // Bake on second sight: one-off frames never displace reused ones. AUTO skips it: the planner promoted this
        // group because its frames were measured to repeat.
        (this.mode === 'AUTO' || alloc.admit(key)) &&
        this.bakeJobs.length < this.bakeBudget &&
        rec.pendingLayers === 0 &&
        rec.failedLayers === 0 &&
        rec.bindings.length > 0 &&
        rec.bindings.length <= MAX_COMPOSITE_LAYERS &&
        b !== null &&
        b.x - m >= -CELL_OFFSET &&
        b.y - m >= -CELL_OFFSET &&
        b.x + b.w + m <= CANVAS_SIZE + CELL_OFFSET &&
        b.y + b.h + m <= CANVAS_SIZE + CELL_OFFSET;
      cell = bakeable ? alloc.allocate(key) : null;
      if (!cell) {
        // Not cached this frame: draw the pose directly (re-bind if the quad shown was a cached frame).
        if (!rec.directShown) this.presentDirect(rec);
        rec.directShown = true;
        rec.cached = null;
        return;
      }
      this.bakeJobs.push({ cell, layers: rec.bindings as CompositeLayerInput[], pivot: rig.footPivot });
    }
    const m = this.margin;
    const b = pose.bounds as NonNullable<typeof pose.bounds>;
    const mesh = this.cachedQuad(rec);
    const u = mesh.material.uniforms;
    (u.uQuad?.value as THREE.Vector4).set(b.x - rig.footPivot.x - m, b.y - rig.footPivot.y - m, b.w + 2 * m, b.h + 2 * m);
    (u.uBox?.value as THREE.Vector4).copy(u.uQuad?.value as THREE.Vector4); // baked frames are never rotated
    cache.uvRect(cell, { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m }, u.uUvRect?.value as THREE.Vector4);
    (u.uMap as THREE.IUniform).value = cache.pageTexture(cell.page);
    (u.uOpacity as THREE.IUniform).value = 1;
    mesh.visible = true;
    if (rec.composite) rec.composite.mesh.visible = false;
    for (const l of rec.layers) l.mesh.visible = false;
    rec.cached = { key, cell, generation: cell.generation };
    rec.directShown = false; // cached quad shown; a later fallback must present directly again
  }

  private updateThrashBreaker(bakes: number, counters: { hits: number; misses: number }): void {
    const w = this.cacheWindow;
    w.frames++;
    w.bakes += bakes;
    w.hits += counters.hits;
    w.lookups += counters.hits + counters.misses;
    if (w.frames < CACHE_WINDOW_FRAMES) return;
    // Sustained baking that the hit ratio does not repay = the working set does not fit. "Sustained": a quarter of
    // the budget every frame (large crowds), or one bake per ten lookups (cell-limited small caches).
    const saturated = w.bakes >= 0.25 * this.bakeBudget * w.frames || w.bakes >= 0.1 * w.lookups;
    const hitRatio = w.lookups > 0 ? w.hits / w.lookups : 1;
    if (saturated && hitRatio < CACHE_MIN_HIT_RATIO) {
      this.cachePausedUntil = this.frame + CACHE_PAUSE_FRAMES;
      this.cachePauses++;
    }
    w.frames = 0;
    w.bakes = 0;
    w.hits = 0;
    w.lookups = 0;
  }

  /** AUTO: latest GPU-pressure reading; the planner only promotes groups to the frame cache under pressure. */
  /** Projected-size LOD needs the viewport height in CSS px (call on resize). */
  setViewportHeight(px: number): void {
    this.viewportHeightPx = Math.max(1, px);
  }

  /** Projected height in CSS px of a character's rig canvas standing at `p` (uses the matrix of the last prepareFrame). */
  projectedHeightPx(p: { x: number; y: number; z: number }): number {
    const footY = this.tmp.set(p.x, p.y, p.z).applyMatrix4(this.projScreen).y;
    const topY = this.tmpTop.set(p.x, p.y + this.canvasWorldHeight, p.z).applyMatrix4(this.projScreen).y;
    return (Math.abs(topY - footY) / 2) * this.viewportHeightPx;
  }

  setGpuPressure(pressure: boolean): void {
    this.planner?.setPressure(pressure);
  }

  /** WebGL context lost/restored: cached frames are gone with their render targets. */
  onContextLost(): void {
    this.contextLost = true;
    this.frameCache?.onContextLost();
    this.planner?.reset(); // the cache is empty: every group starts on SHADER again
    for (const rec of this.records.values()) rec.plannerEntry = null; // reset() forgot every registration
  }

  onContextRestored(): void {
    this.contextLost = false;
    this.frameCache?.onContextRestored();
  }

  prepareFrame(characters: readonly CharacterInstance[], nowMs: number): void {
    const t0 = performance.now();
    this.frame++;
    const camera = this.camera;
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    const camFwd = camera.getWorldDirection(new THREE.Vector3());
    const viewer: ViewerPose = {
      position: { x: camPos.x, y: camPos.y, z: camPos.z },
      forward: { x: camFwd.x, y: camFwd.y, z: camFwd.z },
      orthographic: (camera as THREE.OrthographicCamera).isOrthographicCamera === true,
    };
    const visible: CharacterRecord[] = [];
    let pending = 0;
    let failed = 0;
    let staleBindings = 0;
    let poseUpdates = 0;
    let culled = 0;
    const cacheCounters = { hits: 0, misses: 0 };
    this.frameCache?.allocator.beginFrame(this.frame);
    this.planner?.beginFrame(this.frame);
    this.bakeJobs = [];
    this.animationBudget?.beginFrame();
    const lodLevels = [0, 0, 0, 0];
    const appearances = new Set<string>();
    for (const c of characters) {
      const rec = this.records.get(c.entityId) ?? this.createRecord(c.entityId);
      rec.seenFrame = this.frame;
      if (rec.appearanceRef !== c.appearance) {
        const r = this.resolve(c.appearance);
        rec.appearanceRef = c.appearance;
        rec.resolved = r.resolved;
        rec.appearanceKey = r.key;
        rec.appearanceIssues = r.issues;
        rec.items = r.items;
        rec.poseKey = '';
      }
      if (!c.visible || !rec.resolved) {
        this.pin(rec, NO_ITEMS);
        rec.prefetched = null;
        this.hideRecord(rec);
        continue;
      }
      this.sphere.center.set(c.position.x, c.position.y + 0.9, c.position.z);
      if (!this.frustum.intersectsSphere(this.sphere)) {
        // Off screen: unpin (evictable) but keep warm with a low-priority prefetch, issued once per culling:
        // re-requesting every frame would refetch the pages the budget has just evicted (thrash).
        this.pin(rec, NO_ITEMS);
        if (rec.prefetched !== rec.items) {
          for (const id of rec.items) this.registry.prefetchItem(id);
          rec.prefetched = rec.items;
        }
        culled++;
        this.hideRecord(rec);
        continue;
      }
      this.pin(rec, rec.items);
      rec.prefetched = null;
      const direction = spriteDirection(c.facingYaw, viewYawForCharacter(viewer, c.position));
      const clip = this.index.clips.get(c.animation.clipId);
      let animMs = nowMs;
      if (this.lodPolicy) {
        rec.lodLevel = lodLevelFor(this.projectedHeightPx(c.position), rec.lodLevel, this.lodPolicy);
        animMs = throttledTimeMs(nowMs, this.lodPolicy.levels[rec.lodLevel]?.animationHz ?? null, rec.lodPhaseMs);
        const bucket = Math.min(rec.lodLevel, lodLevels.length - 1);
        lodLevels[bucket] = (lodLevels[bucket] as number) + 1;
      }
      let frameIndex = clip ? sampleClip(clip, clipTimeAt(c.animation, animMs)).frameIndex : 0;
      // The registry revision changes on every residency change (upload, eviction, failure, context loss), so a
      // pose bound under the current revision has valid handles and up-to-date pending/failed counts.
      const base = `${rec.appearanceKey}|${c.animation.clipId}|${direction}|${this.hiddenRevision}|${this.registry.revision}`;
      if (this.animationBudget && rec.lodLevel > 0 && base === rec.poseBase && frameIndex !== rec.shownFrame) {
        // Animation-only change of a non-HIGH character: may wait (bounded) when this frame's budget is spent.
        if (this.animationBudget.admit(rec.deferFrames)) rec.deferFrames = 0;
        else {
          rec.deferFrames++;
          frameIndex = rec.shownFrame;
        }
      }
      const key = `${base}|${frameIndex}`;
      if (key !== rec.poseKey) {
        rec.poseBase = base;
        rec.shownFrame = frameIndex;
        rec.pose = resolvePose(this.index, rec.resolved, { clipId: c.animation.clipId, direction, frameIndex, hiddenLayers: this.hiddenLayers });
        rec.poseKey = key;
        rec.frameKey = `${rec.appearanceKey}|${c.animation.clipId}|${direction}|${frameIndex}|${this.hiddenRevision}`;
        rec.direction = direction;
        this.applyPose(rec);
        poseUpdates++;
      }
      pending += rec.pendingLayers;
      failed += rec.failedLayers;
      // Generation audit (defence in depth, independent of the revision key above): a visible layer may only draw
      // the texture its handle resolves to right now; anything else is hidden and rebound next frame. Handles can
      // only go stale when a slot is freed, so layers are re-checked only after the handle epoch moved.
      if (rec.auditedEpoch !== this.registry.handleEpoch) {
        for (const l of rec.layers) {
          if (!l.handle || !l.mesh.visible) continue;
          if (this.registry.resolve(l.handle) !== l.mesh.material.uniforms.uMap?.value) {
            l.mesh.visible = false;
            rec.poseKey = '';
            staleBindings++;
          }
        }
        const cq = rec.composite;
        if (cq?.mesh.visible && this.compositeStaleSlots(cq) > 0) {
          // The whole composite is one draw: hide it rather than draw any recycled texture.
          staleBindings += this.compositeStaleSlots(cq);
          cq.mesh.visible = false;
          rec.poseKey = '';
        }
        rec.auditedEpoch = this.registry.handleEpoch;
      }
      // Frame key without the registry revision: a baked frame stays valid when source pages are evicted later.
      if (this.mode === 'FULL_CACHE' || this.mode === 'AUTO') {
        const frameKey = rec.frameKey;
        if (this.planner) {
          // Steady frames: two reference checks and a counter; the planner hears about a frame only when it changes.
          const e = rec.plannerEntry;
          if (!e || e.key !== frameKey || e.group !== rec.appearanceKey) this.plannerShow(rec, true);
          this.planner.requestRef((rec.plannerEntry as NonNullable<typeof rec.plannerEntry>).ref);
        }
        if (this.usesCache(rec)) {
          const hitsBefore = cacheCounters.hits;
          this.presentCached(rec, frameKey, cacheCounters);
          this.planner?.recordLookup(rec.appearanceKey, cacheCounters.hits > hitsBefore);
        } else if (rec.cachedMesh?.visible || !rec.directShown) {
          // AUTO: the group was demoted (or never cached) -> make sure the pose is shown directly.
          this.presentDirect(rec);
          rec.directShown = true;
          rec.cached = null;
        }
      }
      rec.group.position.set(c.position.x, c.position.y, c.position.z);
      rec.group.visible = true;
      if (rec.shadow) {
        rec.shadow.position.set(c.position.x, c.position.y + 0.004, c.position.z);
        rec.shadow.visible = true;
      }
      rec.depth = -this.tmp.set(c.position.x, c.position.y, c.position.z).applyMatrix4(camera.matrixWorldInverse).z;
      appearances.add(rec.appearanceKey);
      visible.push(rec);
    }
    for (const rec of this.records.values()) if (rec.seenFrame !== this.frame) this.destroyRecord(rec);
    const bakes = this.bakeJobs.length;
    if (bakes > 0) this.frameCache?.bake(this.bakeJobs); // before this frame renders: cells hold their frames
    this.bakeJobs = [];
    if (this.mode === 'FULL_CACHE' || this.mode === 'AUTO') this.updateThrashBreaker(bakes, cacheCounters);
    if (this.planner) {
      const decisions = this.planner.endFrame();
      if (decisions.length > 0) this.lastPlannerDecisions = decisions;
    }
    // Painter order: one back-to-front sort over characters and transparent objects (renderOrder = rank).
    const ranked = this.ranked;
    ranked.length = 0;
    for (const rec of visible) ranked.push(rec);
    for (const s of this.sortables.values()) {
      s.anchor.updateWorldMatrix(true, false);
      s.depth = -this.tmp.setFromMatrixPosition(s.anchor.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z;
      ranked.push(s);
    }
    ranked.sort(byPainterOrder);
    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i] as Rankable;
      r.rank = i + 1;
      r.group.renderOrder = i + 1;
    }
    let layers = 0;
    let composites = 0;
    let cachedCharacters = 0;
    for (const rec of visible) {
      for (const l of rec.layers) if (l.mesh.visible) layers++;
      if (rec.composite?.mesh.visible) {
        layers += rec.composite.handles.length;
        composites++;
      }
      if (rec.cachedMesh?.visible) {
        layers += rec.bindings.length;
        cachedCharacters++;
      }
    }
    const lookups = cacheCounters.hits + cacheCounters.misses;
    const plannerStats = this.planner?.stats(); // once per frame: it walks every group
    const reg = this.registry.stats();
    this.metrics = {
      ...this.emptyMetrics(),
      visibleCharacters: visible.length,
      culledCharacters: culled,
      visibleLayers: layers,
      pendingLayers: pending,
      failedLayers: failed,
      uniqueVisibleAppearances: appearances.size,
      poseUpdates,
      lodEnabled: this.lodPolicy !== null,
      lodLevels,
      animationDeferred: this.animationBudget?.deferred ?? 0,
      prepareCpuMs: performance.now() - t0,
      staleBindings,
      compositedCharacters: composites,
      cachedCharacters,
      frameCacheBakes: bakes,
      frameCacheEvictions: this.frameCache?.allocator.stats().evictions ?? 0,
      frameCachePaused: (this.mode === 'FULL_CACHE' || this.mode === 'AUTO') && this.frame < this.cachePausedUntil,
      frameCachePauses: this.cachePauses,
      cacheHitRatio: (this.mode === 'FULL_CACHE' || this.mode === 'AUTO') && lookups > 0 ? cacheCounters.hits / lookups : null,
      plannerCachedGroups: plannerStats?.cachedGroups ?? 0,
      plannerGroups: plannerStats?.groups ?? 0,
      plannerSwitches: (plannerStats?.promotions ?? 0) + (plannerStats?.demotions ?? 0),
      compositeEstimatedBytes: (this.frameCache?.allocator.pages ?? 0) * (this.frameCache?.bytesPerPage ?? 0),
      sourceEstimatedBytes: reg.residentBytes,
      pendingDownloads: reg.byState.REQUESTED + reg.byState.FETCHING + reg.byState.RETRY_BACKOFF,
      cacheEvictions: reg.evictions,
    };
  }

  getMetrics(): CharacterRenderMetrics {
    return this.metrics;
  }

  debugInfo(entityId: string): CharacterDebugInfo | null {
    const rec = this.records.get(entityId);
    if (!rec) return null;
    return {
      entityId,
      appearanceKey: rec.appearanceKey,
      appearanceIssues: rec.appearanceIssues,
      resolved: rec.resolved,
      pose: rec.pose,
      direction: rec.direction,
      depth: rec.depth,
      rank: rec.rank,
      visible: rec.group.visible,
      position: rec.group.position.clone(),
      lodLevel: rec.lodLevel,
      pendingLayers: rec.pendingLayers,
    };
  }

  /**
   * Test/debug audit: number of visible layer meshes whose bound texture is not the one their handle resolves to
   * right now (a stale-handle glitch). Must always be 0.
   */
  auditBindings(): { visibleLayers: number; violations: number } {
    let visibleLayers = 0;
    let violations = 0;
    for (const rec of this.records.values()) {
      if (!rec.group.visible) continue;
      for (const l of rec.layers) {
        if (!l.mesh.visible) continue;
        visibleLayers++;
        const bound = l.mesh.material.uniforms.uMap?.value;
        if (l.handle === null) {
          if (bound !== this.missing) violations++;
          continue;
        }
        if (this.registry.resolve(l.handle) !== bound) violations++;
      }
      if (rec.composite?.mesh.visible) {
        visibleLayers += rec.composite.handles.length;
        violations += this.compositeStaleSlots(rec.composite);
      }
      if (rec.cachedMesh?.visible) {
        visibleLayers += rec.bindings.length;
        const c = rec.cached;
        const ok = c !== null && this.frameCache !== null && this.frameCache.allocator.isValid(c.cell, c.key, c.generation) && rec.cachedMesh.material.uniforms.uMap?.value === this.frameCache.pageTexture(c.cell.page);
        if (!ok) violations++;
      }
    }
    return { visibleLayers, violations };
  }

  /** Composite slots whose bound texture is not what their handle resolves to right now (0 = valid). */
  private compositeStaleSlots(cq: CompositeQuad): number {
    const u = cq.mesh.material.uniforms;
    let stale = 0;
    cq.handles.forEach((h, i) => {
      if (this.registry.resolve(h) !== u[`uMap${i}`]?.value) stale++;
    });
    return stale;
  }

  /** Visible characters (and registered transparent objects, prefixed "obj:") in painter order, back to front. */
  paintOrder(): string[] {
    const entries: Rankable[] = [...this.records.values()].filter((r) => r.group.visible);
    for (const s of this.sortables.values()) entries.push(s);
    return entries.sort((a, b) => a.rank - b.rank).map((e) => e.key);
  }

  dispose(): void {
    for (const rec of [...this.records.values()]) this.destroyRecord(rec);
    for (const id of [...this.sortables.keys()]) this.removeSortedObject(id);
    this.root.removeFromParent();
    this.shadowRoot.removeFromParent();
    this.quad.dispose();
    this.missing.dispose();
    this.shadowGeometry.dispose();
    this.shadowMaterial.map?.dispose();
    this.shadowMaterial.dispose();
  }
}
