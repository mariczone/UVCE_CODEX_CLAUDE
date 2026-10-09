/**
 * Procedural synthetic art. Every function returns a 256x256 straight-alpha RGBA canvas in canonical
 * coordinates. Equipment is drawn ONCE per direction at the rest-pose socket; the runtime moves it with the
 * socket, so equipment never needs per-animation-frame art.
 */
import { type RgbaImage, createImage } from '../../src/uvce/compositor/rgba.ts';
import type { Direction8 } from '../../src/uvce/core/directions.ts';
import type { Vec2 } from '../../src/uvce/core/geometry.ts';
import { type Prng, createPrng, seedFromString } from '../../src/uvce/core/prng.ts';
import { type BodyPose, type Limb, DIR_FRAME, X0, headCenter, restSockets } from './fixture-pose.ts';
import { CANVAS } from './fixture-spec.ts';
import { type Paint, Raster, drawDigits, hex, shade } from './raster.ts';

const C = {
  outline: hex('#392e43'),
  skin: hex('#e9b99d'),
  skinShade: hex('#d29d82'),
  shirt: hex('#938d7d'),
  shirtHem: hex('#7b7567'),
  pants: hex('#6f736f'),
  shoes: hex('#433c46'),
  eye: hex('#352d39'),
  eyeShine: hex('#ffffff', 220),
  mouth: hex('#9a5a55'),
  cheek: hex('#f08a8a', 70),
  label: hex('#fbf3dc'),
};

type ViewClass = 'front' | 'back' | 'side' | 'frontDiag' | 'backDiag';
function viewClass(direction: Direction8): ViewClass {
  switch (DIR_FRAME[direction].base) {
    case 'S':
      return 'front';
    case 'N':
      return 'back';
    case 'E':
      return 'side';
    case 'SE':
      return 'frontDiag';
    case 'NE':
      return 'backDiag';
  }
}
const isBackView = (d: Direction8): boolean => DIR_FRAME[d].base === 'N' || DIR_FRAME[d].base === 'NE';

function canvas(): { image: RgbaImage; r: Raster } {
  const image = createImage(CANVAS, CANVAS);
  return { image, r: new Raster(image) };
}

/** Offsets given in base orientation relative to an origin; x is mirrored for W-ish directions. */
function place(origin: Vec2, s: number, pts: readonly (readonly [number, number])[]): Vec2[] {
  return pts.map(([x, y]) => ({ x: origin.x + s * x, y: origin.y + y }));
}

function rngFor(seed: number, itemId: string, direction: Direction8): Prng {
  return createPrng((seed ^ seedFromString(`${itemId}/${direction}`)) >>> 0);
}

// ---------------------------------------------------------------- body (animated, carries sockets)

function drawLeg(r: Raster, leg: Limb, pose: BodyPose, factor: number): void {
  const ankle = { x: leg.end.x, y: leg.end.y - 8 };
  r.capsuleOutlined(leg.root.x, leg.root.y, ankle.x, ankle.y, 6, shade(C.pants, factor), C.outline, 1.5);
  // Shoe: sole ends exactly on leg.end.y (outline included) so idle feet touch the foot-pivot line.
  const toe = pose.base === 'E' ? 6 : pose.base === 'SE' || pose.base === 'NE' ? 4 : 3;
  const heel = pose.base === 'E' ? -4 : pose.base === 'SE' || pose.base === 'NE' ? -4 : -3;
  const cy = leg.end.y - 5.7;
  r.capsuleOutlined(leg.end.x + pose.s * heel, cy, leg.end.x + pose.s * toe, cy, 4.5, shade(C.shoes, factor), C.outline, 1.2);
}

function drawArm(r: Raster, arm: Limb, factor: number): void {
  const elbow = { x: (arm.root.x + arm.end.x) / 2, y: (arm.root.y + arm.end.y) / 2 };
  r.capsuleOutlined(arm.root.x, arm.root.y, elbow.x, elbow.y, 5.5, shade(C.shirt, factor), C.outline, 1.5);
  r.capsuleOutlined(elbow.x, elbow.y, arm.end.x, arm.end.y - 2, 4.3, shade(C.skin, factor), C.outline, 1.5);
  r.ellipseOutlined(arm.end.x, arm.end.y, 5, 5, shade(C.skin, factor), C.outline, 1.5);
}

/** Body layer: legs, far arm (side/diagonal views), neck, torso; both arms in front/back views. */
export function drawBodyLayer(pose: BodyPose): RgbaImage {
  const { image, r } = canvas();
  const far = 0.82;
  const nearFar = pose.armMode === 'nearFar';
  drawLeg(r, pose.legB, pose, nearFar ? far : 1);
  drawLeg(r, pose.legA, pose, 1);
  if (nearFar) drawArm(r, pose.armB, far);
  r.capsuleOutlined(pose.neckX, 95 + pose.bob, pose.neckX, 106 + pose.bob, 5.5, C.skinShade, C.outline, 1.5);
  r.polygonOutlined(pose.torso, C.shirt, C.outline, 2);
  const xs = pose.torso.filter((p) => p.y === 164 + pose.bob).map((p) => p.x);
  const hx0 = Math.min(...xs) + 1.5;
  const hx1 = Math.max(...xs) - 1.5;
  r.polygon(
    [
      { x: hx0, y: 157 + pose.bob },
      { x: hx1, y: 157 + pose.bob },
      { x: hx1, y: 163 + pose.bob },
      { x: hx0, y: 163 + pose.bob },
    ],
    C.shirtHem,
  );
  if (pose.base === 'S' || pose.base === 'SE') {
    const cx = pose.neckX + (pose.base === 'SE' ? pose.s * 2 : 0);
    r.polygon(place({ x: cx, y: 104 + pose.bob }, pose.s, [[-6, 0], [6, 0], [0, 9]]), C.skinShade);
  }
  if (!nearFar) {
    drawArm(r, pose.armA, 1);
    drawArm(r, pose.armB, 1);
  }
  return image;
}

/** Near arm drawn above armor (side/diagonal views only); null where no arm crosses the torso. */
export function drawArmFrontLayer(pose: BodyPose): RgbaImage | null {
  if (pose.armMode !== 'nearFar') return null;
  const { image, r } = canvas();
  drawArm(r, pose.armA, 1);
  return image;
}

// ---------------------------------------------------------------- head (static, socket: neck)

export function drawHeadLayer(direction: Direction8): RgbaImage {
  const { image, r } = canvas();
  const { base, s } = DIR_FRAME[direction];
  const h = headCenter(direction);
  r.ellipseOutlined(h.x, h.y, 22, 25, C.skin, C.outline, 2);
  const eye = (x: number, y: number, rx: number): void => {
    r.ellipse(x, y, rx, 3, C.eye);
    r.circle(x + 0.8, y - 1, 0.9, C.eyeShine);
  };
  const ear = (x: number): void => r.ellipseOutlined(x, h.y + 5, 3.5, 6, C.skinShade, C.outline, 1.2);
  switch (base) {
    case 'S':
      eye(h.x - 8, h.y + 3, 2.5);
      eye(h.x + 8, h.y + 3, 2.5);
      r.circle(h.x - 13, h.y + 10, 3.5, C.cheek);
      r.circle(h.x + 13, h.y + 10, 3.5, C.cheek);
      r.capsule(h.x - 3, h.y + 14, h.x + 3, h.y + 14, 1.1, C.mouth);
      break;
    case 'SE':
      ear(h.x - s * 20);
      eye(h.x - s * 3, h.y + 3, 2.1);
      eye(h.x + s * 11, h.y + 3, 2.5);
      r.circle(h.x + s * 15, h.y + 10, 3.2, C.cheek);
      r.capsule(h.x + s * 4, h.y + 14, h.x + s * 9, h.y + 14, 1.1, C.mouth);
      break;
    case 'E':
      ear(h.x - s * 2);
      eye(h.x + s * 13, h.y + 3, 2.2);
      r.polygonOutlined(place(h, s, [[20, 3], [26, 9], [20, 11]]), C.skin, C.outline, 1.2);
      r.capsule(h.x + s * 15, h.y + 15, h.x + s * 19, h.y + 15, 1, C.mouth);
      break;
    case 'NE':
      ear(h.x + s * 18);
      break;
    case 'N':
      ear(h.x - 21);
      ear(h.x + 21);
      break;
  }
  return image;
}

// ---------------------------------------------------------------- hair (static, socket: neck)

type ShapeFn = (r: Raster, paint: Paint, grow: number) => void;
/** Union of shapes with a common outline: all shapes grown in outline colour first, then filled. */
function outlinedUnion(r: Raster, shapes: readonly ShapeFn[], fill: Paint, outline: Paint, width: number): void {
  for (const sh of shapes) sh(r, outline, width);
  for (const sh of shapes) sh(r, fill, 0);
}
const ell = (cx: number, cy: number, rx: number, ry: number): ShapeFn => (r, p, g) => r.ellipse(cx, cy, rx + g, ry + g, p);
const cap = (ax: number, ay: number, bx: number, by: number, rad: number): ShapeFn => (r, p, g) => r.capsule(ax, ay, bx, by, rad + g, p);
const poly = (pts: Vec2[]): ShapeFn => (r, p, g) => {
  r.polygon(pts, p);
  if (g > 0) r.strokePolygon(pts, g * 2, p);
};

const HAIR = {
  hair_01: { back: hex('#5b4058'), front: hex('#4a344e'), shine: hex('#8a6a88', 150) },
  hair_02: { back: hex('#a4552e'), front: hex('#c06d3f'), shine: hex('#eaa46c', 160) },
} as const;
type HairId = keyof typeof HAIR;

export function drawHairBack(itemId: string, direction: Direction8, seed: number): RgbaImage {
  const { image, r } = canvas();
  const pal = HAIR[itemId as HairId];
  const { s } = DIR_FRAME[direction];
  const h = headCenter(direction);
  const view = viewClass(direction);
  const long = itemId === 'hair_02';
  let shapes: ShapeFn[];
  if (view === 'side') {
    shapes = long
      ? [poly(place(h, s, [[-2, -26], [-22, -14], [-27, 16], [-25, 54], [-12, 54], [-9, 14]]))]
      : [ell(h.x - s * 9, h.y + 1, 17, 22)];
  } else if (view === 'back' || view === 'backDiag') {
    const cx = h.x - (view === 'backDiag' ? s * 2 : 0);
    shapes = long
      ? [ell(cx, h.y - 3, 26, 27), poly(place({ x: cx, y: h.y }, 1, [[-26, -3], [26, -3], [25, 52], [-25, 52]])), cap(cx - 18, h.y + 50, cx + 18, h.y + 50, 7)]
      : [ell(cx, h.y - 3, 25, 26), cap(cx - 19, h.y + 13, cx + 19, h.y + 13, 7)];
  } else {
    shapes = long
      ? [ell(h.x, h.y - 4, 28, 28), poly(place(h, 1, [[-28, 0], [28, 0], [27, 50], [-27, 50]])), cap(h.x - 19, h.y + 49, h.x + 19, h.y + 49, 8)]
      : [ell(h.x, h.y - 4, 27, 27), cap(h.x - 20, h.y + 14, h.x + 20, h.y + 14, 8)];
  }
  outlinedUnion(r, shapes, pal.back, C.outline, 2);
  if (long && (view === 'back' || view === 'backDiag')) {
    const rng = rngFor(seed, itemId, direction);
    for (let i = 0; i < 4; i++) {
      const x = h.x - 15 + i * 10 + rng.int(-2, 2);
      r.capsule(x, h.y - 10 + rng.int(0, 4), x + rng.int(-2, 2), h.y + 44, 1.1, pal.shine);
    }
  }
  return image;
}

export function drawHairFront(itemId: string, direction: Direction8): RgbaImage | null {
  if (isBackView(direction)) return null; // fringe is hidden behind the head in back views: no frame
  const { image, r } = canvas();
  const pal = HAIR[itemId as HairId];
  const { s } = DIR_FRAME[direction];
  const h = headCenter(direction);
  const view = viewClass(direction);
  const long = itemId === 'hair_02';
  let pts: Vec2[];
  if (view === 'side') {
    pts = place(h, s, long
      ? [[14, -22], [4, -28], [-10, -27], [-22, -17], [-26, 0], [-24, 18], [-16, 24], [-10, 8], [-6, -8], [4, -12], [12, -12], [17, -16]]
      : [[14, -22], [4, -28], [-10, -27], [-21, -17], [-25, -2], [-22, 12], [-14, 18], [-9, 6], [-6, -8], [4, -12], [12, -12], [17, -16]]);
  } else {
    const o = { x: h.x + (view === 'frontDiag' ? s * 3 : 0), y: h.y };
    pts = place(o, s, long
      ? [[-25, 0], [-24, -15], [-14, -25], [2, -28], [16, -24], [24, -14], [25, 4], [19, -6], [8, -12], [-6, -14], [-16, -8]]
      : [[-24, -2], [-23, -14], [-15, -24], [0, -28], [15, -24], [23, -14], [24, -2], [18, -8], [11, -4], [4, -10], [-3, -5], [-10, -10], [-17, -4]]);
  }
  r.polygonOutlined(pts, pal.front, C.outline, 2);
  return image;
}

// ---------------------------------------------------------------- hats (static, socket: head_top)

const HALF_CIRCLE: readonly (readonly [number, number])[] = [
  [1, 0], [0.9659, 0.2588], [0.866, 0.5], [0.7071, 0.7071], [0.5, 0.866], [0.2588, 0.9659], [0, 1],
  [-0.2588, 0.9659], [-0.5, 0.866], [-0.7071, 0.7071], [-0.866, 0.5], [-0.9659, 0.2588], [-1, 0],
];
const STAR: readonly (readonly [number, number])[] = [
  [0, -6], [1.8, -2], [5.7, -1.9], [2.9, 1.2], [3.5, 5.2], [0, 3], [-3.5, 5.2], [-2.9, 1.2], [-5.7, -1.9], [-1.8, -2],
];

export function drawHat(itemId: string, direction: Direction8, seed: number): RgbaImage {
  const { image, r } = canvas();
  const { s } = DIR_FRAME[direction];
  const a = restSockets(direction).head_top;
  const view = viewClass(direction);
  const back = isBackView(direction);
  if (itemId === 'hat_01') {
    const dx = view === 'side' ? -s : 0;
    r.ellipseOutlined(a.x, a.y + 5, 33, 6, hex('#b08a52'), C.outline, 1.5);
    r.polygonOutlined(place({ x: a.x + dx, y: a.y }, 1, [[-16, 5], [-12, -16], [12, -16], [16, 5]]), hex('#926a40'), C.outline, 1.5);
    r.polygon(place({ x: a.x + dx, y: a.y }, 1, [[-15.5, -1], [15.5, -1], [16, 4], [-16, 4]]), hex('#5a3d24'));
    drawDigits(r, '1', a.x + dx - 3, a.y - 14, 2, C.label);
  } else if (itemId === 'hat_02') {
    const tip = view === 'side' ? -s * 7 : view === 'frontDiag' || view === 'backDiag' ? -s * 4 : 3;
    r.ellipseOutlined(a.x, a.y + 6, 29, 6, hex('#57406e'), C.outline, 1.5);
    r.polygonOutlined(place(a, 1, [[-19, 6], [-8, -18], [tip, -40], [8, -18], [19, 6]]), hex('#7c5c98'), C.outline, 1.5);
    const rng = rngFor(seed, itemId, direction);
    r.polygon(place({ x: a.x + rng.int(-2, 2), y: a.y - 24 }, 1, STAR), hex('#f5d76e'));
    drawDigits(r, '2', a.x - 3, a.y - 7, 2, C.label);
  } else {
    const dome = HALF_CIRCLE.map(([c, sn]) => ({ x: a.x + 24 * c, y: a.y + 12 - 20 * sn }));
    r.polygonOutlined(dome, hex('#4d826d'), C.outline, 1.5);
    r.capsuleOutlined(a.x - 23, a.y + 12, a.x + 23, a.y + 12, 3.2, hex('#36604f'), C.outline, 1);
    r.ellipseOutlined(a.x - (view === 'side' ? s * 6 : 0), a.y - 9, 5, 5, hex('#8cc0a8'), C.outline, 1.2);
    drawDigits(r, '3', a.x - 3, a.y - 3, 2, C.label);
    if (!back) {
      // Translucent visor over the eyes: tests partial-alpha compositing over head/hair layers.
      const [x0, x1] = view === 'side' ? [a.x + s * 6, a.x + s * 22] : view === 'frontDiag' ? [a.x - s * 10, a.x + s * 18] : [a.x - 19, a.x + 19];
      r.capsule(x0, a.y + 30, x1, a.y + 30, 5.5, { r: 110, g: 210, b: 255, a: 150 });
      r.capsule(x0, a.y + 24.5, x1, a.y + 24.5, 1.1, hex('#1f5560'));
    }
  }
  return image;
}

// ---------------------------------------------------------------- armor (static, socket: chest)

const ARMOR_SHAPE: Record<'wide' | 'diag' | 'side', readonly (readonly [number, number])[]> = {
  wide: [[-19, -26], [19, -26], [22, -18], [19, 30], [-19, 30], [-22, -18]],
  diag: [[-15, -26], [14, -26], [18, -18], [15, 30], [-16, 30], [-19, -18]],
  side: [[-9, -26], [8, -26], [12, -17], [10, 30], [-10, 30], [-11, -18]],
};
const ROBE_SHAPE: Record<'wide' | 'diag' | 'side', readonly (readonly [number, number])[]> = {
  wide: [[-19, -26], [19, -26], [22, -18], [25, 40], [-25, 40], [-22, -18]],
  diag: [[-15, -26], [14, -26], [18, -18], [21, 40], [-21, 40], [-19, -18]],
  side: [[-9, -26], [8, -26], [12, -17], [15, 40], [-14, 40], [-11, -18]],
};

export function drawArmor(itemId: string, direction: Direction8, seed: number): RgbaImage {
  const { image, r } = canvas();
  const { s } = DIR_FRAME[direction];
  const a = restSockets(direction).chest;
  const view = viewClass(direction);
  const fam = view === 'side' ? 'side' : view === 'front' || view === 'back' ? 'wide' : 'diag';
  const back = isBackView(direction);
  const shift = fam === 'diag' ? s * 2 : 0;
  const halfBelt = fam === 'wide' ? 19.5 : fam === 'diag' ? 16 : 10;
  const labelX = back || fam === 'side' ? a.x - 3 : a.x + shift + s * 6 - (s < 0 ? 6 : 0);
  if (itemId === 'armor_01') {
    r.polygonOutlined(place(a, s, ARMOR_SHAPE[fam]), hex('#51798b'), C.outline, 2);
    if (fam !== 'side') r.polygon(place({ x: a.x + shift, y: a.y }, 1, [[-2.5, -25], [2.5, -25], [2.5, 29], [-2.5, 29]]), hex('#d6c29d'));
    else r.polygon(place(a, s, [[4, -24], [7, -24], [8, 29], [5, 29]]), hex('#d6c29d'));
    r.polygon(place({ x: a.x + shift, y: a.y }, 1, [[-halfBelt, 16], [halfBelt, 16], [halfBelt, 22], [-halfBelt, 22]]), hex('#58434e'));
    r.rect(Math.round(a.x + shift - 3), a.y + 16, Math.round(a.x + shift + 3), a.y + 22, hex('#d9b45a'));
    drawDigits(r, '1', labelX, a.y - 20, 2, C.label);
  } else if (itemId === 'armor_02') {
    const vest =
      fam === 'wide' && !back
        ? [[-18, -26], [-5, -26], [0, -13], [5, -26], [18, -26], [21, -18], [18, 28], [-18, 28], [-21, -18]] as const
        : ARMOR_SHAPE[fam].map(([x, y]) => [x * 0.95, y === 30 ? 28 : y] as const);
    r.polygonOutlined(place(a, s, vest), hex('#a37351'), C.outline, 2);
    const rng = rngFor(seed, itemId, direction);
    const studX = fam === 'wide' ? 13 : fam === 'diag' ? 10 : 5;
    for (const [sx, sy] of [[-studX, -6], [studX, -6], [-studX, 8], [studX, 8]] as const) {
      r.circle(a.x + shift + s * sx + rng.int(-1, 1), a.y + sy + rng.int(-1, 1), 1.6, hex('#e0c080'));
    }
    const pad = hex('#7a5236');
    if (fam === 'wide') {
      r.ellipseOutlined(a.x - 21, a.y - 22, 9, 6.5, pad, C.outline, 1.5);
      r.ellipseOutlined(a.x + 21, a.y - 22, 9, 6.5, pad, C.outline, 1.5);
    } else if (fam === 'diag') {
      r.ellipseOutlined(a.x + s * 15, a.y - 22, 7, 5.5, pad, C.outline, 1.5);
      r.ellipseOutlined(a.x - s * 17, a.y - 22, 9, 6.5, pad, C.outline, 1.5);
    } else r.ellipseOutlined(a.x - s, a.y - 22, 8, 6.5, pad, C.outline, 1.5);
    drawDigits(r, '2', labelX, a.y - 16, 2, C.label);
  } else {
    r.polygonOutlined(place(a, s, ROBE_SHAPE[fam]), hex('#677f5d'), C.outline, 2);
    const hem = fam === 'wide' ? 23 : fam === 'diag' ? 19 : 13;
    r.capsule(a.x - hem, a.y + 37, a.x + hem, a.y + 37, 2.4, hex('#4f6447'));
    const sash: readonly (readonly [number, number])[] =
      fam === 'side' ? [[-7, -24], [-1, -26], [9, 26], [3, 28]] : back ? [[19, -22], [11, -26], [-21, 26], [-13, 30]] : [[-19, -22], [-11, -26], [21, 26], [13, 30]];
    r.polygon(place({ x: a.x + shift, y: a.y }, s, sash), { r: 236, g: 242, b: 255, a: 120 });
    drawDigits(r, '3', labelX, a.y - 20, 2, C.label);
  }
  return image;
}

// ---------------------------------------------------------------- weapons (static, socket: right_hand)

/** Blade/tip vector from the grip, per direction (asymmetric on purpose: right hand). */
const TIP: Record<Direction8, Vec2> = {
  S: { x: -9, y: -66 },
  SE: { x: -5, y: -66 },
  E: { x: 26, y: -60 },
  NE: { x: 8, y: -65 },
  N: { x: 9, y: -66 },
  NW: { x: 5, y: -66 },
  W: { x: -26, y: -60 },
  SW: { x: -8, y: -66 },
};
const OUTWARD: Record<Direction8, 1 | -1> = { S: -1, SE: -1, E: 1, NE: 1, N: 1, NW: 1, W: -1, SW: -1 };

export function drawWeapon(itemId: string, direction: Direction8): RgbaImage {
  const { image, r } = canvas();
  const g = restSockets(direction).right_hand;
  const t = TIP[direction];
  const len = Math.sqrt(t.x * t.x + t.y * t.y);
  const u = { x: t.x / len, y: t.y / len };
  let v = { x: -u.y, y: u.x };
  if (v.x * OUTWARD[direction] < 0) v = { x: -v.x, y: -v.y };
  const p = (along: number, side = 0): Vec2 => ({ x: g.x + u.x * along + v.x * side, y: g.y + u.y * along + v.y * side });
  if (itemId === 'weapon_01') {
    const pommel = p(-9);
    r.ellipseOutlined(pommel.x, pommel.y, 3, 3, hex('#d0b060'), C.outline, 1.2);
    const [g0, g1] = [p(-6), p(6)];
    r.capsuleOutlined(g0.x, g0.y, g1.x, g1.y, 2.3, hex('#5a4030'), C.outline, 1.2);
    const [b0, b1] = [p(10), p(len)];
    r.capsuleOutlined(b0.x, b0.y, b1.x, b1.y, 3.6, hex('#c3d6df'), C.outline, 1.3);
    const [h0, h1] = [p(12, 1), p(len - 4, 1)];
    r.capsule(h0.x, h0.y, h1.x, h1.y, 0.9, hex('#eef6fa'));
    const [q0, q1] = [p(8, -9), p(8, 9)];
    r.capsuleOutlined(q0.x, q0.y, q1.x, q1.y, 2.3, hex('#8b6a42'), C.outline, 1.2);
  } else if (itemId === 'weapon_02') {
    const [s0, s1] = [p(-16), p(len * 1.12)];
    r.capsuleOutlined(s0.x, s0.y, s1.x, s1.y, 2.6, hex('#7f6549'), C.outline, 1.2);
    r.circle(s1.x, s1.y, 12.5, { r: 255, g: 236, b: 150, a: 80 });
    r.ellipseOutlined(s1.x, s1.y, 7, 7, hex('#c4a364'), C.outline, 1.5);
    r.circle(s1.x - 2, s1.y - 2, 2, hex('#ffffff', 180));
  } else {
    const [s0, s1] = [p(-12), p(len * 0.86)];
    r.capsuleOutlined(s0.x, s0.y, s1.x, s1.y, 2.8, hex('#96544b'), C.outline, 1.2);
    const top = len * 0.8;
    r.polygonOutlined([p(top + 5), p(top + 12, 14), p(top + 1, 19), p(top - 10, 14), p(top - 3)], hex('#a6a8b5'), C.outline, 1.5);
    const [e0, e1] = [p(top + 10, 15.5), p(top - 8, 15.5)];
    r.capsule(e0.x, e0.y, e1.x, e1.y, 1.2, hex('#e0e2ea'));
  }
  return image;
}

export { X0 };
