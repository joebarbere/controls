import { BUILTIN_CATALOG, type LeadParams } from '@controls/catalog';
import type { World } from '@controls/save-format';
import {
  CONNECTION_READING_CONDUCTOR_DROP,
  CONNECTION_READING_CURRENT,
  CONNECTION_READING_END_A_DROP,
  CONNECTION_READING_END_A_VOLTS,
  CONNECTION_READING_END_B_DROP,
  CONNECTION_READING_END_B_VOLTS,
} from '@controls/sim-protocol';
import { SimEngine, type SimConnectionRecord, type SimEngineOptions } from './engine';

/*
 * `wire.info <id>` (F3.6 part 3, plan D16): a read-only console query, like `netlist.dump`. It prints
 * one connection's protocol 7 record (ADR 0015 "Protocol 7 connection records") with its length: the
 * conductor's resistance at its temperature, the current, the conductor and end drops, the
 * temperatures, the end states and the insulation flag. A debug aid until P5's instruments.
 *
 * Like `netlist.dump` it is a pure function of the **materialised** world: an engine started from it
 * writes the same record as the engine that exported it (records are a function of the export), so
 * headless and the game (the sim worker's export, materialised on the main thread) print the same
 * bytes in Node and in Chromium. Numbers are `toPrecision(6)` (ECMA-262 defines its digits exactly),
 * with trailing zeros dropped, and SI units. The text reads the decoded record only, never the
 * connection's `sim` bag (ADR 0011's F3.6 part 1 amendment). A field that is no reading says so: an
 * electrical field whose `readings` bit is clear prints `no reading`, never 0. An `open` connection
 * (not netlisted) has 0 A; a gap prints the voltage across it (`gap … V`, or `gap no reading`): an
 * `intermittentOpen` end prints `open` instead of its closed contact's resistance, and a fused lead
 * `conductor open (fused)`. An end whose state is `none` prints nothing more.
 *
 * ```text  (the bad-termination scenario's loose conductor at 600 s)
 * wire.info 2 tick 600000
 * conductor 2 conductor.tallowmere-thhn-14-solid@1 length 1979 mm
 * status solved
 * current 11.8059 A
 * conductor R 0.0170339 Ω at 303.033 K, drop 0.2011 V
 * end a ok, contact 0.0254515 Ω at 393.822 K, drop 0.300478 V, conductor side 119.28 V
 * end b ok, contact 0.000516818 Ω at 301.709 K, drop 0.00610151 V, conductor side 119.078 V
 * insulation intact
 * ```
 *
 * `conductor side` is the end's voltage against the island reference on the conductor's side of the
 * contact (`endAVolts`); on DC the conductor's drop is the difference of the two (on AC these are
 * RMS magnitudes of phasors, so only nearly).
 */

/** A number for `wire.info`: six significant figures (ECMA-262's exact digits), trailing zeros dropped. */
export function formatWireNumber(value: number): string {
  if (value === 0) return '0';
  return String(Number(value.toPrecision(6)));
}

const quantity = (value: number, unit: string) => `${formatWireNumber(value)} ${unit}`;

/** A connection's length in mm: a wire's `lengthMm`, a lead's catalogue length, or `null`. */
function lengthOf(world: World, id: number, options: SimEngineOptions): number | null {
  const connection = world.connections.find((c) => c.id === id);
  if (connection === undefined) return null;
  if (connection.lengthMm !== null) return connection.lengthMm;
  const device = (options.catalog ?? BUILTIN_CATALOG).device(connection.ref);
  const params = device?.model.params as Partial<LeadParams> | undefined;
  return typeof params?.lengthMm === 'number' ? params.lengthMm : null;
}

/** The `wire.info` text of connection `id` in `engine` (on `world`, the commanded world it follows), ending with a newline. */
export function formatWireInfo(engine: SimEngine, world: World, id: number): string {
  const head = `wire.info ${id} tick ${engine.tick}`;
  const connection = world.connections.find((c) => c.id === id);
  if (connection === undefined) return `${head}\nno connection ${id}\n`;
  const record = engine.connectionRecord(id);
  const ref = `${connection.ref.id}@${connection.ref.version}`;
  if (record === null) return `${head}\nconnection ${id} ${ref}: not a modelled conductor or lead\n`;
  const length = lengthOf(world, id, engine.options);
  return `${[head, `${record.kind} ${id} ${ref} length ${length === null ? 'unknown' : `${length} mm`}`, ...recordLines(record)].join('\n')}\n`;
}

/** The record's lines (see the file comment). */
function recordLines(record: SimConnectionRecord): string[] {
  const v = record.values;
  const n = (field: string) => v[field] as number;
  const status = v['status'] as string;
  const readings = n('readings');
  // A field is a reading only with its `readings` bit (ADR 0011 amendment §3): never print 0 otherwise.
  const value = (field: string, bit: number, unit: string) =>
    (readings & bit) !== 0 ? quantity(n(field), unit) : 'no reading';
  const temp = (field: string) => quantity(n(field), 'K');
  const lines = [
    `status ${status}${status === 'open' ? ' (not netlisted)' : ''}`,
    `current ${value('currentA', CONNECTION_READING_CURRENT, 'A')}`,
    v['conductorState'] === 'open'
      ? `conductor open (fused) at ${temp('conductorTempK')}, gap ${value('conductorDropV', CONNECTION_READING_CONDUCTOR_DROP, 'V')}`
      : `conductor R ${quantity(n('conductorResistanceOhm'), 'Ω')} at ${temp('conductorTempK')}, drop ${value('conductorDropV', CONNECTION_READING_CONDUCTOR_DROP, 'V')}`,
  ];
  for (const side of ['A', 'B'] as const) {
    const state = v[`end${side}State`] as string;
    const name = `end ${side.toLowerCase()}`;
    if (state === 'none') {
      lines.push(`${name} none`);
      continue;
    }
    const dropBit = side === 'A' ? CONNECTION_READING_END_A_DROP : CONNECTION_READING_END_B_DROP;
    const voltsBit = side === 'A' ? CONNECTION_READING_END_A_VOLTS : CONNECTION_READING_END_B_VOLTS;
    const drop = value(`end${side}DropV`, dropBit, 'V');
    const volts = `, conductor side ${value(`end${side}Volts`, voltsBit, 'V')}`;
    // An open end is a gap: its closed-contact resistance is not what it is now.
    lines.push(
      state === 'intermittentOpen'
        ? `${name} intermittentOpen, open at ${temp(`end${side}TempK`)}, gap ${drop}${volts}`
        : `${name} ${state}, contact ${quantity(n(`end${side}ContactOhm`), 'Ω')} at ${temp(`end${side}TempK`)}, drop ${drop}${volts}`,
    );
  }
  lines.push(`insulation ${v['insulationDamaged'] === 'yes' ? 'damaged' : 'intact'}`);
  return lines;
}

/**
 * `wire.info <id>` of a materialised world (see the file comment). A world with `sim: null` and a
 * circuit is solved at its tick first, as the engine starting on it would. Throws `SimStartError` for
 * a world whose solution record doesn't fit its netlist.
 */
export function wireInfo(world: World, id: number, options: SimEngineOptions = {}): string {
  return formatWireInfo(SimEngine.start(world, options), world, id);
}
