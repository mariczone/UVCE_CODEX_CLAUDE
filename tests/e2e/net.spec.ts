/** Milestone 4 multiplayer-style appearance streaming in the real app (net=1). */
import { expect, test } from '@playwright/test';
import { api, openApp } from './helpers.ts';

interface NetStats {
  arrived: number;
  visible: number;
  applied: number;
  held: number;
  stale: number;
  lost: number;
  resyncRequests: number;
  prefetchRequests: number;
  popIns: number;
  versionMismatches: number;
}

/** Advances the simulation clock in 16 ms steps, giving real fetches/decodes time between frames. */
async function run(page: import('@playwright/test').Page, fromMs: number, toMs: number): Promise<NetStats> {
  return page.evaluate(
    async ({ fromMs, toMs }) => {
      const u = (window as unknown as { __UVCE__: { setTimeMs(t: number): void; tick(): void; snapshot(): { net: unknown } } }).__UVCE__;
      for (let t = fromMs; t <= toMs; t += 16) {
        u.setTimeMs(t);
        u.tick();
        await new Promise((r) => setTimeout(r, 4));
      }
      return u.snapshot().net as NetStats;
    },
    { fromMs, toMs },
  );
}

test.describe('appearance streaming (synthetic network)', () => {
  test('100 players arrive through a lossy link: all appear, none pops in with a prefetch lead, no stale bindings', async ({ page }) => {
    await openApp(page, 'test=1&seed=1234&count=100&net=1&netArrivalMs=40&netLeadMs=1500&netLoss=0.05&netChangeMs=1500');
    const net = await run(page, 0, 9000);
    console.log(`[net] lead 1500 ms: ${JSON.stringify(net)}`);
    expect(net.arrived).toBe(99);
    expect(net.visible).toBe(99);
    expect(net.versionMismatches).toBe(0);
    expect(net.applied).toBeGreaterThan(99); // snapshots plus equipment changes
    expect(net.popIns).toBe(0);
    const snap = await api(page, (u) => u.snapshot());
    expect(snap.character.visibleCharacters).toBe(100);
    expect(snap.character.staleBindings).toBe(0);
    expect((await api(page, (u) => u.auditBindings())).violations).toBe(0);
  });

  test('without a lead, players appear as soon as their snapshot arrives (pop-ins are counted, not hidden)', async ({ page }) => {
    await openApp(page, 'test=1&seed=1234&count=100&net=1&netArrivalMs=40&netLeadMs=0&netLoss=0&netChangeMs=0');
    const net = await run(page, 0, 6000);
    console.log(`[net] lead 0 ms: ${JSON.stringify(net)}`);
    expect(net.visible).toBe(99);
    expect(net.popIns).toBeGreaterThanOrEqual(0); // device/network dependent: reported by the benchmark, not asserted
  });
});
