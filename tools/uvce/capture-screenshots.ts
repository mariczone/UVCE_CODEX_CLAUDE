/**
 * Captures REAL browser screenshots (headless Chromium, WebGL2 via SwiftShader) into docs/screenshots/.
 *   pnpm build && pnpm screenshots
 * Strips (directions, equipment, walk cycle) are crops of studio-scene renders (pixel camera, 1 px = 1 sprite px).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { type RgbaImage, blitOver, createImage, cropImage, fillImage } from '../../src/uvce/compositor/rgba.ts';
import { DIRECTIONS } from '../../src/uvce/core/directions.ts';
import { launchChromium, startPreviewServer } from './browser.ts';
import { decodePng, encodePng } from './png.ts';

const OUT = 'docs/screenshots';
const VIEW = { width: 1280, height: 720 };
// Studio pixel camera: foot pivot of the hero lands at (640, 488); its 256x256 canvas starts at (512, 260).
const HERO_CANVAS = { x: 512, y: 260 };
const CROP = { x: HERO_CANVAS.x + 48, y: HERO_CANVAS.y + 2, w: 160, h: 230 };

async function open(page: Page, base: string, query: string): Promise<void> {
  await page.goto(`${base}/?${query}`);
  await page.waitForFunction(() => {
    const u = (window as unknown as { __UVCE__?: { ready?: boolean; error?: string } }).__UVCE__;
    return u?.ready === true || Boolean(u?.error);
  }, null, { timeout: 60_000 });
}

async function canvasShot(page: Page): Promise<RgbaImage> {
  return decodePng(await page.locator('#scene').screenshot()).image;
}

function strip(images: RgbaImage[], columns: number): RgbaImage {
  const w = CROP.w;
  const h = CROP.h;
  const rows = Math.ceil(images.length / columns);
  const out = createImage(w * columns, h * rows);
  fillImage(out, 58, 64, 74, 255);
  images.forEach((img, i) => blitOver(out, img, (i % columns) * w, Math.floor(i / columns) * h));
  return out;
}

const server = await startPreviewServer(4176);
const browser = await launchChromium({ swiftshader: true });
try {
  await mkdir(OUT, { recursive: true });
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
  const written: string[] = [];
  const save = async (name: string, png: Buffer): Promise<void> => {
    await writeFile(`${OUT}/${name}`, png);
    written.push(name);
  };

  // Full-app views (stage scene, perspective camera, deterministic test mode).
  for (const [name, query] of [
    ['app-hero-debug-overlay.png', 'test=1&debug=1'],
    ['app-overlap-2.png', 'test=1&count=2'],
    ['app-crowd-20.png', 'test=1&count=20'],
    ['app-crowd-100.png', 'test=1&count=100'],
    ['app-crowd-300.png', 'test=1&count=300'],
  ] as const) {
    await open(page, server.url, query);
    await save(name, await page.screenshot());
  }

  // Atlas page viewer (side panel) after equipping a second hat: shows the pages + residency state.
  // The panel scrolls internally, so use a viewport tall enough to lay the whole section out unclipped.
  const tall = await browser.newPage({ viewport: { width: VIEW.width, height: 4200 }, deviceScaleFactor: 1 });
  await open(tall, server.url, 'test=1');
  await tall.getByTestId('slot-hat').selectOption('hat_02');
  // Wait until the swap is resident, then for at least one panel refresh (every ~450 ms) to show it.
  await tall.evaluate(() => (window as unknown as { __UVCE__: { waitForIdle(): Promise<void> } }).__UVCE__.waitForIdle());
  await tall.waitForTimeout(1000);
  await save('app-panel-source-pages.png', await tall.locator('section', { hasText: 'Source pages' }).screenshot());
  await tall.close();

  // Pixel-parity scene (the one compared against the CPU reference in tests/e2e/parity.spec.ts).
  await open(page, server.url, 'scene=parity&test=1');
  await save('parity-scene.png', encodePng(cropImage(await canvasShot(page), { x: 440, y: 230, w: 460, h: 270 })));

  // 8 directions, idle frame 0.
  const dirs: RgbaImage[] = [];
  for (const d of DIRECTIONS) {
    await open(page, server.url, `scene=studio&test=1&dir=${d}`);
    dirs.push(cropImage(await canvasShot(page), CROP));
  }
  await save('browser-8-directions.png', encodePng(strip(dirs, 8)));

  // Equipment swaps: 3 hats, 3 armors, 3 weapons on the same body (no outfit sheets involved).
  const equip: RgbaImage[] = [];
  for (const [slot, ids] of [['hat', ['hat_01', 'hat_02', 'hat_03']], ['armor', ['armor_01', 'armor_02', 'armor_03']], ['weapon', ['weapon_01', 'weapon_02', 'weapon_03']]] as const) {
    for (const id of ids) {
      await open(page, server.url, `scene=studio&test=1&dir=SE&${slot}=${id}`);
      equip.push(cropImage(await canvasShot(page), CROP));
    }
  }
  await save('browser-equipment-3x3.png', encodePng(strip(equip, 9)));

  // Walk cycle, 8 frames facing E (socket-attached hat/weapon follow the body).
  const walk: RgbaImage[] = [];
  for (let f = 0; f < 8; f++) {
    await open(page, server.url, `scene=studio&test=1&dir=E&clip=walk&t=${f * 100 + 50}`);
    walk.push(cropImage(await canvasShot(page), CROP));
  }
  await save('browser-walk-cycle-E.png', encodePng(strip(walk, 8)));
  console.log(`[screenshots] ${written.length} files -> ${OUT}: ${written.join(', ')}`);
} finally {
  await browser.close();
  server.stop();
}
