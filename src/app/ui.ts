import { HERO_ID } from '../uvce/bench/crowd.ts';
import type { Direction8 } from '../uvce/core/directions.ts';
import { FEATURES } from '../uvce/render/feature-flags.ts';
import type { UvceApp } from './app.ts';

type Attrs = Record<string, string | number | boolean | ((e: Event) => void)>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') node.addEventListener(k.replace(/^on/, ''), v);
    else if (typeof v === 'boolean') {
      if (v) node.setAttribute(k, '');
    } else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

function section(title: string, ...children: (Node | string)[]): HTMLElement {
  return el('section', {}, [el('h2', {}, [title]), ...children]);
}

const fmt = (v: number, digits = 2): string => (Number.isFinite(v) ? v.toFixed(digits) : 'n/a');

export interface PanelExtras {
  fallbackReason: string | null;
  assetFactory: string;
}

export function buildPanel(root: HTMLElement, app: UvceApp, extras: PanelExtras): { update(): void } {
  const index = app.index;
  root.replaceChildren();
  const webgpuLine = el('span', { 'data-testid': 'webgpu' });
  const webgpuText = (): string =>
    `WebGPU: ${{ available: 'adapter available (not used; WebGL2 baseline, M5)', none: 'API exposed but no adapter', 'not-exposed': 'not exposed by this browser', error: 'adapter request failed', pending: 'probing…' }[app.env.webgpuAdapter]} · manifest ${index.manifest.manifestVersion}`;
  root.append(
    el('header', {}, [
      el('h1', {}, ['UVCE POC · Milestone 0']),
      el('p', { class: 'muted' }, ['Modular RGBA sprite characters in a Three.js 2.5D scene. Synthetic placeholder art.']),
      el('p', { class: 'env', 'data-testid': 'env' }, [
        `WebGL2 · ${app.env.glRenderer}`,
        el('br'),
        `Render mode: ${app.renderMode}${extras.fallbackReason ? ` (requested mode unavailable: ${extras.fallbackReason})` : ''}`,
        el('br'),
        webgpuLine,
      ]),
    ]),
  );

  // ---------- scene
  const counts: [number, string][] = [[1, '1'], [2, '2 overlap'], [20, '20'], [100, '100'], [300, '300']];
  const countRow = el('div', { class: 'row' });
  const countButtons = counts.map(([n, label]) =>
    el('button', { 'data-testid': `count-${n}`, onclick: () => { app.setCount(n); refreshCountButtons(); } }, [label]),
  );
  countRow.append(...countButtons);
  const refreshCountButtons = (): void => countButtons.forEach((b, i) => b.classList.toggle('active', counts[i]?.[0] === app.count));
  refreshCountButtons();
  const seedInput = el('input', { type: 'number', value: app.seed, 'data-testid': 'seed', min: 0 });
  const playButton = el('button', { 'data-testid': 'play', onclick: () => { app.paused = !app.paused; playButton.textContent = app.paused ? 'Play' : 'Pause'; } }, [app.paused ? 'Play' : 'Pause']);
  const speed = el('select', { onchange: () => { app.timeScale = Number(speed.value); } }, ['0.25', '0.5', '1', '2'].map((v) => el('option', { value: v, selected: v === '1' }, [`${v}x`])));
  root.append(
    section(
      'Scene',
      countRow,
      el('div', { class: 'row' }, [
        el('label', {}, ['seed ', seedInput]),
        el('button', { onclick: () => app.setSeed(Number(seedInput.value)) }, ['apply']),
      ]),
      el('div', { class: 'row' }, [playButton, speed, el('button', { onclick: () => app.frameCamera() }, ['reset camera'])]),
      el('p', { class: 'muted' }, ['Drag to orbit (sprite direction follows the camera), wheel to zoom.']),
    ),
  );

  // ---------- hero
  const clip = el('select', { 'data-testid': 'hero-clip', onchange: () => app.setHeroClip(clip.value) }, [...index.clips.keys()].map((c) => el('option', { value: c, selected: c === app.heroClipId }, [c])));
  const pad = el('div', { class: 'dirpad' });
  for (const d of ['NW', 'N', 'NE', 'W', '', 'E', 'SW', 'S', 'SE'] as const) {
    pad.append(d ? el('button', { 'data-testid': `dir-${d}`, onclick: () => app.setHeroDirection(d as Direction8) }, [d]) : el('span'));
  }
  const auto = el('input', { type: 'checkbox', onchange: () => { app.heroAutoTurn = auto.checked; } });
  const slotSelects = ['hair', 'hat', 'armor', 'weapon'].map((slot) => {
    const items = [...(index.itemsBySlot.get(slot) ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1));
    const current = app.heroAppearance.slots[slot]?.itemId ?? '';
    const select = el('select', { 'data-testid': `slot-${slot}`, onchange: () => app.setHeroSlot(slot, select.value || null) }, [
      el('option', { value: '', selected: current === '' }, ['none']),
      ...items.map((i) => el('option', { value: i.id, selected: i.id === current }, [i.displayName])),
    ]);
    return el('label', { class: 'slot' }, [el('span', {}, [slot]), select]);
  });
  root.append(
    section(
      'Hero (character #0)',
      el('div', { class: 'row' }, [el('label', {}, ['clip ', clip]), el('label', {}, [auto, ' auto-turn'])]),
      el('div', { class: 'row' }, [pad, el('p', { class: 'muted small' }, ['Direction is chosen relative to the camera: orbiting changes the displayed sprite direction.'])]),
      ...slotSelects,
      el('p', { class: 'muted small' }, ['Equipment swaps load only the new item page; nothing is re-rendered into a full outfit sheet.']),
    ),
  );

  // ---------- layers & debug
  const rig = index.manifest.rigs[0];
  const layerBoxes = (rig?.layers ?? []).map((layer) => {
    const cb = el('input', { type: 'checkbox', checked: !app.characters.hidden.has(layer), 'data-testid': `layer-${layer}`, onchange: () => app.setLayerHidden(layer, !cb.checked) });
    return el('label', { class: 'chip' }, [cb, ` ${layer}`]);
  });
  const dbg = (key: keyof typeof app.overlayOptions, label: string): HTMLElement => {
    const cb = el('input', { type: 'checkbox', checked: app.overlayOptions[key], onchange: () => { app.overlayOptions[key] = cb.checked; } });
    return el('label', { class: 'chip' }, [cb, ` ${label}`]);
  };
  root.append(
    section('Layers (all characters)', el('div', { class: 'chips' }, layerBoxes)),
    section('Debug overlay', el('div', { class: 'chips' }, [dbg('pivots', 'foot pivots'), dbg('sockets', 'hero sockets'), dbg('layerBoxes', 'hero layer boxes + order'), dbg('ranks', 'painter rank')])),
  );

  // ---------- stats
  const stats = el('pre', { class: 'stats', 'data-testid': 'stats' });
  const issues = el('div', { class: 'issues' });
  root.append(section('Stats (CPU-side; see notes)', stats, issues));

  // ---------- pages
  const pageList = el('div', { class: 'pages' });
  root.append(section('Source pages (per-item atlases)', pageList));
  const thumbs = new Map<string, { canvas: HTMLCanvasElement; state: HTMLElement; drawn: boolean }>();
  for (const page of index.manifest.pages) {
    const scale = Math.min(1, 280 / page.width);
    const canvas = el('canvas', { width: Math.round(page.width * scale), height: Math.round(page.height * scale) });
    const state = el('span', { class: 'state' });
    pageList.append(el('div', { class: 'page' }, [el('div', {}, [el('b', {}, [page.owner]), ` ${page.width}×${page.height} · ${(page.fileBytes / 1024).toFixed(1)} KiB png · `, state]), canvas]));
    thumbs.set(page.id, { canvas, state, drawn: false });
  }

  // ---------- features
  root.append(
    section(
      'Feature flags',
      el('ul', { class: 'features' }, FEATURES.map((f) => el('li', { class: f.enabled ? 'on' : 'off' }, [`${f.enabled ? '●' : '○'} ${f.id} (${f.milestone}) — ${f.note}`]))),
      el('p', { class: 'muted small' }, [`Asset factory: ${extras.assetFactory}`]),
    ),
  );

  const drawPage = (pageId: string, highlight: Set<string>): void => {
    const t = thumbs.get(pageId);
    const tex = app.registry.getPage(pageId);
    if (!t) return;
    t.state.textContent = app.registry.pageState(pageId);
    t.state.className = `state ${app.registry.pageState(pageId).toLowerCase()}`;
    const ctx = t.canvas.getContext('2d');
    if (!ctx || !tex) return;
    const page = index.pages.get(pageId);
    if (!page) return;
    const s = t.canvas.width / page.width;
    ctx.clearRect(0, 0, t.canvas.width, t.canvas.height);
    ctx.fillStyle = '#20242c';
    ctx.fillRect(0, 0, t.canvas.width, t.canvas.height);
    ctx.drawImage(tex.image as CanvasImageSource, 0, 0, t.canvas.width, t.canvas.height);
    for (const [key, r] of Object.entries(index.manifest.images)) {
      if (r.page !== pageId) continue;
      const hot = highlight.has(key);
      ctx.strokeStyle = hot ? '#ff2d55' : 'rgba(120,200,255,0.25)';
      ctx.lineWidth = hot ? 2 : 1;
      ctx.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s);
    }
    t.drawn = true;
  };

  let lastPages = 0;
  return {
    update() {
      const snap = app.snapshot();
      const c = snap.character;
      const reg = snap.registry;
      stats.textContent = [
        `characters ${c.visibleCharacters} visible / ${snap.count} (culled ${c.culledCharacters}), unique looks ${c.uniqueVisibleAppearances}`,
        `layers drawn ${c.visibleLayers}, pending ${c.pendingLayers}, failed ${c.failedLayers}, pose updates ${c.poseUpdates}`,
        `draw calls ${snap.drawCalls} (all objects), triangles ${snap.triangles}, textures ${snap.textures}, programs ${snap.programs}`,
        `CPU update   p50 ${fmt(snap.updateCpu.p50)} p95 ${fmt(snap.updateCpu.p95)} ms`,
        `CPU submit   p50 ${fmt(snap.renderSubmitCpu.p50)} p95 ${fmt(snap.renderSubmitCpu.p95)} ms`,
        `CPU total    p50 ${fmt(snap.totalCpu.p50)} p95 ${fmt(snap.totalCpu.p95)} p99 ${fmt(snap.totalCpu.p99)} ms`,
        `rAF interval p50 ${fmt(snap.frameInterval.p50, 1)} p95 ${fmt(snap.frameInterval.p95, 1)} ms`,
        `GPU timer ${snap.gpuMs === null ? 'n/a' : `${fmt(snap.gpuMs)} ms (${app.env.glRenderer.includes('SwiftShader') ? 'SOFTWARE rasterizer' : 'device'})`}`,
        `pages resident ${reg.resident}/${reg.pages}, loads ${reg.loads}, shared requests ${reg.sharedRequests}, failed ${reg.failed}`,
        `source RGBA8 estimate ${(reg.residentBytesRGBA8 / 1048576).toFixed(2)} MiB (owner-calculated, not measured VRAM)`,
        `sim ${(snap.simTimeMs / 1000).toFixed(2)} s ${app.paused ? '(paused)' : ''}`,
      ].join('\n');
      const hero = app.characters.debugInfo(HERO_ID);
      issues.replaceChildren(...(hero?.appearanceIssues ?? []).map((i) => el('div', { class: i.severity }, [`${i.severity}: ${i.message}`])));
      const highlight = new Set((hero?.pose?.layers ?? []).map((l) => l.image));
      const now = performance.now();
      if (now - lastPages > 450) {
        lastPages = now;
        for (const id of thumbs.keys()) drawPage(id, highlight);
      }
      refreshCountButtons();
      webgpuLine.textContent = webgpuText();
    },
  };
}

export function showFatal(message: string): void {
  const banner = document.getElementById('banner');
  if (banner) {
    banner.textContent = message;
    banner.hidden = false;
  }
}

