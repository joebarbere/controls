import type { CommandBus } from '@controls/commands';
import type { World } from '@controls/save-format';
import { decodeSnapshot, materialiseWorld, type SimEvent } from '@controls/sim-protocol';
import { SimEngine, type SimEngineOptions } from '../lib/engine/engine';
import { end } from './bench';
import { engineBus, engineTestOptions } from './engine';

/*
 * Helpers for F2.4's source specs: the refs of the built-in sources (the battery is `BATTERY` in
 * `bench.ts`), a headless host (a world bus and the engine following it, as the scripting API runs
 * them) and a decoder for a device's output record. Specs only.
 */

export const BENCH_SUPPLY = { id: 'supply.brindlecore-bench-30v-5a', version: 1 };
export const DIN_PSU = { id: 'supply.railwick-din-24v-5a', version: 1 };

/** A world bus and an engine that follows it, on the engine test catalogue and models. */
export class SourceHost {
  readonly engine: SimEngine;
  readonly events: SimEvent[] = [];
  constructor(
    readonly bus: CommandBus<World> = engineBus(),
    readonly options: Required<SimEngineOptions> = engineTestOptions(),
  ) {
    this.engine = SimEngine.start(bus.state, options);
  }

  exec(id: string, args: object = {}): this {
    const result = this.bus.exec(id, args);
    if (!result.ok) throw new Error(`${id} ${JSON.stringify(args)} failed: ${JSON.stringify(result.error)}`);
    if (result.logged) this.engine.applied(result.entry, this.bus.state);
    this.events.push(...this.engine.takeEvents());
    return this;
  }

  run(commands: readonly (readonly [string, object])[]): this {
    for (const [id, args] of commands) this.exec(id, args);
    return this;
  }

  place(ref: { id: string; version: number }): number {
    this.exec('entity.place', { ref, positionMm: { x: 0, y: 0, z: 0 } });
    return this.bus.state.nextEntityId - 1;
  }

  lead(a: number, ta: string, b: number, tb: string): this {
    return this.exec('lead.connect', { ref: LEAD_REF, a: end(a, ta), b: end(b, tb) });
  }

  operate(id: number, control: string, value: boolean | number | string): this {
    return this.exec('device.operate', { id, control, value });
  }

  advanceTo(tick: number): this {
    this.engine.advanceTo(tick);
    this.bus.advanceTo(tick);
    this.events.push(...this.engine.takeEvents());
    return this;
  }

  advance(ticks: number): this {
    return this.advanceTo(this.engine.tick + ticks);
  }

  /** The world as a save writes it. */
  materialised(): World {
    return materialiseWorld(this.bus.state, this.engine.exportState());
  }

  /** Entity `id`'s sim bag now. */
  sim(id: number): Readonly<Record<string, unknown>> {
    return (
      this.engine.exportState().entities.find((e) => e.id === id)?.state ??
      (() => {
        throw new Error(`entity ${id} is not netlisted`);
      })()
    );
  }

  /** V(a) − V(b) of a DC probe, or throws when it isn't a reading. */
  volts(a: number, ta: string, b: number, tb: string): number {
    const reading = this.engine.probe(end(a, ta), end(b, tb));
    if (reading.kind !== 'dc') throw new Error(`expected a DC reading, got ${reading.kind}`);
    return reading.volts;
  }

  /** Entity `id`'s branch current (its first element's), a → b, from the solution record. */
  amps(id: number): number {
    const branch = this.engine.netlist.branches.find((b) => b.element.kind === 'entity' && b.element.entity === id);
    if (branch === undefined) throw new Error(`entity ${id} has no branch`);
    return this.engine.exportState().solution?.branches[2 * branch.index] as number;
  }

  /** Entity `id`'s output record in the snapshot, decoded by its kind's schema (enums by name). */
  record(id: number): Record<string, number | string> {
    const snapshot = decodeSnapshot(this.engine.snapshot());
    const view = new DataView(snapshot.devices.buffer, snapshot.devices.byteOffset, snapshot.devices.byteLength);
    let offset = 0;
    for (const device of this.engine.netlist.devices) {
      const output = this.options.deviceModels[device.kind]?.output ?? null;
      if (output === null) continue;
      if (device.entity === id) {
        const out: Record<string, number | string> = {};
        for (const field of output.fields) {
          const at = offset + field.offset;
          if (field.type === 'f64') out[field.name] = view.getFloat64(at, true);
          else if (field.type === 'u8') {
            const code = view.getUint8(at);
            out[field.name] = field.values === null ? code : field.values[code];
          } else out[field.name] = view.getUint32(at, true);
        }
        return out;
      }
      offset += output.recordBytes;
    }
    throw new Error(`entity ${id} publishes no record`);
  }
}

const LEAD_REF = { id: 'lead.quillfern-test-1m', version: 1 };
