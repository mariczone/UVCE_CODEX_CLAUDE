import { expect, test } from '@playwright/test';
import { api, openApp } from './helpers.ts';

test.describe('app boot and scene', () => {
  test('boots on WebGL2 with a validated manifest, one composed character and no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await openApp(page, 'test=1');
    const env = await api(page, (u) => u.environment());
    expect(env.glVersion).toContain('WebGL 2.0');
    expect(env.crossOriginIsolated).toBe(true); // COOP/COEP => fine-grained performance.now() for metrics
    const snap = await api(page, (u) => u.snapshot());
    expect(snap.character.visibleCharacters).toBe(1);
    // SE default look: hair_back, body, armor, arm_front, head, hair_front, hat, weapon
    expect(snap.character.visibleLayers).toBe(8);
    expect(snap.character.pendingLayers + snap.character.failedLayers).toBe(0);
    const hero = await api(page, (u) => u.heroDebug());
    expect(hero?.direction).toBe('SE');
    expect(hero?.layers.map((l) => l.layer)).toEqual(['hair_back', 'body', 'armor', 'arm_front', 'head', 'hair_front', 'hat', 'weapon']);
    await expect(page.getByTestId('env')).toContainText('Render mode: LAYERED');
    expect(errors).toEqual([]);
  });

  test('renders deterministic 1 / 20 / 100 crowds and reports draw calls', async ({ page }) => {
    await openApp(page, 'test=1&seed=1234');
    const results: Record<number, { visible: number; layers: number; draws: number; order: string[] }> = {};
    for (const n of [1, 20, 100]) {
      await page.getByTestId(`count-${n}`).click();
      await api(page, (u) => u.waitForIdle());
      const s = await api(page, (u) => ({ snap: u.snapshot(), order: u.paintOrder() }));
      results[n] = { visible: s.snap.character.visibleCharacters, layers: s.snap.character.visibleLayers, draws: s.snap.drawCalls, order: s.order };
      expect(s.snap.count).toBe(n);
      expect(s.snap.character.visibleCharacters).toBe(n);
      expect(s.snap.drawCalls).toBeGreaterThanOrEqual(s.snap.character.visibleLayers);
    }
    // Same seed after reload => identical painter order (placement + appearance are deterministic).
    await openApp(page, 'test=1&seed=1234&count=100');
    expect(await api(page, (u) => u.paintOrder())).toEqual(results[100]?.order);
    await openApp(page, 'test=1&seed=999&count=100');
    expect(await api(page, (u) => u.paintOrder())).not.toEqual(results[100]?.order);
  });

  test('overlap preset: the character nearer the camera is painted last', async ({ page }) => {
    await openApp(page, 'test=1&count=2');
    expect(await api(page, (u) => u.paintOrder())).toEqual(['npc-0001', 'hero']);
  });

  test('sprite direction is chosen relative to the camera, not from world yaw alone', async ({ page }) => {
    await openApp(page, 'test=1');
    await page.getByTestId('dir-N').click();
    const dir = async (): Promise<string | undefined> => {
      await api(page, (u) => u.waitForIdle());
      return (await api(page, (u) => u.heroDebug()))?.direction;
    };
    expect(await dir()).toBe('N');
    await api(page, (u) => u.setCameraViewYawDeg(180)); // orbit to the other side: we now see the face
    expect(await dir()).toBe('S');
    await api(page, (u) => u.setCameraViewYawDeg(90)); // looking east at a north-facing character
    expect(await dir()).toBe('W');
    for (const d of ['NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N']) {
      await page.getByTestId(`dir-${d}`).click();
      expect(await dir()).toBe(d);
    }
  });
});
