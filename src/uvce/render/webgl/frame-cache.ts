/**
 * FULL_CACHE render mode (Milestone 3): whole character frames (appearance + clip + direction + frame + debug
 * toggles) baked once into cells of render-target "cache pages", then drawn as ONE quad sampling ONE texture.
 *
 * - FrameCacheAllocator: fixed-size cells, keyed lookup, LRU eviction of cells not used in the current frame, and a
 *   per-cell generation so a character holding an evicted / reassigned cell notices before drawing it. Pure logic,
 *   unit-tested in Node.
 * - WebGLFrameCacheBackend: render-target pages, the bake pass (composite shader rasterised 1 texel = 1 sprite px,
 *   see composite-material.ts) and mipmaps clamped to the levels the cell gutters make bleed-free.
 *
 * Cell layout: content is the 256x256 canonical canvas at offset CELL_OFFSET inside a CELL_SIZE square; cells sit on
 * a CELL_SIZE grid. CELL_SIZE and CELL_OFFSET are multiples of 2^CACHE_MIP_LEVELS, so mip levels 0..3 never mix two
 * cells (same rule as the compiler's mip-safe source pages).
 */
import * as THREE from 'three';
import { type CompositeLayerInput, createBakeMaterial, setCompositeLayers } from './composite-material.ts';

export const CANVAS_SIZE = 256;
export const CACHE_MIP_LEVELS = 3;
export const CELL_OFFSET = 8;
export const CELL_SIZE = CANVAS_SIZE + 2 * CELL_OFFSET + 8; // 280: 12+ transparent texels between neighbouring content
export const CACHE_PAGE_SIZE = 2048;

export interface CacheCell {
  readonly page: number;
  readonly index: number;
  /** Frame key currently stored in the cell (null = free). */
  key: string | null;
  /** Bumped whenever the cell's content is dropped or replaced: holders compare it before drawing. */
  generation: number;
  lastUsed: number;
}

export interface FrameCacheStats {
  pages: number;
  cells: number;
  usedCells: number;
  evictions: number;
  clears: number;
  /** Misses not baked because the frame was requested for the first time (admission control). */
  rejected: number;
}

export class FrameCacheAllocator {
  readonly cellsPerPage: number;
  readonly maxPages: number;
  private readonly cells: CacheCell[] = [];
  private readonly byKey = new Map<string, CacheCell>();
  private readonly ghosts = new Map<string, number>();
  private readonly admitWindow: number;
  private readonly maxGhosts: number;
  private frame = 0;
  private evictions = 0;
  private clears = 0;
  private rejected = 0;
  pages = 0;

  constructor(options: { cellsPerPage: number; maxPages: number; admitWindow?: number }) {
    this.cellsPerPage = Math.max(1, Math.floor(options.cellsPerPage));
    this.maxPages = Math.max(1, Math.floor(options.maxPages));
    this.admitWindow = options.admitWindow ?? 120;
    this.maxGhosts = 4 * this.cellsPerPage * this.maxPages + 256;
  }

  beginFrame(frame: number): void {
    this.frame = frame;
  }

  /** Total cells once every page is allocated. */
  get capacityCells(): number {
    return this.cellsPerPage * this.maxPages;
  }

  /** The cell holding `key`, marked as used this frame (protected from eviction until the next frame). */
  lookup(key: string): CacheCell | null {
    const cell = this.byKey.get(key);
    if (!cell) return null;
    cell.lastUsed = this.frame;
    return cell;
  }

  /**
   * Admission control ("bake on second sight"): true when `key` was already requested within the last
   * `admitWindow` frames. A frame wanted only once (one character passing through one animation frame) is never
   * baked, so it cannot evict a frame that several characters or frames reuse. Ghost entries are bounded.
   */
  admit(key: string): boolean {
    const seen = this.ghosts.get(key);
    if (seen !== undefined && this.frame - seen <= this.admitWindow) {
      this.ghosts.delete(key);
      return true;
    }
    this.ghosts.set(key, this.frame);
    if (this.ghosts.size > this.maxGhosts) {
      // Map keeps insertion order: drop the oldest half in one go (amortised O(1) per call).
      let drop = this.ghosts.size >> 1;
      for (const k of this.ghosts.keys()) {
        if (drop-- <= 0) break;
        this.ghosts.delete(k);
      }
    }
    this.rejected++;
    return false;
  }

  /** Re-marks a cell a character keeps drawing (no map lookup). */
  touch(cell: CacheCell): void {
    cell.lastUsed = this.frame;
  }

  /**
   * A cell for a new key: a free cell, else a new page (up to maxPages), else the least recently used cell not used
   * in this frame. Null when every cell is in use this frame (caller falls back to another mode).
   */
  allocate(key: string): CacheCell | null {
    let cell = this.cells.find((c) => c.key === null) ?? null;
    if (!cell && this.pages < this.maxPages) {
      const page = this.pages++;
      for (let i = 0; i < this.cellsPerPage; i++) this.cells.push({ page, index: i, key: null, generation: 0, lastUsed: 0 });
      cell = this.cells[page * this.cellsPerPage] as CacheCell;
    }
    if (!cell) {
      let lru: CacheCell | null = null;
      for (const c of this.cells) if (c.lastUsed < this.frame && (!lru || c.lastUsed < lru.lastUsed)) lru = c;
      if (!lru) return null;
      this.byKey.delete(lru.key as string);
      lru.generation++;
      this.evictions++;
      cell = lru;
    }
    cell.key = key;
    cell.lastUsed = this.frame;
    this.byKey.set(key, cell);
    return cell;
  }

  /** Drops every entry (e.g. WebGL context loss destroyed the pages' content). Pages stay allocated. */
  clear(): void {
    for (const c of this.cells) {
      if (c.key !== null) c.generation++;
      c.key = null;
    }
    this.byKey.clear();
    this.ghosts.clear();
    this.clears++;
  }

  isValid(cell: CacheCell, key: string, generation: number): boolean {
    return cell.key === key && cell.generation === generation;
  }

  stats(): FrameCacheStats {
    return { pages: this.pages, cells: this.cells.length, usedCells: this.byKey.size, evictions: this.evictions, clears: this.clears, rejected: this.rejected };
  }
}

export interface BakeJob {
  cell: CacheCell;
  layers: readonly CompositeLayerInput[];
  pivot: { x: number; y: number };
}

/** What the renderer needs from the GPU side of the cache (a fake implements it in unit tests). */
export interface FrameCacheBackend {
  readonly allocator: FrameCacheAllocator;
  pageTexture(page: number): THREE.Texture;
  /** Bakes the jobs (all of this frame's misses) before the frame is rendered. */
  bake(jobs: readonly BakeJob[]): void;
  /** UV rect (u0, vTop, u1, vBottom) of a canvas-space rect inside a cell. */
  uvRect(cell: CacheCell, rect: { x: number; y: number; w: number; h: number }, out: THREE.Vector4): THREE.Vector4;
  bytesPerPage: number;
  onContextLost(): void;
  onContextRestored(): void;
  dispose(): void;
}

export interface WebGLFrameCacheOptions {
  /** Cache memory budget (whole pages incl. mip chain). */
  budgetBytes: number;
  filter: 'linear' | 'nearest';
  mipmaps: boolean;
  placeholder: THREE.Texture;
}

const CELLS_PER_ROW = Math.floor(CACHE_PAGE_SIZE / CELL_SIZE);

function cellOrigin(cell: CacheCell): { x: number; y: number } {
  return { x: (cell.index % CELLS_PER_ROW) * CELL_SIZE, y: Math.floor(cell.index / CELLS_PER_ROW) * CELL_SIZE };
}

export class WebGLFrameCacheBackend implements FrameCacheBackend {
  readonly allocator: FrameCacheAllocator;
  readonly bytesPerPage: number;
  private readonly three: THREE.WebGLRenderer;
  private readonly options: WebGLFrameCacheOptions;
  private readonly targets: THREE.WebGLRenderTarget[] = [];
  private readonly initialised: boolean[] = [];
  private readonly bakeScene = new THREE.Scene();
  private readonly bakeCamera = new THREE.Camera();
  private readonly bakeQuad: THREE.BufferGeometry;
  private readonly bakeMeshes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  private contextLost = false;

  constructor(three: THREE.WebGLRenderer, quad: THREE.BufferGeometry, options: WebGLFrameCacheOptions) {
    this.three = three;
    this.bakeQuad = quad;
    this.options = options;
    const level0 = CACHE_PAGE_SIZE * CACHE_PAGE_SIZE * 4;
    this.bytesPerPage = options.mipmaps && options.filter === 'linear' ? Math.round((level0 * 4) / 3) : level0;
    this.allocator = new FrameCacheAllocator({ cellsPerPage: CELLS_PER_ROW * CELLS_PER_ROW, maxPages: Math.max(1, Math.floor(options.budgetBytes / this.bytesPerPage)) });
  }

  private target(page: number): THREE.WebGLRenderTarget {
    let rt = this.targets[page];
    if (!rt) {
      const nearest = this.options.filter === 'nearest';
      const mips = !nearest && this.options.mipmaps;
      rt = new THREE.WebGLRenderTarget(CACHE_PAGE_SIZE, CACHE_PAGE_SIZE, {
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: mips,
        magFilter: nearest ? THREE.NearestFilter : THREE.LinearFilter,
        minFilter: nearest ? THREE.NearestFilter : mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
        colorSpace: THREE.NoColorSpace,
      });
      rt.texture.name = `frame-cache-${page}`;
      this.targets[page] = rt;
    }
    return rt;
  }

  /** First use of a page (or after a context restore): clear it and clamp sampling to the bleed-free mip levels. */
  private prepare(page: number): void {
    if (this.initialised[page]) return;
    const rt = this.target(page);
    const previous = this.three.getRenderTarget();
    const clear = this.three.getClearColor(new THREE.Color());
    const alpha = this.three.getClearAlpha();
    this.three.setRenderTarget(rt);
    this.three.setClearColor(0x000000, 0);
    this.three.clear(true, false, false);
    this.three.setClearColor(clear, alpha);
    this.three.setRenderTarget(previous);
    if (rt.texture.generateMipmaps) {
      const gl = this.three.getContext() as WebGL2RenderingContext;
      const glTexture = (this.three.properties.get(rt.texture) as { __webglTexture?: WebGLTexture }).__webglTexture;
      if (glTexture) {
        const bound = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
        gl.bindTexture(gl.TEXTURE_2D, glTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, CACHE_MIP_LEVELS);
        gl.bindTexture(gl.TEXTURE_2D, bound);
      }
    }
    this.initialised[page] = true;
  }

  pageTexture(page: number): THREE.Texture {
    return this.target(page).texture;
  }

  uvRect(cell: CacheCell, rect: { x: number; y: number; w: number; h: number }, out: THREE.Vector4): THREE.Vector4 {
    const o = cellOrigin(cell);
    const x0 = o.x + CELL_OFFSET + rect.x;
    const yTop = o.y + CELL_OFFSET + rect.y;
    return out.set(x0 / CACHE_PAGE_SIZE, 1 - yTop / CACHE_PAGE_SIZE, (x0 + rect.w) / CACHE_PAGE_SIZE, 1 - (yTop + rect.h) / CACHE_PAGE_SIZE);
  }

  private bakeMesh(i: number): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
    let mesh = this.bakeMeshes[i];
    if (!mesh) {
      mesh = new THREE.Mesh(this.bakeQuad, createBakeMaterial(this.options.placeholder));
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      this.bakeMeshes[i] = mesh;
      this.bakeScene.add(mesh);
    }
    return mesh;
  }

  bake(jobs: readonly BakeJob[]): void {
    if (this.contextLost || jobs.length === 0) return;
    const byPage = new Map<number, BakeJob[]>();
    for (const job of jobs) byPage.set(job.cell.page, [...(byPage.get(job.cell.page) ?? []), job]);
    const previous = this.three.getRenderTarget();
    const autoClear = this.three.autoClear;
    this.three.autoClear = false; // never clear the page: other cells hold live frames
    for (const [page, pageJobs] of byPage) {
      this.prepare(page);
      pageJobs.forEach((job, i) => {
        const mesh = this.bakeMesh(i);
        const u = mesh.material.uniforms;
        setCompositeLayers(u, job.layers, job.pivot, 1, this.options.placeholder);
        // The quad covers the whole cell (content offset + gutter), so stale texels of a previous occupant are overwritten.
        (u.uBounds?.value as THREE.Vector4).set(-job.pivot.x - CELL_OFFSET, -job.pivot.y - CELL_OFFSET, CELL_SIZE, CELL_SIZE);
        const o = cellOrigin(job.cell);
        const ndc = (v: number): number => (v / CACHE_PAGE_SIZE) * 2 - 1;
        (u.uCellNdc?.value as THREE.Vector4).set(ndc(o.x), -ndc(o.y), ndc(o.x + CELL_SIZE), -ndc(o.y + CELL_SIZE));
        mesh.visible = true;
      });
      for (let i = pageJobs.length; i < this.bakeMeshes.length; i++) (this.bakeMeshes[i] as THREE.Mesh).visible = false;
      this.three.setRenderTarget(this.target(page));
      this.three.render(this.bakeScene, this.bakeCamera); // three regenerates the page's mip chain afterwards
    }
    this.three.setRenderTarget(previous);
    this.three.autoClear = autoClear;
  }

  onContextLost(): void {
    this.contextLost = true;
    this.allocator.clear();
  }

  onContextRestored(): void {
    this.contextLost = false;
    this.initialised.length = 0; // pages come back empty: clear and re-clamp on next use
  }

  dispose(): void {
    for (const rt of this.targets) rt.dispose();
    for (const m of this.bakeMeshes) m.material.dispose();
  }
}
