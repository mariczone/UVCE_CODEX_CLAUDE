/**
 * SHADER render mode material (Milestone 3): one screen-aligned quad per character whose fragment shader samples
 * every visible layer and composites them back to front with premultiplied "over":
 *   acc = layer + (1 - layer.a) * acc
 * which is the same operation the blend unit performs between LAYERED quads, so the result equals LAYERED up to
 * 8-bit rounding of the intermediate framebuffer values (LAYERED rounds after every layer, SHADER only once).
 *
 * The quad uses the LAYERED vertex transform (view space at the foot anchor, one constant biased depth), so 3D
 * occlusion and character-level painter order are unchanged. Each layer is masked to its own rectangle (incl. the
 * filter margin), exactly the pixels a LAYERED quad would cover. Samplers are separate uniforms (GLSL ES 3.00 only
 * allows constant indices into sampler arrays); the shader source is generated for MAX_COMPOSITE_LAYERS slots.
 * Sampling is unconditional inside a uniform branch, so mip derivatives stay well defined.
 */
import * as THREE from 'three';
import { type LayerRotation, rotatedBounds } from '../../core/secondary-motion.ts';

/** Layers per composite draw: the rig's layer count; needs as many texture units (WebGL2 guarantees 16). */
export const MAX_COMPOSITE_LAYERS = 8;

const vertexShader = /* glsl */ `
uniform vec4 uBounds;      // xy: top-left offset from the foot pivot (source px, y down); zw: size (px)
uniform float uPixelsPerUnit;
uniform float uDepthBias;
varying vec2 vPx;
void main() {
  vec4 anchor = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 px = uBounds.xy + position.xy * uBounds.zw;
  vec4 viewPos = vec4(anchor.xyz + vec3(px.x, -px.y, 0.0) / uPixelsPerUnit, 1.0);
  gl_Position = projectionMatrix * viewPos;
  vec4 biased = projectionMatrix * vec4(viewPos.xy, viewPos.z + uDepthBias, 1.0);
  gl_Position.z = biased.z / biased.w * gl_Position.w;
  vPx = px;
}
`;

/** FULL_CACHE bake pass: the same composite, rasterised 1 texel = 1 sprite px into a cell of a cache page. */
const bakeVertexShader = /* glsl */ `
uniform vec4 uBounds;      // the whole cell in sprite px relative to the foot pivot
uniform vec4 uCellNdc;     // cell corners in the cache page: x0, yTop, x1, yBottom (NDC)
varying vec2 vPx;
void main() {
  vPx = uBounds.xy + position.xy * uBounds.zw;
  gl_Position = vec4(mix(uCellNdc.x, uCellNdc.z, position.x), mix(uCellNdc.y, uCellNdc.w, position.y), 0.0, 1.0);
}
`;

function fragmentShader(slots: number, bake = false): string {
  const samplers = Array.from({ length: slots }, (_, i) => `uniform sampler2D uMap${i};`).join('\n');
  const steps = Array.from({ length: slots }, (_, i) => `  if (uCount > ${i}) { vec4 s = layerSample(uMap${i}, uQuad[${i}], uUv[${i}], uRot[${i}]); acc = s + (1.0 - s.a) * acc; }`).join('\n');
  return /* glsl */ `
${samplers}
uniform vec4 uQuad[${slots}];  // per layer: top-left (px from pivot) and size, incl. filter margin
uniform vec4 uUv[${slots}];    // per layer: u0, vTop, u1, vBottom
uniform vec4 uRot[${slots}];   // per layer: cos, sin, rotation pivot (px from the foot pivot); identity (1, 0, 0, 0)
uniform int uCount;
varying vec2 vPx;
vec4 layerSample(sampler2D map, vec4 quad, vec4 uvRect, vec4 rot) {
  vec2 d = vPx - rot.zw;
  vec2 p = rot.zw + vec2(rot.x * d.x + rot.y * d.y, -rot.y * d.x + rot.x * d.y); // inverse RIG rotation
  vec2 t = (p - quad.xy) / quad.zw;
  vec4 c = texture2D(map, vec2(mix(uvRect.x, uvRect.z, t.x), mix(uvRect.y, uvRect.w, t.y)));
  // Half-open [0, 1) like the rasterizer's top-left rule: a pixel centre exactly on a right/bottom edge is outside.
  float inside = step(0.0, t.x) * step(0.0, t.y) * (1.0 - step(1.0, t.x)) * (1.0 - step(1.0, t.y));
  return c * inside; // premultiplied texel, zero outside this layer's quad
}
void main() {
  vec4 acc = vec4(0.0);
${steps}
${bake ? '  // Bake: write every texel (transparent ones too), which also clears the cell gutter.' : '  if (acc.a <= 0.0) discard;'}
  gl_FragColor = acc;
}
`;
}

function compositeUniforms(placeholder: THREE.Texture): Record<string, THREE.IUniform> {
  const uniforms: Record<string, THREE.IUniform> = {
    uBounds: { value: new THREE.Vector4() },
    uQuad: { value: Array.from({ length: MAX_COMPOSITE_LAYERS }, () => new THREE.Vector4()) },
    uUv: { value: Array.from({ length: MAX_COMPOSITE_LAYERS }, () => new THREE.Vector4()) },
    uRot: { value: Array.from({ length: MAX_COMPOSITE_LAYERS }, () => new THREE.Vector4(1, 0, 0, 0)) },
    uCount: { value: 0 },
  };
  for (let i = 0; i < MAX_COMPOSITE_LAYERS; i++) uniforms[`uMap${i}`] = { value: placeholder };
  return uniforms;
}

/** Bake material: premultiplied result written as-is (no blending, no depth) into a FULL_CACHE page cell. */
export function createBakeMaterial(placeholder: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'uvce-sprite-bake',
    uniforms: { ...compositeUniforms(placeholder), uCellNdc: { value: new THREE.Vector4() } },
    vertexShader: bakeVertexShader,
    fragmentShader: fragmentShader(MAX_COMPOSITE_LAYERS, true),
    transparent: false,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NoBlending,
  });
}

/** One resident layer to composite (see ResolvedLayer: dest on the canonical canvas, region on its page). */
export interface CompositeLayerInput {
  layer: UvLayer & { order: number; dest: { x: number; y: number; w: number; h: number }; rotation?: LayerRotation | null };
  page: { width: number; height: number };
  texture: THREE.Texture;
}

/** uRot value of a layer: (cos, sin, pivot relative to the foot pivot), identity when the layer is not rotated. */
export function layerRotationUniform(rotation: LayerRotation | null | undefined, footPivot: { x: number; y: number }, out: THREE.Vector4): THREE.Vector4 {
  if (!rotation) return out.set(1, 0, 0, 0);
  const a = (rotation.deg * Math.PI) / 180;
  return out.set(Math.cos(a), Math.sin(a), rotation.pivot.x - footPivot.x, rotation.pivot.y - footPivot.y);
}

/** The part of a ResolvedLayer that decides its texture coordinates. */
export interface UvLayer {
  region: { x: number; y: number; w: number; h: number };
  /** Optional so hand-built test inputs stay valid; absent = not mirrored. */
  mirror?: boolean;
}

/**
 * UV rect (u0, vTop, u1, vBottom) of a layer's page region grown by the filter margin. A mirrored layer swaps u0 and
 * u1: the margin is symmetric, so this is an exact horizontal flip of the sampled image inside the (mirrored) quad.
 */
export function layerUvRect(layer: UvLayer, page: { width: number; height: number }, m: number, out: THREE.Vector4): THREE.Vector4 {
  const { region } = layer;
  const left = (region.x - m) / page.width;
  const right = (region.x + region.w + m) / page.width;
  return out.set(layer.mirror ? right : left, 1 - (region.y - m) / page.height, layer.mirror ? left : right, 1 - (region.y + region.h + m) / page.height);
}

/**
 * Fills the per-layer uniforms (back to front) of a composite or bake material and returns the union of the layer
 * quads in sprite px relative to the foot pivot (incl. the filter margin).
 */
export function setCompositeLayers(
  u: Record<string, THREE.IUniform>,
  layers: readonly CompositeLayerInput[],
  pivot: { x: number; y: number },
  margin: number,
  placeholder: THREE.Texture,
): { x: number; y: number; w: number; h: number } {
  const quads = u.uQuad?.value as THREE.Vector4[];
  const uvs = u.uUv?.value as THREE.Vector4[];
  const rots = u.uRot?.value as THREE.Vector4[];
  const m = margin;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const ordered = [...layers].sort((a, b) => a.layer.order - b.layer.order);
  ordered.forEach(({ layer, page, texture }, i) => {
    const qx = layer.dest.x - pivot.x - m;
    const qy = layer.dest.y - pivot.y - m;
    const qw = layer.dest.w + 2 * m;
    const qh = layer.dest.h + 2 * m;
    (quads[i] as THREE.Vector4).set(qx, qy, qw, qh);
    layerUvRect(layer, page, m, uvs[i] as THREE.Vector4);
    layerRotationUniform(layer.rotation, pivot, rots[i] as THREE.Vector4);
    (u[`uMap${i}`] as THREE.IUniform).value = texture;
    // A rotated layer covers the bounding box of its rotated quad (canvas coords -> px from the foot pivot).
    const box = layer.rotation ? rotatedBounds({ x: qx + pivot.x, y: qy + pivot.y, w: qw, h: qh }, layer.rotation) : { x: qx + pivot.x, y: qy + pivot.y, w: qw, h: qh };
    x0 = Math.min(x0, box.x - pivot.x);
    y0 = Math.min(y0, box.y - pivot.y);
    x1 = Math.max(x1, box.x - pivot.x + box.w);
    y1 = Math.max(y1, box.y - pivot.y + box.h);
  });
  for (let i = ordered.length; i < MAX_COMPOSITE_LAYERS; i++) (u[`uMap${i}`] as THREE.IUniform).value = placeholder;
  (u.uCount as THREE.IUniform).value = ordered.length;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface CompositeMaterialOptions {
  pixelsPerUnit: number;
  depthBias: number;
  /** Bound to unused slots so every sampler has a valid texture. */
  placeholder: THREE.Texture;
}

export function createCompositeMaterial(options: CompositeMaterialOptions): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    ...compositeUniforms(options.placeholder),
    uPixelsPerUnit: { value: options.pixelsPerUnit },
    uDepthBias: { value: options.depthBias },
  };
  return new THREE.ShaderMaterial({
    name: 'uvce-sprite-composite',
    uniforms,
    vertexShader,
    fragmentShader: fragmentShader(MAX_COMPOSITE_LAYERS),
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}
