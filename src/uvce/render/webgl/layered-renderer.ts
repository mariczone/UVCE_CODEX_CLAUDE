/**
 * LAYERED render mode (Milestone 0 baseline): every visible layer of every character is one screen-aligned
 * quad. Each character is a THREE.Group whose renderOrder is its painter rank (back-to-front by foot
 * depth); inside the group each layer mesh's renderOrder is its per-direction layer index. three.js sorts
 * transparent objects by (groupOrder, renderOrder, ...), which yields exact per-character painter order
 * without interleaving layers of different characters.
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
}

interface LayerMesh {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Generation-checked residency handle of the bound page (null for the missing-asset placeholder). */
  handle: PageHandle | null;
  pageId: string | null;
}

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

interface CharacterRecord {
  entityId: string;
  group: THREE.Group;
  shadow: THREE.Mesh | null;
  layers: LayerMesh[];
  appearanceRef: AppearanceDefinition | null;
  resolved: ResolvedAppearance | null;
  appearanceKey: string;
  appearanceIssues: Issue[];
  poseKey: string;
  pose: ResolvedPose | null;
  direction: Direction8 | null;
  seenFrame: number;
  depth: number;
  rank: number;
  /** Items pinned in the registry because this character is visible. */
  pinned: string[];
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
  private readonly quad = createUnitQuadGeometry();
  private readonly missing = createMissingTexture();
  private readonly shadowGeometry = new THREE.CircleGeometry(SHADOW_RADIUS, 24).rotateX(-Math.PI / 2);
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private readonly records = new Map<string, CharacterRecord>();
  private readonly resolvedCache = new WeakMap<AppearanceDefinition, { resolved: ResolvedAppearance | null; key: string; issues: Issue[] }>();
  private readonly hiddenLayers = new Set<string>();
  /** Transparent world objects ranked in the same painter sort as characters (glass, water, bridges). */
  private readonly sortables = new Map<string, { group: THREE.Group; anchor: THREE.Object3D; depth: number; rank: number }>();
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
      mode: 'LAYERED',
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
    this.sortables.set(id, { group, anchor: object, depth: 0, rank: 0 });
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

  private resolve(appearance: AppearanceDefinition): { resolved: ResolvedAppearance | null; key: string; issues: Issue[] } {
    const cached = this.resolvedCache.get(appearance);
    if (cached) return cached;
    const r = resolveAppearance(this.index, appearance);
    const entry = r.ok ? { resolved: r.value, key: appearanceKey(r.value), issues: r.value.issues } : { resolved: null, key: 'unresolvable', issues: r.issues };
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
      entityId,
      group,
      shadow,
      layers: [],
      appearanceRef: null,
      resolved: null,
      appearanceKey: '',
      appearanceIssues: [],
      poseKey: '',
      pose: null,
      direction: null,
      seenFrame: 0,
      depth: 0,
      rank: 0,
      pinned: [],
    };
    this.records.set(entityId, rec);
    return rec;
  }

  /** Pins exactly `items` for this character (visible), releasing what is no longer needed. */
  private pin(rec: CharacterRecord, items: readonly string[]): void {
    for (const id of rec.pinned) if (!items.includes(id)) this.registry.releaseItem(id);
    for (const id of items) if (!rec.pinned.includes(id)) this.registry.acquireItem(id);
    rec.pinned = [...items];
  }

  private destroyRecord(rec: CharacterRecord): void {
    this.pin(rec, []);
    for (const l of rec.layers) l.mesh.material.dispose();
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
      lm = { mesh, handle: null, pageId: null };
      rec.layers[i] = lm;
    }
    return lm;
  }

  private applyPose(rec: CharacterRecord, counters: { pending: number; failed: number; staleBindings: number }): void {
    const pose = rec.pose;
    const rig = rec.resolved?.rig;
    if (!pose || !rig) return;
    const m = this.margin;
    let drawn = 0;
    for (const layer of pose.layers) {
      const page = this.index.pages.get(layer.region.page);
      if (!page) continue;
      const handle = this.registry.handleFor(page.id);
      const texture = handle ? this.registry.resolve(handle) : null;
      const state = this.registry.pageState(page.id);
      if (!texture && state !== 'FAILED') {
        counters.pending++;
        continue;
      }
      const lm = this.layerMesh(rec, drawn);
      lm.handle = texture ? handle : null;
      lm.pageId = page.id;
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
        counters.failed++;
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
    const counters = { pending: 0, failed: 0, staleBindings: 0 };
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
        rec.poseKey = '';
      }
      const hide = (): void => {
        rec.group.visible = false;
        if (rec.shadow) rec.shadow.visible = false;
      };
      const items = rec.resolved ? rec.resolved.slots.map((s) => s.item.id) : [];
      if (!c.visible || !rec.resolved) {
        this.pin(rec, []);
        hide();
        continue;
      }
      this.sphere.center.set(c.position.x, c.position.y + 0.9, c.position.z);
      if (!this.frustum.intersectsSphere(this.sphere)) {
        // Off screen: unpin (evictable) but keep warm with a low-priority prefetch.
        this.pin(rec, []);
        for (const id of items) this.registry.prefetchItem(id);
        culled++;
        hide();
        continue;
      }
      this.pin(rec, items);
      const direction = spriteDirection(c.facingYaw, viewYawForCharacter(viewer, c.position));
      const clip = this.index.clips.get(c.animation.clipId);
      const frameIndex = clip ? sampleClip(clip, clipTimeAt(c.animation, nowMs)).frameIndex : 0;
      const key = `${rec.appearanceKey}|${c.animation.clipId}|${direction}|${frameIndex}|${this.hiddenRevision}|${this.registry.revision}`;
      if (key !== rec.poseKey) {
        rec.pose = resolvePose(this.index, rec.resolved, { clipId: c.animation.clipId, direction, frameIndex, hiddenLayers: this.hiddenLayers });
        rec.poseKey = key;
        rec.direction = direction;
        this.applyPose(rec, counters);
        poseUpdates++;
      } else if (rec.pose) {
        // Still count layers waiting for pages / drawn as placeholders.
        for (const l of rec.pose.layers) {
          const st = this.registry.pageState(l.region.page);
          if (st === 'FAILED') counters.failed++;
          else if (st !== 'RESIDENT') counters.pending++;
        }
      }
      // Generation audit: a visible layer may only draw the texture its handle currently resolves to.
      for (const l of rec.layers) {
        if (!l.mesh.visible || !l.handle || !l.pageId) continue;
        const current = this.registry.resolve(l.handle);
        if (current === null || current !== l.mesh.material.uniforms.uMap?.value) {
          l.mesh.visible = false;
          rec.poseKey = '';
          counters.staleBindings++;
        } else this.registry.touch(l.pageId);
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
    for (const rec of [...this.records.values()]) if (rec.seenFrame !== this.frame) this.destroyRecord(rec);
    // Painter order: farthest first (character feet / sortable anchors); id breaks ties so equal depths never flicker.
    const ranked: { key: string; depth: number; apply(rank: number): void }[] = visible.map((rec) => ({
      key: rec.entityId,
      depth: rec.depth,
      apply: (rank: number) => {
        rec.rank = rank;
        rec.group.renderOrder = rank;
      },
    }));
    for (const [id, s] of this.sortables) {
      s.anchor.updateWorldMatrix(true, false);
      s.depth = -this.tmp.setFromMatrixPosition(s.anchor.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z;
      ranked.push({
        key: `obj:${id}`,
        depth: s.depth,
        apply: (rank: number) => {
          s.rank = rank;
          s.group.renderOrder = rank;
        },
      });
    }
    ranked.sort((a, b) => b.depth - a.depth || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    ranked.forEach((r, i) => r.apply(i + 1));
    let layers = 0;
    for (const rec of visible) for (const l of rec.layers) if (l.mesh.visible) layers++;
    const reg = this.registry.stats();
    this.metrics = {
      ...this.emptyMetrics(),
      visibleCharacters: visible.length,
      culledCharacters: culled,
      visibleLayers: layers,
      pendingLayers: counters.pending,
      failedLayers: counters.failed,
      uniqueVisibleAppearances: appearances.size,
      poseUpdates,
      prepareCpuMs: performance.now() - t0,
      staleBindings: counters.staleBindings,
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
    }
    return { visibleLayers, violations };
  }

  /** Visible characters (and registered transparent objects, prefixed "obj:") in painter order, back to front. */
  paintOrder(): string[] {
    const entries = [...this.records.values()].filter((r) => r.group.visible).map((r) => ({ key: r.entityId, rank: r.rank }));
    for (const [id, s] of this.sortables) entries.push({ key: `obj:${id}`, rank: s.rank });
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
