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
  /** `mips=0` uploads linear pages without mip chains (quality/performance comparison). */
  mips: boolean;
  /** FULL_CACHE frame-cache budget in MiB (whole render-target pages incl. mips). */
  cacheMiB: number;
  /** Distinct NPC outfits in the crowd (unset = every NPC random): cache-friendliness of the workload. */
  looks: number | null;
  /** sync=1: NPCs animate in step (formation-like workload). */
  sync: boolean;
  /** AUTO planner GPU-pressure signal: measured from frame timing (auto), or forced on / off (tests, A/B runs). */
  plannerPressure: 'auto' | 'on' | 'off';
  /** lod=1: Milestone 4 projected-size LOD (lower visual animation rate for small characters). Off by default. */
  lod: boolean;
  /** animBudget=N (with lod=1): at most N animation-only pose updates per frame below the HIGH level. */
  animBudget: number | null;
  /**
   * net=1 (stage scene): NPC appearances arrive through the synthetic appearance network (Milestone 4). One player
   * enters interest every `netArrivalMs` and becomes visible `netLeadMs` later (prefetch lead; 0 = no lead);
   * `netLoss` = delta loss rate, `netChangeMs` = mean time between a player's equipment changes (0 = never).
   */
  net: boolean;
  netArrivalMs: number;
  netLeadMs: number;
  netLoss: number;
  netChangeMs: number;
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
    mips: q.get('mips') !== '0',
    cacheMiB: Math.max(8, num('cacheMiB', 64)),
    looks: q.get('looks') === null ? null : Math.max(1, Math.floor(num('looks', 1))),
    sync: q.get('sync') === '1',
    plannerPressure: q.get('plannerPressure') === 'on' ? 'on' : q.get('plannerPressure') === 'off' ? 'off' : 'auto',
    lod: q.get('lod') === '1',
    animBudget: q.get('animBudget') === null ? null : Math.max(0, Math.floor(num('animBudget', 0))),
    net: q.get('net') === '1',
    netArrivalMs: Math.max(0, num('netArrivalMs', 50)),
    netLeadMs: Math.max(0, num('netLeadMs', 1500)),
    netLoss: Math.min(0.5, Math.max(0, num('netLoss', 0.02))),
    netChangeMs: Math.max(0, num('netChangeMs', 4000)),
  };
}
