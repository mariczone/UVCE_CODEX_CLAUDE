import { expect, test } from '@playwright/test';
import { api, openApp } from './helpers.ts';

const PAGE_RE = /\/uvce-compiled\/pages\/([a-z0-9_]+)-\d+-[0-9a-f]{12}\.png$/;

test.describe('runtime equipment swaps', () => {
  test('swapping hat / armor / weapon fetches only the newly equipped item page, once', async ({ page }) => {
    const fetched: string[] = [];
    page.on('request', (r) => {
      const m = PAGE_RE.exec(new URL(r.url()).pathname);
      if (m?.[1]) fetched.push(m[1]);
    });
    await openApp(page, 'test=1');
    expect([...fetched].sort()).toEqual(['armor_01', 'body_base', 'hair_01', 'hat_01', 'head_base', 'weapon_01']);
    const swap = async (slot: string, itemId: string): Promise<string[]> => {
      const before = fetched.length;
      await page.getByTestId(`slot-${slot}`).selectOption(itemId);
      await api(page, (u) => u.waitForIdle());
      const hero = await api(page, (u) => u.heroDebug());
      expect(hero?.layers.find((l) => l.layer === slot)?.itemId).toBe(itemId);
      return fetched.slice(before);
    };
    for (const [slot, ids] of [['hat', ['hat_02', 'hat_03']], ['armor', ['armor_02', 'armor_03']], ['weapon', ['weapon_02', 'weapon_03']]] as const) {
      for (const id of ids) expect(await swap(slot, id)).toEqual([id]);
    }
    // Swapping back to already-resident items costs no request at all.
    expect(await swap('hat', 'hat_01')).toEqual([]);
    expect(await swap('armor', 'armor_01')).toEqual([]);
    expect(await swap('weapon', 'weapon_02')).toEqual([]);
    // Every page was requested exactly once during the session.
    expect(new Set(fetched).size).toBe(fetched.length);
    const snap = await api(page, (u) => u.snapshot());
    expect(snap.registry.loads).toBe(fetched.length);
  });

  test('unequipping removes the layer; runtime layer toggles hide and restore layers', async ({ page }) => {
    await openApp(page, 'test=1');
    const layers = async (): Promise<string[]> => {
      await api(page, (u) => u.waitForIdle());
      return ((await api(page, (u) => u.heroDebug()))?.layers ?? []).map((l) => l.layer);
    };
    await page.getByTestId('slot-hat').selectOption('');
    expect(await layers()).not.toContain('hat');
    await page.getByTestId('layer-weapon').uncheck();
    await page.getByTestId('layer-hair_back').uncheck();
    expect(await layers()).toEqual(['body', 'armor', 'arm_front', 'head', 'hair_front']);
    await page.getByTestId('layer-weapon').check();
    expect(await layers()).toContain('weapon');
  });

  test('a page that fails to load shows a placeholder and is not retried in a loop', async ({ page }) => {
    let hits = 0;
    await page.route(/\/pages\/hat_02-/, (route) => {
      hits++;
      return route.fulfill({ status: 404, body: 'missing' });
    });
    await openApp(page, 'test=1');
    await page.getByTestId('slot-hat').selectOption('hat_02');
    await api(page, (u) => u.waitForIdle());
    await page.waitForTimeout(300);
    for (let i = 0; i < 3; i++) {
      await page.getByTestId('slot-hat').selectOption('hat_01');
      await page.getByTestId('slot-hat').selectOption('hat_02');
      await api(page, (u) => u.waitForIdle());
    }
    const statuses = await api(page, (u) => u.pageStatuses());
    expect(statuses.find((s) => s.owner === 'hat_02')?.state).toBe('FAILED');
    const snap = await api(page, (u) => u.snapshot());
    expect(snap.character.failedLayers).toBe(1);
    expect(snap.registry.failed).toBe(1);
    expect(hits).toBe(1);
  });
});
