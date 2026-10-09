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
import type { PageHandle, ResidencyView } from '../../assets/source-registry.ts';
import type { AppearanceDefinition } from '../../schema/appearance.ts';
import type { ManifestIndex } from '../../schema/compiled-manifest.ts';
import type { CharacterInstance, CharacterRenderMetrics, ICharacterRenderer } from '../contracts.ts';
import { MAX_COMPOSITE_LAYERS, createCompositeMaterial } from './composite-material.ts';
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
  /** LAYERED (default): one quad per layer. SHADER: one composited quad per character, LAYERED fallback per character. */
  mode?: 'LAYERED' | 'SHADER';
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
}

interface CharacterRecord extends Rankable {
  entityId: string;
  shadow: THREE.Mesh | null;
  layers: LayerMesh[];
  composite: CompositeQuad | null;
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
}

const SHADOW_RADIUS = 0.36;

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
  readonly mode: 'LAYERED' | 'SHADER';
  private readonly pixelsPerUnit: number;
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
  private metrics: CharacterRenderMetrics;

  constructor(options: LayeredRendererOptions) {
    this.index = options.index;
    this.registry = options.registry;
    this.camera = options.camera;
    this.depthBias = options.depthBias ?? 0.1;
    this.margin = options.filterMargin ?? 1;
    this.shadowsEnabled = options.shadows ?? true;
    this.mode = options.mode ?? 'LAYERED';
    this.pixelsPerUnit = this.index.manifest.rigs[0]?.pixelsPerWorldUnit ?? 128;
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

  private hideRecord(rec: CharacterRecord): void {
    rec.group.visible = false;
    if (rec.shadow) rec.shadow.visible = false;
  }

  private destroyRecord(rec: CharacterRecord): void {
    this.pin(rec, NO_ITEMS);
    for (const l of rec.layers) l.mesh.material.dispose();
    rec.composite?.mesh.material.dispose();
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
   * SHADER mode: binds every drawable layer to one composite quad. Returns false (caller uses LAYERED for this
   * character) when the composite cannot represent the pose exactly: a FAILED page (its placeholder is drawn by the
   * LAYERED path) or more layers than composite slots.
   */
  private applyComposite(rec: CharacterRecord, rig: { footPivot: { x: number; y: number } }, bindings: LayerBinding[]): boolean {
    if (bindings.length === 0 || bindings.length > MAX_COMPOSITE_LAYERS || bindings.some((b) => b.texture === null)) return false;
    const cq = this.compositeQuad(rec);
    const u = cq.mesh.material.uniforms;
    const quads = u.uQuad?.value as THREE.Vector4[];
    const uvs = u.uUv?.value as THREE.Vector4[];
    const m = this.margin;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    cq.handles = [];
    // Back to front: the order LAYERED quads are drawn in.
    const ordered = [...bindings].sort((a, b) => a.layer.order - b.layer.order);
    ordered.forEach((b, i) => {
      const { layer, page } = b;
      const qx = layer.dest.x - rig.footPivot.x - m;
      const qy = layer.dest.y - rig.footPivot.y - m;
      const qw = layer.dest.w + 2 * m;
      const qh = layer.dest.h + 2 * m;
      (quads[i] as THREE.Vector4).set(qx, qy, qw, qh);
      (uvs[i] as THREE.Vector4).set((layer.region.x - m) / page.width, 1 - (layer.region.y - m) / page.height, (layer.region.x + layer.region.w + m) / page.width, 1 - (layer.region.y + layer.region.h + m) / page.height);
      (u[`uMap${i}`] as THREE.IUniform).value = b.texture;
      cq.handles.push(b.handle as PageHandle);
      x0 = Math.min(x0, qx);
      y0 = Math.min(y0, qy);
      x1 = Math.max(x1, qx + qw);
      y1 = Math.max(y1, qy + qh);
    });
    for (let i = ordered.length; i < MAX_COMPOSITE_LAYERS; i++) (u[`uMap${i}`] as THREE.IUniform).value = this.missing;
    (u.uCount as THREE.IUniform).value = ordered.length;
    (u.uBounds?.value as THREE.Vector4).set(x0, y0, x1 - x0, y1 - y0);
    cq.mesh.visible = true;
    for (const l of rec.layers) l.mesh.visible = false;
    return true;
  }

  /** Binds the pose's layers to resident pages (fresh handles); counts layers still loading or failed. */
  private applyPose(rec: CharacterRecord): void {
    rec.pendingLayers = 0;
    rec.failedLayers = 0;
    rec.auditedEpoch = this.registry.handleEpoch;
    const pose = rec.pose;
    const rig = rec.resolved?.rig;
    if (!pose || !rig) return;
    const bindings: LayerBinding[] = [];
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
      bindings.push({ layer, page, handle: texture ? handle : null, texture });
    }
    if (this.mode === 'SHADER' && this.applyComposite(rec, rig, bindings)) return;
    if (rec.composite) rec.composite.mesh.visible = false;
    const m = this.margin;
    let drawn = 0;
    for (const { layer, page, handle, texture } of bindings) {
      const lm = this.layerMesh(rec, drawn);
      lm.handle = texture ? handle : null;
      const u = lm.mesh.material.uniforms;
      (u.uQuad?.value as THREE.Vector4).set(layer.dest.x - rig.footPivot.x - m, layer.dest.y - rig.footPivot.y - m, layer.dest.w + 2 * m, layer.dest.h + 2 * m);
      if (texture) {
        (u.uUvRect?.value as THREE.Vector4).set(
          (layer.region.x - m) / page.width,
          1 - (layer.region.y - m) / page.height,
          (layer.region.x + layer.region.w + m) / page.width,
          1 - (layer.region.y + layer.region.h + m) / page.height,
        );
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
      const frameIndex = clip ? sampleClip(clip, clipTimeAt(c.animation, nowMs)).frameIndex : 0;
      // The registry revision changes on every residency change (upload, eviction, failure, context loss), so a
      // pose bound under the current revision has valid handles and up-to-date pending/failed counts.
      const key = `${rec.appearanceKey}|${c.animation.clipId}|${direction}|${frameIndex}|${this.hiddenRevision}|${this.registry.revision}`;
      if (key !== rec.poseKey) {
        rec.pose = resolvePose(this.index, rec.resolved, { clipId: c.animation.clipId, direction, frameIndex, hiddenLayers: this.hiddenLayers });
        rec.poseKey = key;
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
    for (const rec of visible) {
      for (const l of rec.layers) if (l.mesh.visible) layers++;
      if (rec.composite?.mesh.visible) {
        layers += rec.composite.handles.length;
        composites++;
      }
    }
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
      prepareCpuMs: performance.now() - t0,
      staleBindings,
      compositedCharacters: composites,
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
