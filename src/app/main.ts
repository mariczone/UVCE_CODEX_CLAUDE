import './style.css';
import { formatIssues } from '../uvce/core/issues.ts';
import { DisabledAssetFactory } from '../uvce/integrations/asset-factory.ts';
import { resolveRenderMode } from '../uvce/render/feature-flags.ts';
import { parseCompiledManifest } from '../uvce/schema/compiled-manifest.ts';
import { HERO_ID } from '../uvce/bench/crowd.ts';
import { UvceApp } from './app.ts';
import { parseParams } from './params.ts';
import { buildPanel, showFatal } from './ui.ts';

declare global {
  interface Window {
    __UVCE__?: unknown;
  }
}

const ASSET_BASE = `${import.meta.env.BASE_URL}uvce-compiled`;

function webgl2Available(): boolean {
  try {
    return document.createElement('canvas').getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const params = parseParams(location.search);
  const status: { ready: boolean; error: string | null } = { ready: false, error: null };
  window.__UVCE__ = status;
  document.body.classList.toggle('parity', params.scene === 'parity');
  document.body.classList.toggle('studio', params.scene === 'studio');
  document.body.classList.toggle('bench', params.bench);
  document.body.classList.toggle('test', params.test);
  if (!webgl2Available()) {
    status.error = 'WebGL2 unavailable';
    showFatal('WebGL2 is required for the UVCE baseline renderer and is not available in this browser.');
    return;
  }
  let manifestJson: unknown;
  try {
    const res = await fetch(`${ASSET_BASE}/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifestJson = await res.json();
  } catch (e) {
    status.error = `manifest fetch failed: ${(e as Error).message}`;
    showFatal(`Could not load ${ASSET_BASE}/manifest.json (${(e as Error).message}). Run \`pnpm assets\` first.`);
    return;
  }
  const parsed = parseCompiledManifest(manifestJson);
  if (!parsed.ok) {
    status.error = 'invalid manifest';
    showFatal(`Compiled manifest failed validation:\n${formatIssues(parsed.issues)}`);
    return;
  }
  const { mode, fallbackReason } = resolveRenderMode(params.mode);
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const overlayCanvas = document.getElementById('overlay') as HTMLCanvasElement;
  const app = new UvceApp({ canvas, overlayCanvas, params, manifest: parsed.value, assetBaseUrl: ASSET_BASE, renderMode: mode });
  void app.probeWebGpu();
  const factory = await new DisabledAssetFactory().health();
  const panel = buildPanel(document.getElementById('panel') as HTMLElement, app, { fallbackReason, assetFactory: factory.detail });
  // Benchmark mode keeps the main thread free of panel/thumbnail work; metrics come from the test API.
  if (!params.bench) window.setInterval(() => panel.update(), 250);
  window.__UVCE__ = {
    ...status,
    ready: false,
    app,
    environment: () => app.env,
    snapshot: () => app.snapshot(),
    setCount: (n: number) => app.setCount(n),
    setSeed: (s: number) => app.setSeed(s),
    setHeroSlot: (slot: string, itemId: string | null) => app.setHeroSlot(slot, itemId),
    setHeroClip: (clip: string) => app.setHeroClip(clip),
    setHeroDirection: (d: Parameters<UvceApp['setHeroDirection']>[0]) => app.setHeroDirection(d),
    setLayerHidden: (layer: string, hidden: boolean) => app.setLayerHidden(layer, hidden),
    setCameraViewYawDeg: (deg: number) => app.setCameraViewYaw((deg * Math.PI) / 180),
    setTimeMs: (t: number) => {
      app.simTimeMs = t;
    },
    setPaused: (p: boolean) => {
      app.paused = p;
    },
    resetStats: () => app.resetStats(),
    waitForIdle: () => app.waitForIdle(),
    heroDebug: () => {
      const d = app.characters.debugInfo(HERO_ID);
      return d ? { direction: d.direction, appearanceKey: d.appearanceKey, rank: d.rank, issues: d.appearanceIssues, layers: d.pose?.layers.map((l) => ({ layer: l.layer, itemId: l.itemId, dest: l.dest, order: l.order })) ?? [] } : null;
    },
    paintOrder: () => app.characters.paintOrder(),
    pageStatuses: () => app.registry.pageStatuses(),
    /** Browser-measured transfer of compiled assets (Resource Timing), for benchmarks. */
    assetTransfer: () => {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const assets = entries.filter((e) => e.name.includes('/uvce-compiled/'));
      return {
        requests: assets.length,
        pageRequests: assets.filter((e) => e.name.includes('/pages/')).length,
        encodedBytes: assets.reduce((s, e) => s + e.encodedBodySize, 0),
        decodedBytes: assets.reduce((s, e) => s + e.decodedBodySize, 0),
      };
    },
  };
  app.start();
  await app.waitForIdle();
  (window.__UVCE__ as { ready: boolean }).ready = true;
  document.body.dataset.ready = '1';
}

main().catch((e: unknown) => {
  console.error(e);
  window.__UVCE__ = { ready: false, error: String(e) };
  showFatal(`Startup failed: ${String(e)}`);
});
