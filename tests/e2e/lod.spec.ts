/** Milestone 4 projected-size LOD in the real app (lod=1). */
import { expect, test } from '@playwright/test';
import { diffImages } from '../../src/uvce/compositor/rgba.ts';
import { decodePng } from '../../tools/uvce/png.ts';
import { api, openApp } from './helpers.ts';

test.describe('projected-size LOD', () => {
    test('levels follow projected size: the close 20 framing is HIGH/MEDIUM, the distant 300 framing is all LOW', async ({ page }) => {
    await openApp(page, 'test=1&seed=1234&count=20&lod=1&animBudget=40');
    await api(page, (u) => u.waitForIdle());
    const near = (await api(page, (u) => u.snapshot())).character;
    await page.getByTestId('count-300').click();
    await api(page, (u) => u.waitForIdle());
    for (let i = 0; i < 30; i++) await api(page, (u) => u.tick());
    const crowd = (await api(page, (u) => u.snapshot())).character;
    console.log(`[lod] levels high/medium/low/tiny: count 20 ${near.lodLevels.join('/')}, count 300 ${crowd.lodLevels.join('/')}`);
    for (const c of [near, crowd]) {
      expect(c.lodEnabled).toBe(true);
      expect(c.lodLevels.reduce((a, b) => a + b, 0)).toBe(c.visibleCharacters);
      expect(c.staleBindings).toBe(0);
    }
    expect((near.lodLevels[0] as number) + (near.lodLevels[1] as number)).toBe(near.visibleCharacters);
    expect(crowd.lodLevels[2]).toBe(crowd.visibleCharacters); // camera at 27 units: the 256 px canvas projects to ~60–75 px
    expect((await api(page, (u) => u.auditBindings())).violations).toBe(0);
    await openApp(page, 'test=1&seed=1234&count=300');
    const off = await api(page, (u) => u.snapshot());
    expect(off.character.lodEnabled).toBe(false);
    expect(off.character.lodLevels).toEqual([0, 0, 0, 0]);
  });
test('pixel-scale characters stay HIGH: the parity frame is identical with and without LOD', async ({ page }) => {
    await openApp(page, 'scene=parity&test=1&dir=W&clip=walk&t=720');
    const without = decodePng(await page.locator('#scene').screenshot()).image;
    await openApp(page, 'scene=parity&test=1&dir=W&clip=walk&t=720&lod=1&animBudget=0');
    const withLod = decodePng(await page.locator('#scene').screenshot()).image;
    expect((await api(page, (u) => u.snapshot())).character.lodLevels[0]).toBe(2);
    expect(diffImages(withLod, without, 0).mismatched).toBe(0);
  });
});
