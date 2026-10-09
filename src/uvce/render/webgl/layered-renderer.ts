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
import type { SourceAssetRegistry } from '../../assets/source-registry.ts';
import type { AppearanceDefinition } from '../../schema/appearance.ts';
import type { ManifestIndex } from '../../schema/compiled-manifest.ts';
import type { CharacterInstance, CharacterRenderMetrics, ICharacterRenderer } from '../contracts.ts';
import { createMissingTexture, createSpriteLayerMaterial, createUnitQuadGeometry } from './sprite-material.ts';

export interface LayeredRendererOptions {
  index: ManifestIndex;
  registry: SourceAssetRegistry<THREE.Texture>;
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
  private readonly registry: SourceAssetRegistry<THREE.Texture>;
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

  get hidden(): ReadonlySet<string> {
    return this.hiddenLayers;
  }

  private resolve(appearance: AppearanceDefinition): { resolved: ResolvedAppearance | null; key: string; issues: Issue[] } {
    const cached = this.resolvedCache.get(appearance);
    if (cached) return cached;
    const r = resolveAppearance(this.index, appearance);
    const entry = r.ok ? { resolved: r.value, key: appearanceKey(r.value), issues: r.value.issues } : { resolved: null, key: 'unresolvable', issues: r.issues };
    this.resolvedCache.set(appearance, entry);
    if (entry.resolved) for (const s of entry.resolved.slots) void this.registry.ensureItem(s.item.id);
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
    };
    this.records.set(entityId, rec);
    return rec;
  }

  private destroyRecord(rec: CharacterRecord): void {
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
      lm = { mesh };
      rec.layers[i] = lm;
    }
    return lm;
  }

  private applyPose(rec: CharacterRecord, counters: { pending: number; failed: number }): void {
    const pose = rec.pose;
    const rig = rec.resolved?.rig;
    if (!pose || !rig) return;
    const m = this.margin;
    let drawn = 0;
    for (const layer of pose.layers) {
      const page = this.index.pages.get(layer.region.page);
      if (!page) continue;
      const texture = this.registry.getPage(page.id);
      const state = this.registry.pageState(page.id);
      if (!texture && state !== 'FAILED') {
        counters.pending++;
        continue;
      }
      const lm = this.layerMesh(rec, drawn);
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
    const counters = { pending: 0, failed: 0 };
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
      if (!c.visible || !rec.resolved) {
        hide();
        continue;
      }
      this.sphere.center.set(c.position.x, c.position.y + 0.9, c.position.z);
      if (!this.frustum.intersectsSphere(this.sphere)) {
        culled++;
        hide();
        continue;
      }
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
    // Painter order: farthest foot first; entity id breaks ties so equal depths never flicker.
    visible.sort((a, b) => b.depth - a.depth || (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
    let layers = 0;
    visible.forEach((rec, i) => {
      rec.rank = i + 1;
      rec.group.renderOrder = rec.rank;
      for (const l of rec.layers) if (l.mesh.visible) layers++;
    });
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
      sourceEstimatedBytes: reg.residentBytesRGBA8,
      pendingDownloads: reg.fetching,
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

  /** Visible characters in painter order (back to front). */
  paintOrder(): string[] {
    return [...this.records.values()].filter((r) => r.group.visible).sort((a, b) => a.rank - b.rank).map((r) => r.entityId);
  }

  dispose(): void {
    for (const rec of [...this.records.values()]) this.destroyRecord(rec);
    this.root.removeFromParent();
    this.shadowRoot.removeFromParent();
    this.quad.dispose();
    this.missing.dispose();
    this.shadowGeometry.dispose();
    this.shadowMaterial.map?.dispose();
    this.shadowMaterial.dispose();
  }
}
