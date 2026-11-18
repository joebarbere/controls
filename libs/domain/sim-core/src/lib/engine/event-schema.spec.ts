import { World } from '@controls/save-format';
import { type SimEvent, SimEventSchema } from '@controls/sim-protocol';
import { afciHost } from '../../testing/afci';
import { BATTERY, end, LEAD, origin } from '../../testing/bench';
import { BUSBAR, engineBus, FLIP, RHEOSTAT, THERMAL_LOAD, TWIN_SUPPLY } from '../../testing/engine';
import { GFCI_20, PLUG_ON_20 } from '../../testing/plug-on';
import { BREAKER, FUSE_1A } from '../../testing/protection';
import { BENCH_SUPPLY, DIN_PSU, SourceHost, UTILITY_SPLIT } from '../../testing/sources';
import { wiredLoopWorld } from '../../testing/wired-loop';
import type { CommandedContext, LayerContext } from './device-model';

/*
 * Protocol 8 parses every event's detail exactly on the wire (`SimEventSchema`), and a refused event
 * fails the whole sim link in the game (`parseWorkerMessage` → `invalid-message`). So `emit` is typed
 * by `SimEventDetails` (a wrong detail doesn't compile, below), and this spec runs a scenario for every
 * emitter the engine has, parsing each event it raises with the wire's schema: a GFCI's test press and
 * a ground fault, an AFCI's arc fault, a plug-on breaker's magnetic and thermal trips, the DIN breaker,
 * a DIN PSU's hiccup, a loose termination's connection events, a blown fuse, and the island events.
 * (`SourceHost` also parses every event any spec on it raises: `checkedEvents`.)
 */

const link = (h: SourceHost, a: number, ta: string, b: number, tb: string) =>
  h.exec('lead.connect', { ref: BUSBAR, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });

/** The utility stand-in (1), L1 through `breaker` (2, handle on) into a rheostat (3) at `ohms`, back to N. */
function breakerLoop(breaker: typeof PLUG_ON_20, ohms: number): SourceHost {
  const h = new SourceHost(engineBus(11));
  h.place(UTILITY_SPLIT);
  h.place(breaker);
  h.place(RHEOSTAT);
  link(h, 1, 'l1', 2, 'line');
  link(h, 2, 'load', 3, 'a');
  link(h, 3, 'b', 1, 'n');
  return h.operate(3, 'ohms', ohms).operate(2, 'on', true);
}

/** The GFCI breaker (2) with a 12 Ω load (3) and a leak (4) from its load to N at `leak` Ω. */
function gfci(leak: number): SourceHost {
  const h = new SourceHost(engineBus(11));
  h.place(UTILITY_SPLIT);
  h.place(GFCI_20);
  h.place(RHEOSTAT);
  h.place(RHEOSTAT);
  link(h, 1, 'l1', 2, 'line');
  link(h, 2, 'pigtail', 1, 'n');
  link(h, 2, 'load', 3, 'a');
  link(h, 3, 'b', 2, 'loadNeutral');
  link(h, 2, 'load', 4, 'a');
  link(h, 4, 'b', 1, 'n');
  return h.operate(3, 'ohms', 12).operate(4, 'ohms', leak).operate(2, 'on', true);
}

/** Every event `h` raised, each parsed with the wire's schema; returns their kinds and details. */
function parsed(h: SourceHost): { kind: string; detail: object }[] {
  return h.events.map((event: SimEvent) => {
    const result = SimEventSchema.safeParse(event);
    expect(result.success, JSON.stringify(event)).toBe(true);
    return { kind: event.kind, detail: event.detail };
  });
}

describe('every emitted event parses with the wire schema (protocol 8, typed details)', () => {
  it('the GFCI breaker: a test press (cause test) and a ground fault (cause groundFault)', () => {
    const pressed = gfci(1e7).advance(10);
    pressed.exec('device.press', { id: 2, control: 'test' });
    pressed.advance(4000);
    expect(parsed(pressed)).toContainEqual({ kind: 'tripped', detail: { cause: 'test' } });
    const faulted = gfci(12_000).advance(3000);
    expect(parsed(faulted)).toContainEqual({ kind: 'tripped', detail: { cause: 'groundFault' } });
  });

  it('the AFCI breaker: an arc fault downstream (cause arcFault), and a test press (cause test)', () => {
    const h = afciHost('downstream', 0.4, 1);
    for (let k = 0; k < 600 && !h.events.some((e) => e.kind === 'tripped'); k++) h.advance(100);
    expect(parsed(h)).toContainEqual({ kind: 'tripped', detail: { cause: 'arcFault' } });
    const pressed = afciHost('downstream', 1, 1).advance(10);
    pressed.exec('device.press', { id: 2, control: 'test' });
    expect(parsed(pressed)).toContainEqual({ kind: 'tripped', detail: { cause: 'test' } });
  });

  it('the plug-on breaker (magnetic, thermal) and the DIN breaker', () => {
    const magnetic = breakerLoop(PLUG_ON_20, 12).advance(10);
    magnetic.operate(3, 'ohms', 0.1).advance(40);
    expect(parsed(magnetic)).toContainEqual({ kind: 'tripped', detail: { cause: 'magnetic' } });
    // 200 A on a 20 A breaker, below its 240–400 A band: thermal in about 0.94 s.
    const thermal = breakerLoop(PLUG_ON_20, 0.6).advance(2000);
    expect(parsed(thermal)).toContainEqual({ kind: 'tripped', detail: { cause: 'thermal' } });
    const din = breakerLoop(BREAKER, 12).advance(10);
    din.operate(3, 'ohms', 0.1).advance(40);
    expect(parsed(din).filter((e) => e.kind === 'tripped')).toHaveLength(1);
  });

  it('a DIN PSU hiccups (phase off and retry) and a fuse blows (no detail)', () => {
    const psu = new SourceHost();
    psu.place(DIN_PSU);
    psu.lead(1, 'pos', 1, 'neg').advance(5000);
    const hiccups = parsed(psu).filter((e) => e.kind === 'hiccup');
    expect(hiccups).toContainEqual({ kind: 'hiccup', detail: { phase: 'off' } });
    expect(hiccups).toContainEqual({ kind: 'hiccup', detail: { phase: 'retry' } });
    const fuse = new SourceHost();
    fuse.place(BENCH_SUPPLY);
    fuse.place(FUSE_1A);
    link(fuse, 1, 'pos', 2, 'a');
    link(fuse, 2, 'b', 1, 'neg');
    fuse.operate(1, 'setpointV', 5).operate(1, 'currentLimitA', 5).operate(1, 'outputOn', true).advance(2000);
    expect(parsed(fuse)).toContainEqual({ kind: 'blown', detail: {} });
  });

  it('a loose termination raises the connection events ({ temperatureK })', () => {
    const base = wiredLoopWorld();
    const world = World.parse({
      ...base,
      connections: base.connections.map((c) =>
        c.id === 2 ? { ...c, sim: { ...c.sim, endADegradation: 400, endATerminationId: 1 } } : c,
      ),
    });
    const h = new SourceHost(engineBus(5, world));
    for (let k = 0; k < 120 && !h.events.some((e) => e.kind === 'terminationOverheat'); k++) h.advance(1000);
    const kinds = parsed(h).map((e) => e.kind);
    expect(kinds).toContain('terminationOverheat');
  });

  it('the island events: singular and nonConverged (no detail)', () => {
    const singular = new SourceHost();
    singular.run([
      ['entity.place', { ref: TWIN_SUPPLY, positionMm: origin }],
      ['entity.place', { ref: THERMAL_LOAD, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
    ]);
    singular.advance(10);
    expect(parsed(singular)).toContainEqual({ kind: 'singular', detail: {} });
    const unsettled = new SourceHost();
    unsettled.run([
      ['entity.place', { ref: BATTERY, positionMm: origin }],
      ['entity.place', { ref: FLIP, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'neg') }],
    ]);
    unsettled.advance(10);
    expect(parsed(unsettled)).toContainEqual({ kind: 'nonConverged', detail: {} });
  });

  it('a wrong detail does not compile: emit is typed by SimEventDetails', () => {
    // Type checks only (`pnpm verify` typechecks specs): never called.
    const typed = (ctx: LayerContext, commanded: CommandedContext) => {
      ctx.emit('tripped', 1, { cause: 'magnetic' });
      ctx.emit('blown', 1);
      ctx.emit('hiccup', 1, { phase: 'retry' });
      ctx.emit('lampBurnout', 1, { filamentTempK: 3200 });
      commanded.emit('tripped', 1, { cause: 'test' });
      // @ts-expect-error a cause outside TRIP_CAUSE_VALUES
      ctx.emit('tripped', 1, { cause: 'overload' });
      // @ts-expect-error `tripped` needs its cause
      ctx.emit('tripped', 1);
      // @ts-expect-error `blown` has no detail
      ctx.emit('blown', 1, { cause: 'thermal' });
      // @ts-expect-error a detail key the kind doesn't have
      ctx.emit('overvoltage', 1, { voltageV: 200, dwellMs: 3 });
    };
    expect(typeof typed).toBe('function');
  });
});
