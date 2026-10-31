import type { DeviceStateValue } from '@controls/save-format';
import type { DeviceOutputSchema, SimEventKind } from '@controls/sim-protocol';
import type { Sfc32 } from '@controls/world-model';
import type { AcBranchValues } from '../mna/ac-values';
import type { DcSolution } from '../mna/dc';
import type { DcBranchValues } from '../mna/values';
import type { Netlist, NetlistBranch, StateBag } from '../netlist/types';

/*
 * The device-model interface of the engine loop (plan F2.3a): how a model kind's sim-owned state and
 * behaviour plug into `SimEngine`. F2.4 (battery, supplies) and F2.5 (lamp, fuse, breaker, resistor,
 * heater) implement it; F2.3a ships none for the built-in kinds and tests the hooks with synthetic
 * models (`src/testing/engine.ts`).
 *
 * **State lives in banks, persisted through bags.** A model keeps its devices' sim-owned state in a
 * bank: struct-of-arrays, preallocated when the bank is built, so a tick allocates nothing. The engine
 * builds a new bank at every topology change (branch indices move then) from each device's bag, and
 * reads bags back for saves, `world.hash` and the next bank. So **a bag must hold every value that
 * affects the future**, exactly (finite numbers survive JSON bit for bit): a value kept only in a bank
 * would be lost at the next topology change and on a save, and the save-and-load parity property
 * catches it. Hidden per-device constants that are a pure function of the device are fine (a tolerance
 * drawn from its seeded stream, a parameter). **A model that keeps drawing from its seeded stream
 * (wear, a random trip within a band) must persist how far it has drawn in its bag**: `stream()`
 * restarts the stream on every bank build, so the n-th draw after a load would otherwise repeat the
 * first. Draw only at bank build (a fixed tolerance), or store the count and skip ahead on build.
 *
 * **Inputs.** A model reads the catalogue parameters, its bag, the electrical solution and the
 * netlist (its branches' values carry commanded inputs such as a setpoint). Never the world's own
 * `sim` bags (inert, ADR 0011 §1), the wall clock or ambient randomness: per-device randomness comes
 * only from `stream()`, `deriveStream(world.seed, entityStreamKey(id))`.
 */

/** One netlisted device of a model kind, as a bank is built for it. */
export interface SimDevice {
  readonly entity: number;
  /** The catalogue entry's `model.params`. */
  readonly params: Readonly<Record<string, number>>;
  /** Where its state starts: its whole sim bag (every sim key of its kind). */
  readonly bag: StateBag;
  /** Its branches in this topology, in part order (an element per branch). */
  readonly branches: readonly number[];
  /** Its seeded stream, fresh on every call: `deriveStream(world.seed, entityStreamKey(entity))`. */
  stream(): Sfc32;
}

/**
 * Why an island's values are or aren't a reading:
 *
 * - `solved`: a reading;
 * - `singular`: a loop of ideal sources (ADR 0011 §5.3): its zeros are not 0 V;
 * - `nonConverged`: the outer loop hit its cap: values that look real but aren't settled;
 * - `unmodelled`: an element no device model can value yet (the lamp until F2.5): not solved;
 * - `mixed`: DC and AC sources in one island (P2 has no converters): not solved.
 */
export type SimIslandStatus = 'solved' | 'singular' | 'nonConverged' | 'unmodelled' | 'mixed';

/** What a layer sees for one step, `[tick, tick + 1)`. The same object every step: never keep it. */
export interface LayerContext {
  /** The tick the step starts at. Events it emits are stamped `tick + 1`, the state they describe. */
  readonly tick: number;
  /** The step's length in seconds (`TICK_S`). */
  readonly dtS: number;
  readonly netlist: Netlist;
  /** The last electrical solution (at `lastSolveTick`, at most `tick`). */
  readonly solution: DcSolution;
  /**
   * Whether island `island`'s values are a reading: it was solved, and isn't singular or
   * non-converged. An unsolved island's values are zeros, never a current to integrate.
   */
  islandReadable(island: number): boolean;
  /** Island `island`'s status in the last solution (what `islandReadable` tests for `solved`). */
  islandStatus(island: number): SimIslandStatus;
  /** Reports a device event (`blown`, `tripped`, `hiccup`, `overRated`) at `tick + 1`. */
  emit(kind: SimEventKind, entity: number, detail?: Readonly<Record<string, number | string | boolean>>): void;
}

/**
 * One model kind's devices, for one topology. Every hook is optional; a bank with none only carries
 * its bags. `index` is the device's position in the `devices` the bank was built from.
 */
export interface SimDeviceBank {
  /** Device `index`'s sim bag now: every sim key of its kind, finite numbers (allocates; never per tick). */
  bag(index: number): Record<string, DeviceStateValue>;
  /**
   * Sets the DC value of `branch` (one of device `index`'s) in `values` before a solve, and returns
   * `true`; or returns `false` for the kind's default (`DC_DEFAULT_VALUES`). A branch with neither
   * leaves its island unmodelled: not solved, never a reading.
   */
  dcValue?(index: number, branch: NetlistBranch, values: DcBranchValues): boolean;
  /**
   * Sets the phasor value of `branch` (one of device `index`'s, on an `ac` island) in `values` at the
   * region frequency, and returns `true`; or returns `false` for the kind's default
   * (`AC_DEFAULT_VALUES`). A branch with neither leaves its island unmodelled. AC islands are linear in
   * P2 (no outer loop): each solve stamps these values once.
   */
  acValue?(index: number, branch: NetlistBranch, values: AcBranchValues): boolean;
  /**
   * The nonlinear outer loop's hook for `branch` (`DcIterationHook`, F2.2 part 3): set its value from
   * `iterate` (null on a cold start). Pure in its inputs.
   */
  iterate?(index: number, branch: NetlistBranch, iterate: DcSolution | null, values: DcBranchValues): void;
  /**
   * Called after every electrical solve (cadence, command, layer or start), with `ctx.solution` the
   * new solution at `ctx.tick` and `values` exactly the DC values it was solved with (the outer loop's
   * last stamps). It commits sim state the solve decided, such as a supply's CV/CC mode, into the
   * bank, so the bag (and so a save and the snapshot) agrees with the solution it describes. Pure in
   * its inputs; it must not emit events (F2.4).
   */
  afterSolve?(ctx: LayerContext, values: DcBranchValues): void;
  /**
   * The discrete layer (relays, P6). Returns whether it changed what the electrical layer sees: the
   * topology, or a value a model's `dcValue` reads from its bank. Either way the engine re-solves at
   * `tick + 1`, within the step; it recompiles first only for a kind that lists `simTopologyKeys` (the
   * compile reads a bag through those keys alone, so no other kind's change can move the netlist).
   */
  discrete?(ctx: LayerContext): boolean;
  /** The continuous layer (filament temperature, state of charge): integrates over the step. */
  continuous?(ctx: LayerContext): void;
  /**
   * The protection layer (fuse I²t, breaker, PSU hiccup). Returns whether it changed what the
   * electrical layer sees (a blown fuse's topology, a PSU switching its output off): the engine then
   * re-solves at `tick + 1`, within the step, so the change is tick-exact (recompiling first only for a
   * kind with `simTopologyKeys`, as `discrete`).
   */
  protection?(ctx: LayerContext): boolean;
  /**
   * Writes device `index`'s output record (its kind's `output` schema) at `offset`; the bytes arrive
   * zeroed. `ctx` is the current tick's (its `emit` must not be called here). **Everything written must
   * follow from the bag and the solution** (a power from the bag's temperature and the solved current,
   * never one cached by the last step): a snapshot is a pure function of the exported state, so a
   * loaded engine writes the same bytes (ADR 0011 §5.5).
   */
  writeRecord?(index: number, view: DataView, offset: number, ctx: LayerContext): void;
}

/** A device model kind's engine model. */
export interface SimDeviceModel {
  /** The catalogue model kind. */
  readonly kind: string;
  /** Its output record schema in the snapshot, or `null` if it publishes none. */
  readonly output: DeviceOutputSchema | null;
  /** Builds a bank for `devices` (at least one, ascending by entity), preallocating its storage. */
  bank(devices: readonly SimDevice[]): SimDeviceBank;
}

export { BUILTIN_DEVICE_MODELS } from '../devices';
