/** Small 3D stage: lit ground + opaque props that test sprite occlusion (wall, pillars, arch). */
import * as THREE from 'three';
import { PARITY_CLEAR, type ParityVariant } from './parity-scenes.ts';

export interface Stage {
  objects: THREE.Object3D[];
  dispose(): void;
}

function checkerTexture(): THREE.DataTexture {
  const n = 2;
  const d = new Uint8Array([
    120, 132, 104, 255, 104, 116, 90, 255,
    104, 116, 90, 255, 120, 132, 104, 255,
  ]);
  const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.repeat.set(16, 16);
  t.needsUpdate = true;
  return t;
}

export function createStage(scene: THREE.Scene): Stage {
  const objects: THREE.Object3D[] = [];
  const disposables: { dispose(): void }[] = [];
  const add = <T extends THREE.Object3D>(o: T): T => {
    scene.add(o);
    objects.push(o);
    return o;
  };
  scene.background = new THREE.Color('#9fb7c9');
  scene.fog = new THREE.Fog('#9fb7c9', 18, 40);
  add(new THREE.HemisphereLight('#e6f0ff', '#5a5040', 1.6));
  const sun = add(new THREE.DirectionalLight('#fff3dc', 2.2));
  sun.position.set(-4, 8, 6);

  const tex = checkerTexture();
  const groundMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
  const groundGeo = new THREE.PlaneGeometry(32, 32).rotateX(-Math.PI / 2);
  const ground = add(new THREE.Mesh(groundGeo, groundMat));
  ground.name = 'ground';
  disposables.push(tex, groundMat, groundGeo);

  const stone = new THREE.MeshStandardMaterial({ color: '#8d8478', roughness: 0.9 });
  const darkStone = new THREE.MeshStandardMaterial({ color: '#6c655d', roughness: 0.9 });
  disposables.push(stone, darkStone);
  const box = (w: number, h: number, d: number, x: number, z: number, mat: THREE.Material, name: string, y = h / 2): THREE.Mesh => {
    const g = new THREE.BoxGeometry(w, h, d);
    disposables.push(g);
    const m = add(new THREE.Mesh(g, mat));
    m.position.set(x, y, z);
    m.name = name;
    return m;
  };
  // Low wall in front-left of the spawn: hides lower bodies of characters behind it.
  box(2.6, 0.9, 0.35, -2.4, 1.9, stone, 'wall-low');
  // Tall pillars: full occluders.
  for (const [x, z] of [[2.6, 0.6], [-3.2, -2.2]] as const) {
    const g = new THREE.CylinderGeometry(0.28, 0.32, 2.6, 20);
    disposables.push(g);
    const p = add(new THREE.Mesh(g, darkStone));
    p.position.set(x, 1.3, z);
    p.name = 'pillar';
  }
  // Arch: characters can stand under the lintel.
  box(0.4, 2.2, 0.4, 0.9, -3.0, stone, 'arch-left');
  box(0.4, 2.2, 0.4, 3.1, -3.0, stone, 'arch-right');
  box(2.6, 0.35, 0.45, 2.0, -3.0, darkStone, 'arch-lintel', 2.375);
  return {
    objects,
    dispose() {
      for (const o of objects) scene.remove(o);
      for (const d of disposables) d.dispose();
    },
  };
}

/** A transparent world object that must be depth-sorted together with the characters. */
export interface SortableObject {
  id: string;
  object: THREE.Object3D;
}

export interface ParityStage extends Stage {
  sortables: SortableObject[];
}

/**
 * Pixel-parity test stage built from a declarative variant (src/app/parity-scenes.ts): flat unlit colours only,
 * so the expected image can be computed exactly on the CPU. Opaque boxes are normal scene meshes (depth-tested);
 * translucent boxes are returned as sortables for the character painter sort.
 */
export function createParityStage(scene: THREE.Scene, variant: ParityVariant): ParityStage {
  const objects: THREE.Object3D[] = [];
  const disposables: { dispose(): void }[] = [];
  const sortables: SortableObject[] = [];
  scene.background = new THREE.Color(PARITY_CLEAR);
  for (const e of variant.elements) {
    if (e.kind !== 'box') continue;
    const g = new THREE.BoxGeometry(e.size[0], e.size[1], e.size[2]);
    const translucent = e.opacity !== undefined && e.opacity < 1;
    const m = new THREE.MeshBasicMaterial({ color: e.color, transparent: translucent, opacity: e.opacity ?? 1, depthWrite: !translucent });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = e.id;
    mesh.position.set(e.center[0], e.center[1], e.center[2]);
    disposables.push(g, m);
    if (translucent) sortables.push({ id: e.id, object: mesh });
    else {
      scene.add(mesh);
      objects.push(mesh);
    }
  }
  return {
    objects,
    sortables,
    dispose() {
      for (const o of objects) scene.remove(o);
      for (const s2 of sortables) s2.object.removeFromParent();
      for (const d of disposables) d.dispose();
    },
  };
}

/** Orthographic camera where 1 canvas pixel == 1 sprite pixel at pixelsPerUnit, looking along -Z. */
export function createPixelCamera(width: number, height: number, pixelsPerUnit: number, center: readonly [number, number]): THREE.OrthographicCamera {
  const hw = width / 2 / pixelsPerUnit;
  const hh = height / 2 / pixelsPerUnit;
  const cam = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 0.1, 50);
  cam.position.set(center[0], center[1], 10);
  cam.lookAt(center[0], center[1], 0);
  return cam;
}

/** Studio: flat background only (screenshots / visual review through the real GPU path). */
export function createStudioStage(scene: THREE.Scene): Stage {
  scene.background = new THREE.Color(PARITY_CLEAR);
  return { objects: [], dispose() {} };
}
