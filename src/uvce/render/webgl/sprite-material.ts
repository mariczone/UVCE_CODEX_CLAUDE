/**
 * WebGL2 sprite-layer material (GLSL, three.js ShaderMaterial). Isolated here because WebGPURenderer
 * cannot run ShaderMaterial: a WebGPU backend would provide an equivalent TSL/node material instead.
 *
 * Contract:
 * - Page textures hold straight-alpha sRGB PNG data, uploaded with UNPACK_PREMULTIPLY_ALPHA_WEBGL and
 *   NoColorSpace (no sRGB decode). The shader outputs those premultiplied values unchanged, blended with
 *   ONE / ONE_MINUS_SRC_ALPHA. That equals straight-alpha "over" in 8-bit sRGB space, i.e. exactly what
 *   the CPU reference compositor computes (single premultiplication, no double-premultiply).
 * - The quad is built in VIEW space at the character's foot anchor, so it is always screen-aligned and has
 *   one constant depth: the foot depth, pulled toward the camera by uDepthBias world units (keeps feet
 *   from z-fighting the ground). depthTest on, depthWrite off: 3D geometry occludes sprites, sprites never
 *   occlude each other through depth (painter order handles that).
 */
import * as THREE from 'three';

// RIG rotation (Milestone 4) is NOT done by rotating the vertices: the rasterizer snaps rotated corners to its
// sub-pixel grid, which shifts the affine texture mapping slightly and flips nearest samples near texel edges. A rotated
// layer instead draws its axis-aligned bounding box (uBox) and inverse-rotates each fragment, exactly like the SHADER
// composite and the CPU reference (blitOverRotated). Unrotated layers keep the interpolated-UV path (uBox = uQuad).
const vertexShader = /* glsl */ `
uniform vec4 uQuad;        // layer rect incl. filter margin: xy top-left offset from the foot pivot (px, y down), zw size
uniform vec4 uBox;         // drawn rect (= uQuad, or the bounding box of the rotated uQuad)
uniform vec4 uUvRect;      // u0, vTop, u1, vBottom
uniform float uPixelsPerUnit;
uniform float uDepthBias;
varying vec2 vUv;
varying vec2 vPx;
void main() {
  vec4 anchor = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 px = uBox.xy + position.xy * uBox.zw;
  vec4 viewPos = vec4(anchor.xyz + vec3(px.x, -px.y, 0.0) / uPixelsPerUnit, 1.0);
  gl_Position = projectionMatrix * viewPos;
  vec4 biased = projectionMatrix * vec4(viewPos.xy, viewPos.z + uDepthBias, 1.0);
  gl_Position.z = biased.z / biased.w * gl_Position.w;
  vUv = vec2(mix(uUvRect.x, uUvRect.z, position.x), mix(uUvRect.y, uUvRect.w, position.y));
  vPx = px;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
uniform vec4 uQuad;
uniform vec4 uUvRect;
uniform vec4 uRot;         // RIG rotation: cos, sin, pivot (px from the foot pivot, y down); identity (1, 0, 0, 0)
varying vec2 vUv;
varying vec2 vPx;
void main() {
  vec4 color;
  if (uRot.y == 0.0 && uRot.x == 1.0) {
    color = texture2D(uMap, vUv);
  } else {
    vec2 d = vPx - uRot.zw;
    vec2 p = uRot.zw + vec2(uRot.x * d.x + uRot.y * d.y, -uRot.y * d.x + uRot.x * d.y); // inverse rotation
    vec2 t = (p - uQuad.xy) / uQuad.zw;
    color = texture2D(uMap, vec2(mix(uUvRect.x, uUvRect.z, t.x), mix(uUvRect.y, uUvRect.w, t.y)));
    color *= step(0.0, t.x) * step(0.0, t.y) * (1.0 - step(1.0, t.x)) * (1.0 - step(1.0, t.y));
  }
  color *= uOpacity; // premultiplied
  if (color.a <= 0.0) discard;
  gl_FragColor = color;
}
`;

export interface SpriteMaterialOptions {
  pixelsPerUnit: number;
  depthBias: number;
}

export function createSpriteLayerMaterial(options: SpriteMaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'uvce-sprite-layer',
    uniforms: {
      uMap: { value: null },
      uQuad: { value: new THREE.Vector4() },
      uBox: { value: new THREE.Vector4() },
      uUvRect: { value: new THREE.Vector4() },
      uRot: { value: new THREE.Vector4(1, 0, 0, 0) },
      uPixelsPerUnit: { value: options.pixelsPerUnit },
      uDepthBias: { value: options.depthBias },
      uOpacity: { value: 1 },
    },
    vertexShader,
    fragmentShader,
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

/** Unit quad: corners (0,0) top-left .. (1,1) bottom-right in sprite space; expanded in the shader. */
export function createUnitQuadGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3));
  g.setIndex([0, 2, 1, 1, 2, 3]);
  return g;
}

/** Magenta/black checker shown for layers whose pages FAILED to load (visible fallback, not silence). */
export function createMissingTexture(): THREE.DataTexture {
  const d = new Uint8Array([255, 0, 255, 255, 30, 0, 30, 255, 30, 0, 30, 255, 255, 0, 255, 255]);
  const t = new THREE.DataTexture(d, 2, 2, THREE.RGBAFormat);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}
