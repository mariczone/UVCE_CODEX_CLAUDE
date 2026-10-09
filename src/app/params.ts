import { type Direction8, isDirection8 } from '../uvce/core/directions.ts';
import { type ParityVariantId, isParityVariant } from './parity-scenes.ts';

/** stage = lit 3D scene; parity = pixel-exact test scene; studio = pixel camera, flat background, hero only. */
export type SceneKind = 'stage' | 'parity' | 'studio';

/** Query parameters. `test=1` = deterministic: paused clock, no auto motion, no MSAA, preserved buffer. */
export interface AppParams {
  test: boolean;
  scene: SceneKind;
  /** Parity scene variant (scene=parity). */
  variant: ParityVariantId;
  count: number;
  seed: number;
  timeMs: number;
  paused: boolean;
  heroDirection: Direction8 | null;
  heroClip: string | null;
  filter: 'linear' | 'nearest' | null;
  mode: string | null;
  hide: string[];
  debug: boolean;
  overlay: boolean;
  slots: Record<string, string | null>;
  bench: boolean;
  /** Source page GPU budget in MiB (registry eviction threshold). */
  budgetMiB: number;
}

export function parseParams(search: string): AppParams {
  const q = new URLSearchParams(search);
  const num = (k: string, d: number): number => {
    const v = q.get(k);
    const n = v === null ? Number.NaN : Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const test = q.get('test') === '1';
  const sceneParam = q.get('scene');
  const scene: SceneKind = sceneParam === 'parity' || sceneParam === 'studio' ? sceneParam : 'stage';
  const dir = q.get('dir');
  const filter = q.get('filter');
  const slots: Record<string, string | null> = {};
  for (const slot of ['hair', 'hat', 'armor', 'weapon']) {
    const v = q.get(slot);
    if (v !== null) slots[slot] = v === 'none' ? null : v;
  }
  return {
    test,
    scene,
    variant: isParityVariant(q.get('variant')) ? (q.get('variant') as ParityVariantId) : 'default',
    count: Math.max(scene === 'parity' ? 2 : 1, Math.min(1000, Math.floor(num('count', scene === 'parity' ? 2 : 1)))),
    seed: Math.floor(num('seed', 20261009)) >>> 0,
    timeMs: num('t', 0),
    paused: test || q.get('paused') === '1',
    heroDirection: dir && isDirection8(dir) ? dir : null,
    heroClip: q.get('clip'),
    filter: filter === 'nearest' || filter === 'linear' ? filter : null,
    mode: q.get('mode'),
    hide: (q.get('hide') ?? '').split(',').filter(Boolean),
    debug: q.get('debug') === '1',
    overlay: q.get('overlay') !== '0',
    slots,
    bench: q.get('bench') === '1',
    budgetMiB: Math.max(1, num('budgetMiB', 256)),
  };
}
