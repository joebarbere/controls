import { defineViewCommand, NoArgs } from '@controls/commands';
import { createWorld, type ReplayEntry } from '@controls/save-format';
import { catalogRefArb } from '@controls/save-format/testing';
import { createWorldRegistry, type World } from '@controls/world-model';
import fc from 'fast-check';
import {
  CONSOLE_QUERIES,
  describeExecError,
  formatConsoleScriptError,
  MAX_CONSOLE_SCRIPT_LINES,
  runConsoleScript,
  toConsoleScript,
} from './console-script';
import { createGame } from './game';

const SCRIPT = `# Place a crate, nudge it, delete it, then undo the delete.
entity.place --ref.id prop.crate --ref.version 1 --positionMm.x 100 --positionMm.y 0 --positionMm.z -200
world.hash
entity.move 1 --positionMm.x 150 --positionMm.y 0 --positionMm.z -200   # positional id

view.resetLayout
entity.delete 1
edit.undo
world.hash
`;

describe('runConsoleScript', () => {
  it('runs every line through exec and prints world.hash queries', async () => {
    const game = createGame({ seed: 7 });
    const result = await runConsoleScript(game, SCRIPT);
    expect(result).toMatchObject({ ok: true, executed: 5 });
    expect(result.output).toHaveLength(2);
    expect(result.output[1]).toBe(game.hash());
    expect(game.entries().map((e) => e.id)).toEqual([
      'entity.place',
      'entity.move',
      'view.resetLayout',
      'entity.delete',
      'edit.undo',
    ]);

    // The same session through exec gives the same hash and the same log.
    const direct = createGame({ seed: 7 });
    direct.execOrThrow('entity.place', {
      ref: { id: 'prop.crate', version: 1 },
      positionMm: { x: 100, y: 0, z: -200 },
    });
    expect(result.output[0]).toBe(direct.hash());
    direct.execOrThrow('entity.move', { id: 1, positionMm: { x: 150, y: 0, z: -200 } });
    direct.execOrThrow('view.resetLayout');
    direct.execOrThrow('entity.delete', { id: 1 });
    direct.execOrThrow('edit.undo');
    expect(game.replayLog()).toEqual(direct.replayLog());
  });

  it('prints a netlist.dump query as its lines, in order with the other lines, and never logs it (F2.6)', async () => {
    const game = createGame({ seed: 7 });
    const place = (ref: string, x: number) =>
      `entity.place --ref.id ${ref} --ref.version 1 --positionMm.x ${x} --positionMm.y 0 --positionMm.z 0`;
    const script = [
      'netlist.dump',
      place('battery.ferrovane-12v-7ah', 0),
      'lead.connect --ref.id lead.quillfern-test-1m --ref.version 1 --a.entity 1 --a.terminal pos --b.entity 1 --b.terminal neg',
      'sim.step 15',
      'netlist.dump',
      'world.hash',
    ].join('\n');
    const result = await runConsoleScript(game, script);
    expect(result).toMatchObject({ ok: true, executed: 3 });
    const empty = createGame({ seed: 7 }).netlistDump().trimEnd().split('\n');
    const now = game.netlistDump().trimEnd().split('\n');
    expect(result.output).toEqual([...empty, ...now, game.hash()]);
    expect(now[0]).toBe('netlist.dump tick 15');
    expect(now).toContain('solution tick 10');
    expect(game.entries().map((e) => e.id)).toEqual(['entity.place', 'lead.connect', 'sim.step']);
    expect(CONSOLE_QUERIES).toContain('netlist.dump');
  });

  it('checks the whole file before running anything', async () => {
    const game = createGame({ seed: 7 });
    const result = await runConsoleScript(game, 'entity.delete 1\nview.resetLayout\nentity.move --nope 1\n');
    expect(result).toEqual({
      ok: false,
      executed: 0,
      output: [],
      error: { kind: 'parse', lineNumber: 3, column: 13, message: 'Unknown argument --nope' },
    });
    expect(game.entries()).toEqual([]);
    expect(await runConsoleScript(game, '\n  nope.nope\n')).toMatchObject({
      ok: false,
      error: { kind: 'parse', lineNumber: 2, column: 3, message: 'Unknown command "nope.nope"' },
    });
    expect(await runConsoleScript(game, 'world.hash --verbose')).toMatchObject({
      ok: false,
      error: { kind: 'parse', column: 12, message: 'world.hash takes no arguments' },
    });
    expect(await runConsoleScript(game, 'world.hash now')).toMatchObject({ ok: false, error: { column: 12 } });
  });

  it('stops at the first failing command, keeping what ran before it', async () => {
    const game = createGame({ seed: 7 });
    const result = await runConsoleScript(game, 'view.resetLayout\nworld.hash\n  entity.delete 4\nview.resetLayout\n');
    expect(result).toMatchObject({
      ok: false,
      executed: 1,
      output: [game.hash()],
      error: { kind: 'exec', lineNumber: 3, column: 3, message: 'No entity with id 4', error: { code: 'not-found' } },
    });
    expect(game.entries()).toHaveLength(1);
    expect(formatConsoleScriptError(result.ok ? (undefined as never) : result.error)).toBe(
      'line 3, column 3: No entity with id 4',
    );
  });

  it('describes invalid args with their first issues', async () => {
    const game = createGame({ seed: 7 });
    const result = await runConsoleScript(game, 'entity.place --ref.id prop.crate --ref.version 0');
    if (result.ok) throw new Error('expected a failure');
    expect(result.error.message).toMatch(/^Invalid arguments for "entity.place": ref.version: .+; positionMm: /);
    expect(
      describeExecError({ kind: 'invalid-args', id: 'x.y', message: 'Bad', issues: [{ path: '', message: 'm' }] }),
    ).toBe('Bad: m');
    expect(describeExecError({ kind: 'invalid-args', id: 'x.y', message: 'Bad', issues: [] })).toBe('Bad');
  });

  it('caps the number of lines', async () => {
    const game = createGame({ seed: 7 });
    expect(await runConsoleScript(game, '\n'.repeat(MAX_CONSOLE_SCRIPT_LINES))).toMatchObject({
      ok: false,
      error: { lineNumber: MAX_CONSOLE_SCRIPT_LINES + 1 },
    });
    expect(await runConsoleScript(game, '\n'.repeat(MAX_CONSOLE_SCRIPT_LINES - 1))).toEqual({
      ok: true,
      executed: 0,
      output: [],
    });
  });

  it('defers to the registry if a host registers a command with a query id', async () => {
    expect(CONSOLE_QUERIES).toContain('world.hash');
    const registry = createWorldRegistry().register(
      defineViewCommand<NoArgs, World>({ id: 'world.hash', title: 'Shadow', category: 'View', args: NoArgs }),
    );
    const game = createGame({ seed: 7, registry });
    expect(await runConsoleScript(game, 'world.hash')).toEqual({ ok: true, executed: 1, output: [] });
    expect(game.entries().map((e) => e.id)).toEqual(['world.hash']);
  });
});

describe('toConsoleScript', () => {
  const coordinate = fc.integer({ min: -1_000_000, max: 1_000_000 });
  const position = fc.record({ x: coordinate, y: coordinate, z: coordinate });
  const pick = fc.nat({ max: 5 });
  const opArb = fc.oneof(
    fc.record({ kind: fc.constant('place' as const), ref: catalogRefArb, positionMm: position }),
    fc.record({ kind: fc.constant('move' as const), pick, positionMm: position }),
    fc.record({ kind: fc.constant('rotate' as const), pick, yaw: fc.integer({ min: -359_999, max: 359_999 }) }),
    fc.record({ kind: fc.constant('delete' as const), pick }),
    fc.constant({ kind: 'undo' as const }),
    fc.constant({ kind: 'redo' as const }),
    fc.constant({ kind: 'view' as const }),
  );

  it('re-runs any recorded session as console lines to the same hash and log (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: 0xffff_ffff }), fc.array(opArb, { maxLength: 20 }), async (seed, ops) => {
        const live = createGame({ seed });
        for (const op of ops) {
          const ids = live.world().entities.map((e) => e.id);
          const id = 'pick' in op ? (ids[op.pick] ?? 1000) : 0;
          if (op.kind === 'place') live.exec('entity.place', { ref: op.ref, positionMm: op.positionMm });
          if (op.kind === 'move') live.exec('entity.move', { id, positionMm: op.positionMm });
          if (op.kind === 'rotate') live.exec('entity.rotate', { id, deltaMdeg: { yaw: op.yaw, pitch: 0, roll: 0 } });
          if (op.kind === 'delete') live.exec('entity.delete', { id });
          if (op.kind === 'undo') live.exec('edit.undo');
          if (op.kind === 'redo') live.exec('edit.redo');
          if (op.kind === 'view') live.exec('view.resetLayout');
        }
        const script = toConsoleScript(live.entries());
        const replayed = createGame({ world: createWorld({ seed }) });
        expect(await runConsoleScript(replayed, script)).toMatchObject({ ok: true, executed: live.entries().length });
        expect(replayed.hash()).toBe(live.hash());
        expect(replayed.entries()).toEqual(live.entries());
      }),
    );
  });

  it('writes one line per entry', () => {
    const entries: ReplayEntry[] = [
      { seq: 0, tick: 0, id: 'entity.delete', args: { id: 3 } },
      { seq: 1, tick: 0, id: 'edit.undo', args: {} },
    ];
    expect(toConsoleScript(entries)).toBe('entity.delete --id 3\nedit.undo\n');
    expect(toConsoleScript([])).toBe('');
  });
});
