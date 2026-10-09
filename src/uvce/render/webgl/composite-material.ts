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

function fragmentShader(slots: number): string {
  const samplers = Array.from({ length: slots }, (_, i) => `uniform sampler2D uMap${i};`).join('\n');
  const steps = Array.from({ length: slots }, (_, i) => `  if (uCount > ${i}) { vec4 s = layerSample(uMap${i}, uQuad[${i}], uUv[${i}]); acc = s + (1.0 - s.a) * acc; }`).join('\n');
  return /* glsl */ `
${samplers}
uniform vec4 uQuad[${slots}];  // per layer: top-left (px from pivot) and size, incl. filter margin
uniform vec4 uUv[${slots}];    // per layer: u0, vTop, u1, vBottom
uniform int uCount;
varying vec2 vPx;
vec4 layerSample(sampler2D map, vec4 quad, vec4 uvRect) {
  vec2 t = (vPx - quad.xy) / quad.zw;
  vec4 c = texture2D(map, vec2(mix(uvRect.x, uvRect.z, t.x), mix(uvRect.y, uvRect.w, t.y)));
  // Half-open [0, 1) like the rasterizer's top-left rule: a pixel centre exactly on a right/bottom edge is outside.
  float inside = step(0.0, t.x) * step(0.0, t.y) * (1.0 - step(1.0, t.x)) * (1.0 - step(1.0, t.y));
  return c * inside; // premultiplied texel, zero outside this layer's quad
}
void main() {
  vec4 acc = vec4(0.0);
${steps}
  if (acc.a <= 0.0) discard;
  gl_FragColor = acc;
}
`;
}

export interface CompositeMaterialOptions {
  pixelsPerUnit: number;
  depthBias: number;
  /** Bound to unused slots so every sampler has a valid texture. */
  placeholder: THREE.Texture;
}

export function createCompositeMaterial(options: CompositeMaterialOptions): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    uBounds: { value: new THREE.Vector4() },
    uPixelsPerUnit: { value: options.pixelsPerUnit },
    uDepthBias: { value: options.depthBias },
    uQuad: { value: Array.from({ length: MAX_COMPOSITE_LAYERS }, () => new THREE.Vector4()) },
    uUv: { value: Array.from({ length: MAX_COMPOSITE_LAYERS }, () => new THREE.Vector4()) },
    uCount: { value: 0 },
  };
  for (let i = 0; i < MAX_COMPOSITE_LAYERS; i++) uniforms[`uMap${i}`] = { value: options.placeholder };
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
