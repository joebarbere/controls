import { deriveStream, entityStreamKey } from '@controls/world-model';
import { TICK_S } from '../lib/engine/constants';
import type { LayerContext, SimDeviceBank, SimDeviceModel } from '../lib/engine/device-model';
import type { Netlist } from '../lib/netlist/types';
import type { DcSolution } from '../lib/mna/dc';
import { deviceExtras } from './devices';

/*
 * A bank-level rig for the breakers-v2 specs (P4 PR 10): one device of a model on a synthetic netlist
 * (one AC island, two nodes per branch), its branch currents set by the spec, stepped through its
 * protection layer tick by tick. The datasheet points need exact currents and long runs (117 000
 * ticks at 135 %), which a circuit solve would only approximate and coverage would make slow. Specs
 * only.
 */

export interface BankRig {
  readonly bank: SimDeviceBank;
  readonly ctx: LayerContext & { tick: number };
  readonly events: { tick: number; kind: string; cause: unknown }[];
  /** Sets the current (A, a phasor) of the branch of `part`. */
  amps(part: string, re: number, im?: number): BankRig;
  /** Runs protection steps until a `tripped` event or `limit` steps; returns the steps run (the open state's tick offset). */
  runToTrip(limit: number): number;
  /** One protection step; returns its result. */
  step(): boolean;
}

/**
 * Device `entity` of `model` with `params`, `parts` (its branches, in part order), its commanded
 * `state` and its sim `bag`, under `seed`.
 */
export function bankRig(
  model: SimDeviceModel,
  params: Readonly<Record<string, number>>,
  parts: readonly string[],
  options: {
    readonly state?: Readonly<Record<string, boolean | number | string | null>>;
    readonly bag?: Readonly<Record<string, boolean | number | string | null>>;
    readonly seed?: number;
    readonly entity?: number;
    readonly tick?: number;
  } = {},
): BankRig {
  const seed = options.seed ?? 11;
  const entity = options.entity ?? 2;
  const branches = parts.map((_, b) => ({ index: b, island: 0, a: 2 * b, b: 2 * b + 1 }));
  const netlist = {
    branches,
    islands: [{ kind: 'ac' }],
    nodes: parts.flatMap(() => [{}, {}]),
  } as unknown as Netlist;
  const solution = {
    branches: new Float64Array(2 * parts.length),
    nodes: new Float64Array(4 * parts.length),
  } as unknown as DcSolution;
  const events: { tick: number; kind: string; cause: unknown }[] = [];
  const ctx = {
    tick: options.tick ?? 0,
    dtS: TICK_S.value,
    netlist,
    solution,
    islandReadable: () => true,
    islandStatus: () => 'solved' as const,
    emit: (kind: string, _entity: number, detail: Readonly<Record<string, unknown>> = {}) =>
      events.push({ tick: ctx.tick + 1, kind, cause: detail['cause'] }),
    arcingCount: () => 0,
    arcingBranch: () => -1,
  };
  const bank = model.bank([
    {
      entity,
      params,
      bag: options.bag ?? {},
      state: options.state ?? { on: true },
      branches: branches.map((b) => b.index),
      frequencyHz: 60,
      stream: () => deriveStream(seed, entityStreamKey(entity)),
      ...deviceExtras(seed, entity, parts),
    },
  ]);
  const rig: BankRig = {
    bank,
    ctx: ctx as unknown as LayerContext & { tick: number },
    events,
    amps(part, re, im = 0) {
      const b = parts.indexOf(part);
      solution.branches[2 * b] = re;
      solution.branches[2 * b + 1] = im;
      return rig;
    },
    step() {
      const changed = (bank.protection as (c: LayerContext) => boolean)(ctx as unknown as LayerContext);
      ctx.tick++;
      return changed;
    },
    runToTrip(limit) {
      const seen = events.length;
      for (let k = 1; k <= limit; k++) {
        rig.step();
        if (events.length > seen) return k;
      }
      return -1;
    },
  };
  return rig;
}
