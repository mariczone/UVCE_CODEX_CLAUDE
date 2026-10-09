/**
 * 2D debug overlay drawn over the WebGL canvas. Billboards are screen-aligned with uniform scale, so a
 * sprite pixel maps to screen by: screen = footScreen + (canvasPos - footPivot) * pxScale (exact).
 */
import * as THREE from 'three';
import type { CharacterDebugInfo } from '../uvce/render/webgl/layered-renderer.ts';

export interface OverlayOptions {
  pivots: boolean;
  sockets: boolean;
  layerBoxes: boolean;
  ranks: boolean;
}

const LAYER_COLORS: Record<string, string> = {
  hair_back: '#ff9f43',
  body: '#54a0ff',
  arm_front: '#00d2d3',
  armor: '#5f27cd',
  head: '#feca57',
  hair_front: '#ff6b6b',
  hat: '#1dd1a1',
  weapon: '#ee5253',
};

export class DebugOverlay {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;
  private readonly v = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): void {
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private toScreen(p: THREE.Vector3, camera: THREE.Camera, w: number, h: number): { x: number; y: number; inFront: boolean } {
    this.v.copy(p).project(camera);
    return { x: ((this.v.x + 1) / 2) * w, y: ((1 - this.v.y) / 2) * h, inFront: this.v.z < 1 && this.v.z > -1 };
  }

  draw(camera: THREE.Camera, characters: readonly CharacterDebugInfo[], focusId: string, opts: OverlayOptions, pixelsPerUnit: number): void {
    const w = parseFloat(this.canvas.style.width);
    const h = parseFloat(this.canvas.style.height);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (!opts.pivots && !opts.sockets && !opts.layerBoxes && !opts.ranks) return;
    this.up.set(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    for (const c of characters) {
      if (!c.visible || !c.pose || !c.resolved) continue;
      const foot = this.toScreen(c.position, camera, w, h);
      if (!foot.inFront) continue;
      const top = this.toScreen(c.position.clone().addScaledVector(this.up, 1 / pixelsPerUnit), camera, w, h);
      const scale = Math.hypot(top.x - foot.x, top.y - foot.y); // screen px per sprite px
      const pivot = c.resolved.rig.footPivot;
      const map = (x: number, y: number): [number, number] => [foot.x + (x - pivot.x) * scale, foot.y + (y - pivot.y) * scale];
      const focus = c.entityId === focusId;
      if (opts.ranks) {
        const [lx, ly] = map(pivot.x, (c.pose.bounds?.y ?? 40) - 4);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(lx - 9, ly - 12, 18, 12);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(String(c.rank), lx, ly - 11);
        ctx.textAlign = 'left';
      }
      if (opts.layerBoxes && focus) {
        for (const layer of c.pose.layers) {
          const [x, y] = map(layer.dest.x, layer.dest.y);
          ctx.strokeStyle = LAYER_COLORS[layer.layer] ?? '#fff';
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, layer.dest.w * scale, layer.dest.h * scale);
          ctx.fillStyle = LAYER_COLORS[layer.layer] ?? '#fff';
          ctx.fillText(`${layer.order}:${layer.layer}`, x + 2, y + 2);
        }
      }
      if (opts.sockets && focus) {
        for (const [name, pos] of Object.entries(c.pose.sockets)) {
          if (name === 'root') continue;
          const [x, y] = map(pos.x, pos.y);
          ctx.fillStyle = '#00ffd0';
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#e8fffb';
          ctx.fillText(name, x + 5, y - 4);
        }
      }
      if (opts.pivots && (focus || characters.length <= 120)) {
        ctx.strokeStyle = focus ? '#ff2d55' : 'rgba(255,45,85,0.7)';
        ctx.lineWidth = focus ? 2 : 1;
        const s = focus ? 7 : 4;
        ctx.beginPath();
        ctx.moveTo(foot.x - s, foot.y);
        ctx.lineTo(foot.x + s, foot.y);
        ctx.moveTo(foot.x, foot.y - s);
        ctx.lineTo(foot.x, foot.y + s);
        ctx.stroke();
      }
    }
  }
}
