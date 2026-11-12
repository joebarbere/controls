import * as z from 'zod';
import { defineCommand, succeed } from '../command';
import { CommandRegistry } from '../registry';
import { formatConsoleLine, parseConsoleCommand } from './args';
import { MAX_CONSOLE_LINE_LENGTH } from './parse';

/*
 * MAX_CONSOLE_LINE_LENGTH must admit the largest legal `wire.add` and `wire.pull` (ADR 0015) as
 * `formatConsoleLine` writes them. The commands land in a later PR, so this mirrors their argument
 * shapes from ADR 0015 with test-only schemas, fills every field at its schema maximum (the longest
 * id each pattern allows, the longest integers, 1 024 waypoints, 16 conductors) and checks the line
 * fits and round-trips. When the real schemas land, their own spec should do the same.
 */

const MAX_ROUTE_WAYPOINTS = 1024;
const MAX_PULL_CONDUCTORS = 16;
const MAX_COORDINATE_MM = 10_000_000;

const Int = z.int();
const CatalogRef = z.strictObject({ id: z.string().max(128), version: Int.min(1) });
const ShortId = z.string().max(32); // TerminalId, HoleId, DieId, ColourId, TerminationMethodId
const FixtureId = z.string().max(64);
const PositionMm = z.strictObject({ x: Int, y: Int, z: Int });
const Waypoint = z.strictObject({
  kind: z.enum(['free', 'duct', 'conduit', 'staple', 'bore']),
  positionMm: PositionMm,
  entity: Int.min(1).nullable(),
  fixture: FixtureId.nullable(),
  tool: CatalogRef.nullable(),
});
const TerminationArgs = z.strictObject({
  method: ShortId,
  strip: z.strictObject({ tool: CatalogRef, hole: ShortId, lengthMm: Int }),
  accessory: z.strictObject({ ref: CatalogRef, tool: CatalogRef, die: ShortId }).nullable(),
  clamp: z.strictObject({ tool: CatalogRef.nullable(), torqueNm: z.number().nullable() }),
});
const LandedEnd = z.strictObject({
  entity: Int.min(1),
  terminal: ShortId,
  termination: z.union([z.literal('auto'), TerminationArgs]),
});
const Colour = z.strictObject({ base: ShortId, stripe: ShortId.nullable() });
const WireAdd = z.strictObject({
  ref: CatalogRef,
  a: LandedEnd.nullable(),
  b: LandedEnd.nullable(),
  route: z.array(Waypoint).max(MAX_ROUTE_WAYPOINTS),
  lengthMm: Int,
  colour: Colour,
  tool: CatalogRef,
});
const WirePull = z.strictObject({
  route: z.array(Waypoint).max(MAX_ROUTE_WAYPOINTS),
  lengthMm: Int,
  conductors: z
    .array(z.strictObject({ ref: CatalogRef, colour: Colour }))
    .min(1)
    .max(MAX_PULL_CONDUCTORS),
  tool: CatalogRef,
});

/** The longest id of each grammar (only length matters here; the patterns allow these). */
const catalogId = `a.${'b'.repeat(126)}`;
const shortId = 'T'.repeat(32);
const ref = { id: catalogId, version: Number.MAX_SAFE_INTEGER };
/** One of the longest JSON number spellings a finite double has. */
const longNumber = -2.2250738585072014e-308;
const corner = { x: -MAX_COORDINATE_MM, y: -MAX_COORDINATE_MM, z: -MAX_COORDINATE_MM };
/** The longest waypoint: a bore (it has a tool) on a fixture (a 64-character id is longer than any entity id). */
const waypoint = { kind: 'bore', positionMm: corner, entity: null, fixture: 'f'.repeat(64), tool: ref };
const termination = {
  method: shortId,
  strip: { tool: ref, hole: shortId, lengthMm: Number.MAX_SAFE_INTEGER },
  accessory: { ref, tool: ref, die: shortId },
  clamp: { tool: ref, torqueNm: longNumber },
};
const end = { entity: Number.MAX_SAFE_INTEGER, terminal: shortId, termination };
const colour = { base: shortId, stripe: shortId };
const route = Array.from({ length: MAX_ROUTE_WAYPOINTS }, () => waypoint);

const wireAdd = {
  ref,
  a: end,
  b: end,
  route,
  lengthMm: Number.MAX_SAFE_INTEGER,
  colour,
  tool: ref,
};
const wirePull = {
  route,
  lengthMm: Number.MAX_SAFE_INTEGER,
  conductors: Array.from({ length: MAX_PULL_CONDUCTORS }, () => ({ ref, colour })),
  tool: ref,
};

const registry = new CommandRegistry<number>()
  .register(
    defineCommand({ id: 'wire.add', title: 'Add', category: 'T', args: WireAdd, undoable: true, run: () => succeed() }),
  )
  .register(
    defineCommand({
      id: 'wire.pull',
      title: 'Pull',
      category: 'T',
      args: WirePull,
      undoable: true,
      run: () => succeed(),
    }),
  );

describe('MAX_CONSOLE_LINE_LENGTH', () => {
  it.each([
    ['wire.add', WireAdd, wireAdd],
    ['wire.pull', WirePull, wirePull],
  ] as const)('admits the largest legal %s, which round-trips', (id, schema, args) => {
    expect(schema.safeParse(args).success).toBe(true);
    const line = formatConsoleLine(id, args);
    expect(line.length).toBeLessThanOrEqual(MAX_CONSOLE_LINE_LENGTH);
    const parsed = parseConsoleCommand(registry, line);
    expect(parsed).toEqual({ ok: true, command: { id, args: JSON.parse(JSON.stringify(args)) } });
  });

  it('is the largest of them plus headroom, not far beyond it', () => {
    const largest = Math.max(
      formatConsoleLine('wire.add', wireAdd).length,
      formatConsoleLine('wire.pull', wirePull).length,
    );
    expect(largest).toBeGreaterThan(MAX_CONSOLE_LINE_LENGTH / 2);
  });
});
