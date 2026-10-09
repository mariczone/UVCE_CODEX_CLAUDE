/**
 * Milestone 2 residency behaviour in the real browser: swap storm with forced evictions, evict + reload pixel
 * parity, and WebGL context-loss recovery without network traffic.
 */
import { expect, test } from '@playwright/test';
import { diffImages } from '../../src/uvce/compositor/rgba.ts';
import { loadCompiledAssets } from '../../tools/uvce/compiled-loader.ts';
import { decodePng } from '../../tools/uvce/png.ts';
import { buildParityExpected } from '../support/parity-expected.ts';
import { api, openApp } from './helpers.ts';

const PAGE_RE = /\/uvce-compiled\/pages\//;

test.describe('residency (Milestone 2)', () => {
  test('swap storm: 100 characters, forced evictions, no stale bindings, budget respected, no refetch without eviction', async ({ page }) => {
    test.setTimeout(180_000);
    // budgetMiB=1 is far below the pinned working set: every page nobody shows is evicted at the next frame.
    await openApp(page, 'test=1&count=100&budgetMiB=1');
    let maxViolations = 0;
    for (let step = 0; step < 60; step++) {
      const audit = await api(page, (u, s: number) => {
        u.stormStep(s, 40);
        u.tick();
        return u.auditBindings();
      }, step);
      maxViolations = Math.max(maxViolations, audit.violations);
      if (step % 3 === 0) await page.waitForTimeout(25); // let fetches/decodes land between frames
    }
    await api(page, (u) => u.waitForIdle());
    const result = await api(page, (u) => ({ stats: u.registryStats(), audit: u.auditBindings(), snap: u.snapshot(), pages: u.pageStatuses() }));
    expect(maxViolations).toBe(0);
    expect(result.audit.violations).toBe(0);
    expect(result.audit.visibleLayers).toBeGreaterThan(400);
    expect(result.snap.character.staleBindings).toBe(0);
    expect(result.stats.failures).toBe(0);
    expect(result.stats.evictions).toBeGreaterThan(5);
    expect(result.stats.reloads).toBeGreaterThan(2);
    // Budget: only pinned pages may stay resident once the pinned set alone exceeds it.
    expect(result.stats.residentBytes).toBe(result.stats.pinnedBytes);
    // A page is only fetched again after it was evicted or its load was cancelled.
    for (const p of result.pages) expect(p.fetches, p.pageId).toBeLessThanOrEqual(1 + p.evictions + p.cancels);
    expect(result.snap.character.pendingLayers + result.snap.character.failedLayers).toBe(0);
  });

  test('evicted pages reload pixel-identically (parity scene, tiny budget)', async ({ page }) => {
    const assets = await loadCompiledAssets('public/uvce-compiled');
    await openApp(page, 'scene=parity&test=1&dir=SE&budgetMiB=1');
    // The companion pins hat_03/armor_03/weapon_02; the hero's own items get evicted as soon as they are swapped away.
    for (const [slot, items] of [['hat', ['hat_02', 'hat_03', 'hat_01']], ['armor', ['armor_02', 'armor_01']], ['weapon', ['weapon_03', 'weapon_01']]] as const) {
      for (const item of items) {
        await api(page, (u, a: [string, string]) => u.setHeroSlot(a[0], a[1]), [slot, item] as [string, string]);
        await api(page, (u) => u.waitForIdle());
        await api(page, (u) => u.waitForIdle()); // one more frame: eviction of what was just released
      }
    }
    const stats = await api(page, (u) => u.registryStats());
    expect(stats.evictions).toBeGreaterThanOrEqual(5);
    expect(stats.reloads).toBeGreaterThanOrEqual(3); // hat_01, armor_01, weapon_01 came back after eviction
    const actual = decodePng(await page.locator('#scene').screenshot()).image;
    const expected = buildParityExpected(assets, { width: actual.width, height: actual.height, direction: 'SE', clipId: 'idle', timeMs: 0, pixelsPerUnit: 128 });
    expect(diffImages(actual, expected, 3).mismatched).toBe(0);
    expect((await api(page, (u) => u.auditBindings())).violations).toBe(0);
  });

  test('WebGL context loss: logical state survives, pages re-upload from decoded copies, no network, same pixels', async ({ page }) => {
    const assets = await loadCompiledAssets('public/uvce-compiled');
    let pageRequests = 0;
    page.on('request', (r) => {
      if (PAGE_RE.test(new URL(r.url()).pathname)) pageRequests++;
    });
    await openApp(page, 'scene=parity&test=1&dir=SE');
    const before = await api(page, (u) => u.registryStats());
    const requestsBefore = pageRequests;
    expect(await api(page, (u) => u.loseContext())).toBe(true);
    await page.waitForFunction(() => (window.__UVCE__ as { isContextLost(): boolean }).isContextLost() === true);
    const lost = await api(page, (u) => u.registryStats());
    expect(lost.byState.RESIDENT).toBe(0); // all GPU resources are gone...
    expect(lost.byState.UPLOAD_QUEUED).toBe(before.byState.RESIDENT); // ...but every page is queued from its decoded copy
    expect(await api(page, (u) => u.restoreContext())).toBe(true);
    await page.waitForFunction(() => (window.__UVCE__ as { isContextLost(): boolean }).isContextLost() === false);
    await api(page, (u) => u.waitForIdle());
    const after = await api(page, (u) => u.registryStats());
    expect(after.contextLosses).toBe(1);
    expect(after.byState.RESIDENT).toBe(before.byState.RESIDENT);
    expect(after.uploads).toBe(before.uploads + before.byState.RESIDENT);
    expect(after.fetches).toBe(before.fetches);
    expect(pageRequests).toBe(requestsBefore);
    const actual = decodePng(await page.locator('#scene').screenshot()).image;
    const expected = buildParityExpected(assets, { width: actual.width, height: actual.height, direction: 'SE', clipId: 'idle', timeMs: 0, pixelsPerUnit: 128 });
    expect(diffImages(actual, expected, 3).mismatched).toBe(0);
  });
});
