import { formatTemperature, type WireRef } from '@controls/renderer';
import {
  CONNECTION_AMBIENT_K,
  CONNECTION_CONDUCTOR_STATES,
  CONNECTION_OVERHEAT_RISE_K,
  CONNECTION_OXIDATION_ONSET_K,
  CONNECTION_READING_CONDUCTOR_DROP,
  CONNECTION_READING_CURRENT,
  CONNECTION_READING_END_A_DROP,
  CONNECTION_READING_END_B_DROP,
  CONNECTION_RECORD_END_STATES,
  CONNECTION_RECORD_STATUS_VALUES,
  CONNECTION_VALUE_COUNT,
  CONNECTION_VALUE_INDEX,
  NetlistReadout,
  type NetlistReading,
  type SnapshotView,
} from '@controls/sim-protocol';
import { formatQuantity, NO_READING } from '../netlist/netlist-model';

/*
 * The wire hover readout's model (F3.6 part 3, plan D16), framework-free so it is unit-tested without
 * Angular. In work mode the wire under the pointer, else the selected wire, shows its protocol 7
 * connection record (`NetlistReadout`, the overlays' and the inspector's reader): the current, the
 * conductor's and each end's drop, the conductor's and **each end's** temperature (never only a half's
 * hottest point, which is all the heat overlay's colour says), and a state in words.
 *
 * The validity rules are the inspector's (`connectionDetail`) and `wire.info`'s: an electrical field
 * whose `readings` bit is clear is "no reading", never 0; a gap (an `intermittentOpen` end, a fused
 * conductor) shows `gap` and the voltage across it, or "gap, no reading", never 0 V; an end whose state
 * is `none` (a lead's clip, an unlanded end) has no termination node and shows no temperature, never
 * 0 K; no snapshot, or no record for the connection, is no reading at all. A cable jacket has no
 * record: it says so.
 *
 * **Allocation.** {@link WireReadoutSampler.update} runs on every snapshot. It reads the snapshot
 * (allocation-free, into a reading allocated once per topology generation) only while a wire is the
 * target, and compares the target's values **at display resolution** (three significant figures,
 * whole kelvin and whole degrees Celsius, the state codes) with what is shown, into preallocated
 * arrays. Only when they differ does the caller re-format (strings), so a steady wire costs no
 * allocation per snapshot.
 */

/** What a connection is, from the world: a test lead, a routed wire, or a cable's conductor. */
export interface ReadoutConnection {
  readonly id: number;
  readonly route: unknown;
  readonly cable: { readonly id: number } | null;
  readonly label: string | null;
}

/** The world's parts the readout names things by. */
export interface ReadoutWorld {
  readonly connections: readonly ReadoutConnection[];
}

/** One row of the readout's table: the conductor or one end. */
export interface WireReadoutPart {
  readonly key: 'conductor' | 'end-a' | 'end-b';
  readonly name: 'Conductor' | 'End a' | 'End b';
  /** `false` for an end with no termination node (a lead's clip, an unlanded end): no drop or temperature. */
  readonly terminated: boolean;
  /** `201 mV`, `gap 120 V`, `gap, no reading` or {@link NO_READING}; `''` when not terminated. */
  readonly drop: string;
  /** `394 K (121 °C)` or {@link NO_READING}; `''` when not terminated. */
  readonly temperature: string;
}

/** What the readout shows (strings only: the panel is presentational). */
export interface WireReadoutView {
  /** `Wire 2`, `Wire 5 "L1"`, `Wire 7 (cable 1)`, `Test lead 3`, `Cable 1`. */
  readonly title: string;
  /** Whether it follows the pointer (`hover`) or the selection. */
  readonly source: 'hover' | 'selection';
  /** `11.8 A` or {@link NO_READING}; `''` for a cable jacket. */
  readonly current: string;
  /** Conductor, end a, end b; empty for a cable jacket. */
  readonly parts: readonly WireReadoutPart[];
  /** `normal`, `overheating at end a`, `fused, insulation damaged`, …, or why there is no reading. */
  readonly state: string;
}

/** A termination's hot spot at or above this is overheating: the engine's `terminationOverheat` threshold. */
export const READOUT_OVERHEAT_K = CONNECTION_AMBIENT_K + CONNECTION_OVERHEAT_RISE_K;

const V = CONNECTION_VALUE_INDEX;
const I_READINGS = V['readings'];
const I_CURRENT = V['currentA'];
const I_COND_DROP = V['conductorDropV'];
const I_COND_T = V['conductorTempK'];
const I_COND_STATE = V['conductorState'];
const I_INSULATION = V['insulationDamaged'];
const END = [
  { state: V['endAState'], drop: V['endADropV'], temp: V['endATempK'], bit: CONNECTION_READING_END_A_DROP },
  { state: V['endBState'], drop: V['endBDropV'], temp: V['endBTempK'], bit: CONNECTION_READING_END_B_DROP },
] as const;
const END_NONE = CONNECTION_RECORD_END_STATES.indexOf('none');
const END_INTERMITTENT_CLOSED = CONNECTION_RECORD_END_STATES.indexOf('intermittentClosed');
const END_INTERMITTENT_OPEN = CONNECTION_RECORD_END_STATES.indexOf('intermittentOpen');
const END_ARCING = CONNECTION_RECORD_END_STATES.indexOf('arcing');
const CONDUCTOR_CLOSED = CONNECTION_CONDUCTOR_STATES.indexOf('closed');
const STATUS_OPEN = CONNECTION_RECORD_STATUS_VALUES.indexOf('open');
const STATUS_SOLVED = CONNECTION_RECORD_STATUS_VALUES.indexOf('solved');

/** Key slot 0: what the target is, so a change of kind is a change. */
const KEY_CABLE = -2;
const KEY_NO_RECORD = -1;
const KEY_RECORD = 1;
/** Kind, status, readings, two end states, conductor state, insulation, current and three drops (3 s.f.), three temperatures in K and °C. */
const KEY_LENGTH = 17;
/** The conductor's and the two ends' temperature fields. */
const TEMPS = [I_COND_T, END[0].temp, END[1].temp] as const;

/** `value` rounded to three significant figures (the display resolution of `formatQuantity`). */
function sigFig3(value: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const scale = 10 ** (2 - Math.floor(Math.log10(Math.abs(value))));
  return Math.round(value * scale) / scale;
}

const sameRef = (a: WireRef | null, b: WireRef | null): boolean =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id);

/** Whether two readouts show the same text (the panel's signal equality). */
export function sameWireReadout(a: WireReadoutView | null, b: WireReadoutView | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.title !== b.title || a.source !== b.source || a.current !== b.current || a.state !== b.state) return false;
  if (a.parts.length !== b.parts.length) return false;
  for (let i = 0; i < a.parts.length; i++) {
    const p = a.parts[i];
    const q = b.parts[i];
    if (p.terminated !== q.terminated || p.drop !== q.drop || p.temperature !== q.temperature) return false;
  }
  return true;
}

/** `Wire 2`, `Wire 5 "L1"`, `Wire 7 (cable 1)`, `Test lead 3`, `Cable 1`, from the world. */
export function wireTitle(target: WireRef, world: ReadoutWorld | null): string {
  if (target.kind === 'cable') return `Cable ${target.id}`;
  const c = world?.connections.find((x) => x.id === target.id);
  if (c === undefined) return `Wire ${target.id}`;
  const label = c.label === null ? '' : ` "${c.label}"`;
  if (c.cable !== null) return `Wire ${c.id}${label} (cable ${c.cable.id})`;
  return `${c.route === null ? 'Test lead' : 'Wire'} ${c.id}${label}`;
}

/**
 * Samples one wire's connection record from the sim's snapshots (see the file comment). The caller
 * passes each snapshot to {@link update} with the current target, and re-formats with {@link format}
 * when it returns `true` or the target changes.
 */
export class WireReadoutSampler {
  private view: SnapshotView | null = null;
  private serial = 0;
  private readSerial = -1;
  private reading: NetlistReading | null = null;
  private record = -1;
  private readonly key = new Float64Array(KEY_LENGTH);
  private readonly shown = new Float64Array(KEY_LENGTH);
  private shownTarget: WireRef | null = null;

  /**
   * A new snapshot (`null`: a source reset, nothing is a reading). Returns whether `target`'s readout
   * changed at display resolution since it was last shown. Allocation-free.
   */
  update(view: SnapshotView | null, target: WireRef | null): boolean {
    this.view = view;
    this.serial++;
    if (target === null) return false;
    this.fillKey(target);
    if (sameRef(target, this.shownTarget) && this.keyShown()) return false;
    this.markShown(target);
    return true;
  }

  /** The readout of `target` from the latest snapshot, named from `world`; what {@link update} compares against next. */
  format(target: WireRef, world: ReadoutWorld | null, source: 'hover' | 'selection'): WireReadoutView {
    const view = this.build(target, world, source);
    this.markShown(target);
    return view;
  }

  /** One sentence for a live region: the title, current, temperatures, drops and state. Doesn't touch what is shown. */
  summary(target: WireRef, world: ReadoutWorld | null): string {
    const r = this.build(target, world, 'selection');
    if (r.parts.length === 0) return `${r.title} selected: ${r.state}.`;
    const parts = r.parts.map((p) =>
      p.terminated ? `${p.name} ${p.temperature}, drop ${p.drop}` : `${p.name} no termination`,
    );
    return `${r.title} selected. Current ${r.current}. ${parts.join('. ')}. State: ${r.state}.`;
  }

  /** The readout of `target` (fills `key` and `record`). */
  private build(target: WireRef, world: ReadoutWorld | null, source: 'hover' | 'selection'): WireReadoutView {
    this.fillKey(target);
    const title = wireTitle(target, world);
    if (target.kind === 'cable') {
      return {
        title,
        source,
        current: '',
        parts: [],
        state: 'no reading: a cable jacket (its conductors have readings)',
      };
    }
    const reading = this.reading;
    if (this.view === null || reading === null || this.record < 0) {
      const none: WireReadoutPart[] = [
        { key: 'conductor', name: 'Conductor', terminated: true, drop: NO_READING, temperature: NO_READING },
        { key: 'end-a', name: 'End a', terminated: true, drop: NO_READING, temperature: NO_READING },
        { key: 'end-b', name: 'End b', terminated: true, drop: NO_READING, temperature: NO_READING },
      ];
      const why = this.view === null ? 'no reading: the simulation has no snapshot' : 'no reading: not simulated';
      return { title, source, current: NO_READING, parts: none, state: why };
    }
    return { title, source, ...recordView(reading, this.record) };
  }

  /** Reads the latest snapshot once per snapshot (allocation-free after a generation's first read). */
  private ensureRead(): void {
    const view = this.view;
    if (view === null || this.readSerial === this.serial) return;
    const readout = NetlistReadout.of(view.descriptor);
    if (this.reading?.descriptor !== view.descriptor) this.reading = readout.createReading();
    readout.read(view, this.reading);
    this.readSerial = this.serial;
  }

  /** `target`'s display key into `key` (and its record index into `record`). */
  private fillKey(target: WireRef): void {
    const k = this.key;
    k.fill(0);
    this.record = -1;
    if (target.kind === 'cable') {
      k[0] = KEY_CABLE;
      return;
    }
    this.ensureRead();
    const reading = this.reading;
    if (this.view === null || reading === null) {
      k[0] = KEY_NO_RECORD;
      return;
    }
    const c = NetlistReadout.of(reading.descriptor).recordOfConnection(target.id);
    if (c < 0) {
      k[0] = KEY_NO_RECORD;
      return;
    }
    this.record = c;
    const v = reading.connectionValues;
    const at = c * CONNECTION_VALUE_COUNT;
    k[0] = KEY_RECORD;
    k[1] = reading.connectionStatus[c];
    k[2] = v[at + I_READINGS];
    k[3] = v[at + END[0].state];
    k[4] = v[at + END[1].state];
    k[5] = v[at + I_COND_STATE];
    k[6] = v[at + I_INSULATION];
    k[7] = sigFig3(v[at + I_CURRENT]);
    k[8] = sigFig3(v[at + I_COND_DROP]);
    k[9] = sigFig3(v[at + END[0].drop]);
    k[10] = sigFig3(v[at + END[1].drop]);
    for (let i = 0; i < 3; i++) {
      const t = v[at + TEMPS[i]];
      k[11 + 2 * i] = Math.round(t);
      k[12 + 2 * i] = Math.round(t - 273.15);
    }
  }

  private keyShown(): boolean {
    for (let i = 0; i < KEY_LENGTH; i++) if (this.key[i] !== this.shown[i]) return false;
    return true;
  }

  private markShown(target: WireRef): void {
    this.shown.set(this.key);
    if (!sameRef(target, this.shownTarget)) this.shownTarget = { kind: target.kind, id: target.id };
  }
}

/** The current, the three rows and the state of record `c` in `reading`. */
function recordView(reading: NetlistReading, c: number): Pick<WireReadoutView, 'current' | 'parts' | 'state'> {
  const at = c * CONNECTION_VALUE_COUNT;
  const v = (i: number) => reading.connectionValues[at + i];
  const status = reading.connectionStatus[c];
  const readings = v(I_READINGS);
  const volts = (i: number, bit: number) => ((readings & bit) !== 0 ? formatQuantity(v(i), 'V') : NO_READING);
  const gap = (i: number, bit: number) =>
    (readings & bit) !== 0 ? `gap ${formatQuantity(v(i), 'V')}` : 'gap, no reading';
  // Anything but `closed` is a conductor open in its body (a fused lead; a melted conductor if the
  // protocol adds one): a gap, never 0 V.
  const fused = v(I_COND_STATE) !== CONDUCTOR_CLOSED;
  const parts: WireReadoutPart[] = [
    {
      key: 'conductor',
      name: 'Conductor',
      terminated: true,
      drop: fused
        ? gap(I_COND_DROP, CONNECTION_READING_CONDUCTOR_DROP)
        : volts(I_COND_DROP, CONNECTION_READING_CONDUCTOR_DROP),
      temperature: formatTemperature(v(I_COND_T)),
    },
  ];
  const ends: { name: 'a' | 'b'; state: number; tempK: number }[] = [];
  END.forEach((end, side) => {
    const key = side === 0 ? 'end-a' : 'end-b';
    const name = side === 0 ? 'End a' : 'End b';
    const state = v(end.state);
    if (state === END_NONE || CONNECTION_RECORD_END_STATES[state] === undefined) {
      parts.push({ key, name, terminated: false, drop: '', temperature: '' });
      return;
    }
    ends.push({ name: side === 0 ? 'a' : 'b', state, tempK: v(end.temp) });
    parts.push({
      key,
      name,
      terminated: true,
      drop: state === END_INTERMITTENT_OPEN ? gap(end.drop, end.bit) : volts(end.drop, end.bit),
      temperature: formatTemperature(v(end.temp)),
    });
  });
  const current = (readings & CONNECTION_READING_CURRENT) !== 0 ? formatQuantity(v(I_CURRENT), 'A') : NO_READING;
  return { current, parts, state: stateText(status, fused, ends, v(I_INSULATION) === 1) };
}

/** `ends a and b`, `end a`. */
const endsText = (names: readonly string[]) =>
  names.length === 1 ? `end ${names[0]}` : `ends ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * The connection's state in words, worst first: fused; intermittent (open now, or closed now);
 * arcing; open (not in a circuit); degrading (a hot spot above the oxidation onset, where contact
 * resistance grows); overheating (at or above the engine's `terminationOverheat` point); else normal
 * (or, unsolved, not solved). `insulation damaged` is added to any of them.
 */
function stateText(
  status: number,
  fused: boolean,
  ends: readonly { name: 'a' | 'b'; state: number; tempK: number }[],
  insulationDamaged: boolean,
): string {
  const at = (pred: (e: { state: number; tempK: number }) => boolean) => ends.filter(pred).map((e) => e.name);
  const states: string[] = [];
  const openEnds = at((e) => e.state === END_INTERMITTENT_OPEN);
  const closedEnds = at((e) => e.state === END_INTERMITTENT_CLOSED);
  const arcing = at((e) => e.state === END_ARCING);
  const degrading = at((e) => e.state !== END_INTERMITTENT_OPEN && e.tempK > CONNECTION_OXIDATION_ONSET_K);
  const hot = at(
    (e) =>
      e.state !== END_INTERMITTENT_OPEN && e.tempK >= READOUT_OVERHEAT_K && e.tempK <= CONNECTION_OXIDATION_ONSET_K,
  );
  if (fused) states.push('fused');
  if (openEnds.length > 0) states.push(`intermittent at ${endsText(openEnds)}, open now`);
  if (closedEnds.length > 0) states.push(`intermittent at ${endsText(closedEnds)}, closed now`);
  if (arcing.length > 0) states.push(`arcing at ${endsText(arcing)}`);
  if (status === STATUS_OPEN && !fused && openEnds.length === 0) states.push('open: not in a circuit');
  if (degrading.length > 0) states.push(`degrading at ${endsText(degrading)} (above the oxidation onset)`);
  if (hot.length > 0) states.push(`overheating at ${endsText(hot)}`);
  if (states.length === 0) {
    // Every end is `ok` or has no termination here (any other end state was named above).
    states.push(
      status === STATUS_SOLVED || status === STATUS_OPEN
        ? 'normal'
        : `not solved (${CONNECTION_RECORD_STATUS_VALUES[status] ?? 'unsolved'})`,
    );
  }
  if (insulationDamaged) states.push('insulation damaged');
  return states.join(', ');
}

/** The world's wires in N's order: routed single conductors by id, then cables by id. */
export function wireCycleOrder(world: {
  readonly connections: readonly { readonly id: number; readonly route: unknown }[];
  readonly cables: readonly { readonly id: number }[];
}): WireRef[] {
  const wires: WireRef[] = world.connections
    .filter((c) => c.route !== null)
    .map((c) => ({ kind: 'connection' as const, id: c.id }))
    .sort((a, b) => a.id - b.id);
  const cables = world.cables.map((c) => ({ kind: 'cable' as const, id: c.id })).sort((a, b) => a.id - b.id);
  return [...wires, ...cables];
}

/**
 * The wires to try, in order, for one step (`1` next, `-1` previous) from `current` through `order`,
 * wrapping: every wire once, `current` last. With no current wire (or one not in `order`), N starts at
 * the first wire and Shift+N at the last. The caller selects the first one that is drawn.
 */
export function wireCycleCandidates(order: readonly WireRef[], current: WireRef | null, step: 1 | -1): WireRef[] {
  const n = order.length;
  if (n === 0) return [];
  const at = current === null ? -1 : order.findIndex((w) => sameRef(w, current));
  const start = at < 0 ? (step === 1 ? 0 : n - 1) : (at + step + n) % n;
  return Array.from({ length: n }, (_, i) => order[(((start + step * i) % n) + n) % n]);
}
