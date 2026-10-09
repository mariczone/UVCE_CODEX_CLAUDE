import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SourceAssetRegistry, type PageLoader } from '../uvce/assets/source-registry.ts';
import { RollingSeries, summarize } from '../uvce/bench/frame-stats.ts';
import { type CrowdMember, HERO_ID, generateCrowd, heroAppearance, patrolPose } from '../uvce/bench/crowd.ts';
import { type AnimationState, switchClip } from '../uvce/core/animation.ts';
import { withSlot } from '../uvce/core/appearance-resolver.ts';
import { type Direction8, directionCenterYaw, facingYawForDirection, normalizeAngle, viewYawForCharacter } from '../uvce/core/directions.ts';
import type { AppearanceDefinition } from '../uvce/schema/appearance.ts';
import type { CompiledManifest, CompiledPage, ManifestIndex } from '../uvce/schema/compiled-manifest.ts';
import { indexManifest } from '../uvce/schema/compiled-manifest.ts';
import type { CharacterInstance, RenderMode } from '../uvce/render/contracts.ts';
import { LayeredCharacterRenderer } from '../uvce/render/webgl/layered-renderer.ts';
import { GpuTimer } from './gpu-timer.ts';
import { DebugOverlay, type OverlayOptions } from './overlay.ts';
import type { AppParams } from './params.ts';
import { PARITY, type Stage, createParityStage, createPixelCamera, createStage, createStudioStage } from './stage.ts';

export interface EnvironmentInfo {
  glVersion: string;
  glRenderer: string;
  glVendor: string;
  maxTextureSize: number;
  timerQuery: boolean;
  webgpuExposed: boolean;
  /** Result of navigator.gpu.requestAdapter(); WebGPU is never used for rendering in Milestone 0. */
  webgpuAdapter: 'available' | 'none' | 'not-exposed' | 'error' | 'pending';
  devicePixelRatio: number;
  pixelRatioUsed: number;
  viewport: { width: number; height: number };
  userAgent: string;
  hardwareConcurrency: number;
  /** True => performance.now() has ~5 us resolution (COOP/COEP); false => ~100 us in Chromium. */
  crossOriginIsolated: boolean;
}

export interface FrameSnapshot {
  simTimeMs: number;
  count: number;
  frameInterval: ReturnType<typeof summarize>;
  updateCpu: ReturnType<typeof summarize>;
  renderSubmitCpu: ReturnType<typeof summarize>;
  totalCpu: ReturnType<typeof summarize>;
  /** GPU timer query samples; on software rasterizers this is CPU rasterisation time (see env.glRenderer). */
  gpuTimer: ReturnType<typeof summarize>;
  drawCalls: number;
  triangles: number;
  textures: number;
  geometries: number;
  programs: number;
  gpuMs: number | null;
  character: ReturnType<LayeredCharacterRenderer['getMetrics']>;
  registry: ReturnType<SourceAssetRegistry<THREE.Texture>['stats']>;
}

function textureLoader(three: THREE.WebGLRenderer, forceFilter: 'linear' | 'nearest' | null): PageLoader<THREE.Texture> {
  const loader = new THREE.TextureLoader();
  return {
    async load(page: CompiledPage, url: string) {
      const tex = await loader.loadAsync(url);
      tex.name = page.id;
      tex.colorSpace = THREE.NoColorSpace; // raw sRGB-encoded values; blending happens in sRGB space
      tex.premultiplyAlpha = true; // straight PNG -> premultiplied on upload (filtering-correct)
      tex.flipY = true;
      tex.generateMipmaps = false; // mip-safe padding is Milestone 2
      const filter = (forceFilter ?? page.filter) === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;
      tex.magFilter = filter;
      tex.minFilter = filter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      three.initTexture(tex); // upload now: "RESIDENT" means on the GPU, not just downloaded
      return tex;
    },
    dispose(tex) {
      tex.dispose();
    },
  };
}

export class UvceApp {
  readonly params: AppParams;
  readonly index: ManifestIndex;
  readonly three: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly registry: SourceAssetRegistry<THREE.Texture>;
  readonly characters: LayeredCharacterRenderer;
  readonly overlay: DebugOverlay;
  readonly env: EnvironmentInfo;
  readonly renderMode: RenderMode;
  readonly gpuTimer: GpuTimer;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls | null = null;
  stage: Stage;
  members: CrowdMember[] = [];
  instances: CharacterInstance[] = [];
  count: number;
  seed: number;
  simTimeMs: number;
  paused: boolean;
  timeScale = 1;
  heroAutoTurn = false;
  overlayOptions: OverlayOptions;
  private heroState: { appearance: AppearanceDefinition; animation: AnimationState; facingYaw: number };
  private readonly canvas: HTMLCanvasElement;
  private raf = 0;
  private lastTs: number | null = null;
  private lastInfo = { calls: 0, triangles: 0 };
  private overlayDrawn = false;
  readonly series = {
    frameInterval: new RollingSeries(600),
    updateCpu: new RollingSeries(600),
    renderSubmitCpu: new RollingSeries(600),
    totalCpu: new RollingSeries(600),
    gpu: new RollingSeries(600),
  };

  constructor(opts: { canvas: HTMLCanvasElement; overlayCanvas: HTMLCanvasElement; params: AppParams; manifest: CompiledManifest; assetBaseUrl: string; renderMode: RenderMode }) {
    this.params = opts.params;
    this.canvas = opts.canvas;
    this.renderMode = opts.renderMode;
    this.index = indexManifest(opts.manifest);
    this.count = this.params.count;
    this.seed = this.params.seed;
    this.simTimeMs = this.params.timeMs;
    this.paused = this.params.paused;
    const test = this.params.test;
    this.three = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: !test, alpha: false, preserveDrawingBuffer: test, powerPreference: 'high-performance' });
    this.three.outputColorSpace = THREE.SRGBColorSpace;
    this.three.toneMapping = THREE.NoToneMapping;
    this.three.setPixelRatio(test ? 1 : Math.min(window.devicePixelRatio, 2));
    const gl = this.three.getContext() as WebGL2RenderingContext;
    this.gpuTimer = new GpuTimer(gl);
    this.gpuTimer.onResult = (ms) => this.series.gpu.push(ms);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.env = {
      glVersion: String(gl.getParameter(gl.VERSION)),
      glRenderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
      glVendor: String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      timerQuery: this.gpuTimer.supported,
      webgpuExposed: 'gpu' in navigator,
      webgpuAdapter: 'pending',
      devicePixelRatio: window.devicePixelRatio,
      pixelRatioUsed: this.three.getPixelRatio(),
      viewport: { width: 0, height: 0 },
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated: window.crossOriginIsolated === true,
    };
    this.registry = new SourceAssetRegistry(this.index, opts.assetBaseUrl, textureLoader(this.three, this.params.filter ?? (this.params.scene === 'stage' ? null : 'nearest')));
    const parity = this.params.scene === 'parity';
    const pixel = parity || this.params.scene === 'studio';
    this.stage = parity ? createParityStage(this.scene) : pixel ? createStudioStage(this.scene) : createStage(this.scene);
    this.camera = pixel ? createPixelCamera(1280, 720, this.pixelsPerUnit, PARITY.cameraCenter) : new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 120);
    this.characters = new LayeredCharacterRenderer({ index: this.index, registry: this.registry, scene: this.scene, camera: this.camera, shadows: !pixel });
    for (const layer of this.params.hide) this.characters.setLayerHidden(layer, true);
    this.overlay = new DebugOverlay(opts.overlayCanvas);
    this.overlayOptions = { pivots: this.params.debug, sockets: this.params.debug, layerBoxes: this.params.debug, ranks: false };
    let appearance = heroAppearance();
    for (const [slot, item] of Object.entries(this.params.slots)) appearance = withSlot(appearance, slot, item);
    this.heroState = { appearance, animation: { clipId: this.params.heroClip ?? 'idle', clipStartMs: 0, speed: 1, phaseOffsetMs: 0 }, facingYaw: Math.PI * 0.75 };
    if (!pixel) {
      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.enableDamping = !test;
      this.controls.enabled = !test;
      this.controls.minPolarAngle = 0.25;
      this.controls.maxPolarAngle = 1.45;
      this.controls.minDistance = 2.5;
      this.controls.maxDistance = 40;
    }
    this.rebuildCrowd();
    this.frameCamera();
    if (this.params.heroDirection) this.setHeroDirection(this.params.heroDirection);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Capability probe only (feature detection); never switches the renderer. */
  async probeWebGpu(): Promise<void> {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) {
      this.env.webgpuAdapter = 'not-exposed';
      return;
    }
    try {
      const adapter = await Promise.race([gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 3000))]);
      this.env.webgpuAdapter = adapter ? 'available' : 'none';
    } catch {
      this.env.webgpuAdapter = 'error';
    }
  }

  get pixelsPerUnit(): number {
    return this.index.manifest.rigs[0]?.pixelsPerWorldUnit ?? 128;
  }

  get heroAppearance(): AppearanceDefinition {
    return this.heroState.appearance;
  }

  get heroClipId(): string {
    return this.heroState.animation.clipId;
  }

  resize(): void {
    const parent = this.canvas.parentElement as HTMLElement;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.three.setSize(w, h, false);
    this.env.viewport = { width: w, height: h };
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    } else {
      const hw = w / 2 / this.pixelsPerUnit;
      const hh = h / 2 / this.pixelsPerUnit;
      Object.assign(this.camera, { left: -hw, right: hw, top: hh, bottom: -hh });
      this.camera.updateProjectionMatrix();
    }
    this.overlay.resize(w, h, window.devicePixelRatio);
  }

  /** Camera distance grows with the crowd so 1/20/100/300 scenes are comparable and framed. */
  frameCamera(): void {
    if (!(this.camera instanceof THREE.PerspectiveCamera)) return;
    const d = this.count <= 2 ? 6.5 : this.count <= 20 ? 10 : this.count <= 100 ? 17 : 27;
    this.camera.position.set(0, d * 0.62, d * 0.82);
    const target = new THREE.Vector3(0, this.count <= 2 ? 0.85 : 0.4, 0);
    this.camera.lookAt(target);
    this.controls?.target.copy(target);
    this.controls?.update();
  }

  private rebuildCrowd(): void {
    if (this.params.scene === 'parity') {
      // Ortho camera looks north (view yaw 0): facing = direction sector centre.
      this.members = PARITY.characters.map((c, i) => ({
        entityId: c.id,
        x: c.x,
        z: c.z,
        facingYaw: directionCenterYaw(this.params.heroDirection ?? 'SE'),
        clipId: this.params.heroClip ?? 'idle',
        phaseOffsetMs: 0,
        appearance:
          i === 0
            ? this.heroState.appearance
            : { ...heroAppearance(), slots: { ...heroAppearance().slots, hair: { itemId: 'hair_02' }, hat: { itemId: 'hat_03' }, armor: { itemId: 'armor_03' }, weapon: { itemId: 'weapon_02' } } },
        patrol: null,
      }));
    } else if (this.params.scene === 'studio') {
      this.members = [{ entityId: HERO_ID, x: 0, z: 0, facingYaw: this.heroState.facingYaw, clipId: 'idle', phaseOffsetMs: 0, appearance: this.heroState.appearance, patrol: null }];
    } else if (this.count === 2) {
      // Overlap preset: companion slightly behind and to the right, facing SW.
      this.members = [
        { entityId: HERO_ID, x: 0, z: 0, facingYaw: this.heroState.facingYaw, clipId: 'idle', phaseOffsetMs: 0, appearance: this.heroState.appearance, patrol: null },
        { entityId: 'npc-0001', x: 0.32, z: -0.42, facingYaw: directionCenterYaw('SW'), clipId: 'idle', phaseOffsetMs: 300, appearance: { ...heroAppearance(), slots: { ...heroAppearance().slots, hair: { itemId: 'hair_02' }, hat: { itemId: 'hat_02' }, armor: { itemId: 'armor_02' }, weapon: { itemId: 'weapon_03' } } }, patrol: null },
      ];
    } else {
      this.members = generateCrowd(this.index, { count: this.count, seed: this.seed });
    }
    this.instances = this.members.map((m, i) => ({
      entityId: m.entityId,
      position: { x: m.x, y: 0, z: m.z },
      facingYaw: i === 0 && this.params.scene !== 'parity' ? this.heroState.facingYaw : m.facingYaw,
      appearance: i === 0 ? this.heroState.appearance : m.appearance,
      animation: i === 0 ? this.heroState.animation : { clipId: m.clipId, clipStartMs: 0, speed: 1, phaseOffsetMs: m.phaseOffsetMs },
      visible: true,
    }));
  }

  private get hero(): CharacterInstance {
    return this.instances[0] as CharacterInstance;
  }

  setCount(count: number): void {
    if (this.params.scene !== 'stage') return;
    this.count = Math.max(1, Math.min(1000, Math.floor(count)));
    this.rebuildCrowd();
    this.frameCamera();
  }

  setSeed(seed: number): void {
    this.seed = seed >>> 0;
    this.rebuildCrowd();
  }

  setHeroSlot(slot: string, itemId: string | null): void {
    this.heroState.appearance = withSlot(this.heroState.appearance, slot, itemId);
    this.hero.appearance = this.heroState.appearance;
  }

  setHeroClip(clipId: string): void {
    this.heroState.animation = switchClip(this.heroState.animation, clipId, this.simTimeMs);
    this.hero.animation = this.heroState.animation;
  }

  /** Sets facing so the hero DISPLAYS `direction` from the current camera (direction is view-relative). */
  setHeroDirection(direction: Direction8): void {
    this.camera.updateMatrixWorld();
    const pos = this.camera.getWorldPosition(new THREE.Vector3());
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    const viewYaw = viewYawForCharacter(
      { position: { x: pos.x, y: pos.y, z: pos.z }, forward: { x: fwd.x, y: fwd.y, z: fwd.z }, orthographic: this.camera instanceof THREE.OrthographicCamera },
      this.hero.position,
    );
    this.heroState.facingYaw = facingYawForDirection(direction, viewYaw);
    this.hero.facingYaw = this.heroState.facingYaw;
  }

  /** Orbits the perspective camera around its target so it looks along compass yaw `yaw` (same distance/height). */
  setCameraViewYaw(yaw: number): void {
    if (!(this.camera instanceof THREE.PerspectiveCamera)) return;
    const target = this.controls?.target ?? new THREE.Vector3();
    const offset = this.camera.position.clone().sub(target);
    const horizontal = Math.hypot(offset.x, offset.z);
    this.camera.position.set(target.x - Math.sin(yaw) * horizontal, target.y + offset.y, target.z + Math.cos(yaw) * horizontal);
    this.camera.lookAt(target);
    this.controls?.update();
  }

  setLayerHidden(layer: string, hidden: boolean): void {
    this.characters.setLayerHidden(layer, hidden);
  }

  private updateWorld(): void {
    for (let i = 1; i < this.members.length; i++) {
      const m = this.members[i] as CrowdMember;
      if (!m.patrol) continue;
      const p = patrolPose(m, this.simTimeMs);
      const inst = this.instances[i] as CharacterInstance;
      inst.position.x = p.x;
      inst.position.z = p.z;
      inst.facingYaw = p.facingYaw;
    }
    if (this.heroAutoTurn && !this.paused) {
      this.heroState.facingYaw = normalizeAngle((this.simTimeMs / 900) * (Math.PI / 4));
      this.hero.facingYaw = this.heroState.facingYaw;
    }
  }

  tick(): void {
    const t0 = performance.now();
    this.controls?.update();
    this.updateWorld();
    this.characters.prepareFrame(this.instances, this.simTimeMs);
    const t1 = performance.now();
    this.gpuTimer.begin();
    this.three.render(this.scene, this.camera);
    this.gpuTimer.end();
    const t2 = performance.now();
    this.series.updateCpu.push(t1 - t0);
    this.series.renderSubmitCpu.push(t2 - t1);
    this.series.totalCpu.push(t2 - t0);
    this.lastInfo = { calls: this.three.info.render.calls, triangles: this.three.info.render.triangles };
    const o = this.overlayOptions;
    const overlayOn = this.params.overlay && (o.pivots || o.sockets || o.layerBoxes || o.ranks);
    if (overlayOn) {
      // Per-character debug data only when an overlay needs it (keeps benchmark CPU numbers clean).
      const ids = o.pivots || o.ranks ? this.instances.slice(0, 400) : this.instances.slice(0, 1);
      const infos = ids.map((c) => this.characters.debugInfo(c.entityId)).filter((d) => d !== null);
      this.overlay.draw(this.camera, infos, HERO_ID, o, this.pixelsPerUnit);
      this.overlayDrawn = true;
    } else if (this.overlayDrawn) {
      this.overlay.draw(this.camera, [], HERO_ID, o, this.pixelsPerUnit); // clear once
      this.overlayDrawn = false;
    }
  }

  private loop = (ts: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.lastTs !== null) {
      const dt = ts - this.lastTs;
      this.series.frameInterval.push(dt);
      if (!this.paused) this.simTimeMs += Math.min(dt, 100) * this.timeScale;
    }
    this.lastTs = ts;
    this.tick();
  };

  start(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastTs = null;
  }

  resetStats(): void {
    for (const s of Object.values(this.series)) s.clear();
  }

  snapshot(): FrameSnapshot {
    const mem = this.three.info.memory;
    return {
      simTimeMs: this.simTimeMs,
      count: this.instances.length,
      frameInterval: summarize(this.series.frameInterval.snapshot()),
      updateCpu: summarize(this.series.updateCpu.snapshot()),
      renderSubmitCpu: summarize(this.series.renderSubmitCpu.snapshot()),
      totalCpu: summarize(this.series.totalCpu.snapshot()),
      gpuTimer: summarize(this.series.gpu.snapshot()),
      drawCalls: this.lastInfo.calls,
      triangles: this.lastInfo.triangles,
      textures: mem.textures,
      geometries: mem.geometries,
      programs: this.three.info.programs?.length ?? 0,
      gpuMs: this.gpuTimer.lastMs,
      character: this.characters.getMetrics(),
      registry: this.registry.stats(),
    };
  }

  /** Waits until every page needed by the current scene is resident (or failed), then renders once. */
  async waitForIdle(timeoutMs = 15000): Promise<void> {
    const until = performance.now() + timeoutMs;
    for (;;) {
      this.tick();
      const m = this.characters.getMetrics();
      if (this.registry.stats().fetching === 0 && m.pendingLayers === 0) break;
      if (performance.now() > until) throw new Error('timeout waiting for asset pages');
      await new Promise((r) => setTimeout(r, 20));
    }
    this.tick();
  }
}
