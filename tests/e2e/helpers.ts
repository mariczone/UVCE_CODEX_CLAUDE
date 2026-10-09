import { type Page, expect } from '@playwright/test';

/** Mirror of the window.__UVCE__ object installed by src/app/main.ts (test-only surface). */
export interface UvceTestApi {
  ready: boolean;
  error: string | null;
  environment(): { glVersion: string; glRenderer: string; webgpuAdapter: string; crossOriginIsolated: boolean; viewport: { width: number; height: number } };
  snapshot(): {
    drawCalls: number;
    triangles: number;
    count: number;
    character: { visibleCharacters: number; visibleLayers: number; pendingLayers: number; failedLayers: number; uniqueVisibleAppearances: number; staleBindings: number; compositedCharacters: number; cachedCharacters: number; frameCacheBakes: number; frameCacheEvictions: number; frameCachePaused: boolean; frameCachePauses: number; cacheHitRatio: number | null; plannerCachedGroups: number; plannerGroups: number; plannerSwitches: number };
    registry: RegistryStatsView;
  };
  setCount(n: number): void;
  setSeed(s: number): void;
  setHeroSlot(slot: string, itemId: string | null): void;
  setHeroClip(clip: string): void;
  setHeroDirection(d: string): void;
  setLayerHidden(layer: string, hidden: boolean): void;
  setCameraViewYawDeg(deg: number): void;
  waitForIdle(): Promise<void>;
  heroDebug(): { direction: string; appearanceKey: string; rank: number; issues: { code: string }[]; layers: { layer: string; itemId: string; order: number }[] } | null;
  paintOrder(): string[];
  pageStatuses(): { pageId: string; group: string; state: string; refs: number; error: string | null; fetches: number; evictions: number; cancels: number }[];
  auditBindings(): { visibleLayers: number; violations: number };
  registryStats(): RegistryStatsView;
  loseContext(): boolean;
  restoreContext(): boolean;
  isContextLost(): boolean;
  stormStep(step: number, changes: number): void;
  tick(): void;
  assetTransfer(): { requests: number; pageRequests: number; encodedBytes: number };
}

export interface RegistryStatsView {
  byState: Record<'RESIDENT' | 'UPLOAD_QUEUED' | 'FAILED' | 'EVICTED' | 'REQUESTED' | 'FETCHING', number>;
  fetches: number;
  reloads: number;
  cancelled: number;
  retries: number;
  failures: number;
  uploads: number;
  evictions: number;
  contextLosses: number;
  staleResolves: number;
  prefetchSkipped: number;
  residentBytes: number;
  pinnedBytes: number;
  budgetBytes: number;
  overBudget: boolean;
}

declare global {
  interface Window {
    __UVCE__?: unknown;
  }
}

export async function openApp(page: Page, query = ''): Promise<void> {
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => {
    const api = window.__UVCE__ as { ready?: boolean; error?: string | null } | undefined;
    return api?.ready === true || Boolean(api?.error);
  }, null, { timeout: 60_000 });
  expect(await page.evaluate(() => (window.__UVCE__ as { error: string | null }).error)).toBeNull();
}

/** Runs `fn` against the in-page API (serialisable results only). */
export function api<T, A = undefined>(page: Page, fn: (api: UvceTestApi, arg: A) => T | Promise<T>, arg?: A): Promise<T> {
  return page.evaluate(
    async ([source, a]) => {
      // eslint-disable-next-line no-new-func
      const f = new Function(`return (${source})`)() as (api: unknown, arg: unknown) => unknown;
      return f(window.__UVCE__, a);
    },
    [fn.toString(), arg] as const,
  ) as Promise<T>;
}
