import { BUILTIN_CATALOG } from '@controls/catalog';
import { defineViewCommand, NoArgs } from '@controls/commands';
import { createWorld, type ReplayEntry } from '@controls/save-format';
import { catalogRefArb } from '@controls/save-format/testing';
import { createWorldRegistry, type World } from '@controls/world-model';
import fc from 'fast-check';
import {
  CONSOLE_EXPANDERS,
  CONSOLE_QUERIES,
  CONSOLE_QUERY_ARGS,
  type ConsoleExpander,
  type ConsoleTarget,
  consoleShorthand,
  describeExecError,
  expandConsoleArgs,
  formatConsoleScriptError,
  MAX_CONSOLE_SCRIPT_LINES,
  runConsoleScript,
  toConsoleScript,
} from './console-script';
import { createGame, type Game } from './game';

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

  it('maps query arguments like command arguments (none takes any yet)', async () => {
    expect(CONSOLE_QUERY_ARGS['world.hash']).toBeDefined();
    expect(await runConsoleScript(createGame({ seed: 7 }), 'netlist.dump --all')).toMatchObject({
      ok: false,
      error: { kind: 'parse', lineNumber: 1, column: 14, message: 'netlist.dump takes no arguments' },
    });
  });
});

describe('console shorthand (expandConsoleArgs, ADR 0015)', () => {
  /** A test-only shorthand: `--positionMm.x next` places 100 mm right of the last entity, read from the live world. */
  const nextX: ConsoleExpander = {
    id: 'entity.place',
    paths: ['positionMm.x'],
    expand: (world, catalog, args) => {
      expect(catalog).toBe(BUILTIN_CATALOG);
      const position = args['positionMm'] as Record<string, unknown>;
      if (position['x'] !== 'next') return { ok: true, args: { ...args } };
      if (world.entities.length >= 2) return { ok: false, message: 'No room for another crate' };
      return { ok: true, args: { ...args, positionMm: { ...position, x: 100 * world.entities.length } } };
    },
  };
  const target = (game: Game, expanders: readonly ConsoleExpander[]): ConsoleTarget => ({
    registry: game.registry,
    world: () => game.world(),
    exec: (id, args) => game.exec(id, args),
    hash: () => game.hash(),
    netlistDump: () => game.netlistDump(),
    expanders,
  });
  const place = (x: string) =>
    `entity.place --ref.id prop.crate --ref.version 1 --positionMm.x ${x} --positionMm.y 0 --positionMm.z 0`;

  it("ships `--lengthMm auto` for wire.add, wire.pull and cable.add, and no `--route auto` yet (F3.2 part 1's router)", () => {
    expect(CONSOLE_EXPANDERS.map((e) => [e.id, e.paths])).toEqual([
      ['wire.add', ['lengthMm']],
      ['wire.pull', ['lengthMm']],
      ['cable.add', ['lengthMm']],
    ]);
    const args = { a: 1 };
    expect(expandConsoleArgs(createWorld({ seed: 0 }), BUILTIN_CATALOG, 'entity.place', args)).toEqual({
      ok: true,
      args,
    });
    expect(consoleShorthand()('entity.place', 'positionMm.x')).toBe(false);
    expect(consoleShorthand()('wire.add', 'lengthMm')).toBe(true);
    expect(consoleShorthand()('wire.add', 'route')).toBe(false);
  });

  it('runs a registered expander per line, on the live world, and logs only the expanded args', async () => {
    const game = createGame({ seed: 7 });
    const result = await runConsoleScript(
      target(game, [nextX]),
      [place('next'), place('next'), place('50')].join('\n'),
    );
    expect(result).toMatchObject({ ok: true, executed: 3 });
    const xs = game.entries().map((e) => (e.args['positionMm'] as { x: unknown }).x);
    expect(xs).toEqual([0, 100, 50]); // the second line saw the entity the first one placed
    expect(JSON.stringify(game.entries())).not.toContain('"next"');

    // The log replays as console lines without the expander.
    const again = createGame({ seed: 7 });
    expect(await runConsoleScript(again, toConsoleScript(game.entries()))).toMatchObject({ ok: true, executed: 3 });
    expect(again.hash()).toBe(game.hash());
  });

  it('types shorthand paths only where an expander claims them', async () => {
    const result = await runConsoleScript(createGame({ seed: 7 }), place('next'));
    expect(result).toMatchObject({ ok: false, error: { kind: 'parse', message: /expects a number/ } });
    expect(consoleShorthand([nextX])('entity.place', 'positionMm.x')).toBe(true);
    expect(consoleShorthand([nextX])('entity.place', 'positionMm.y')).toBe(false);
  });

  it('stops at a line whose shorthand fails, keeping what ran before it', async () => {
    const game = createGame({ seed: 7 });
    const script = [place('next'), place('next'), place('next'), place('0')].join('\n');
    const result = await runConsoleScript(target(game, [nextX]), script);
    expect(result).toEqual({
      ok: false,
      executed: 2,
      output: [],
      error: { kind: 'expand', lineNumber: 3, column: 1, message: 'No room for another crate' },
    });
    expect(game.entries()).toHaveLength(2);
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
