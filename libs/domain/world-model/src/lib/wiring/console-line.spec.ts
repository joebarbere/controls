import { formatConsoleLine, MAX_CONSOLE_LINE_LENGTH, parseConsoleCommand } from '@controls/commands';
import { MAX_CONDUCTOR_LENGTH_MM, MAX_ROUTE_WAYPOINTS } from '@controls/save-format';
import { createWorldRegistry } from '../session';
import { MAX_PULL_CONDUCTORS, WireAddArgs, WirePullArgs } from './args';

/*
 * MAX_CONSOLE_LINE_LENGTH (`@controls/commands`) must admit the largest legal `wire.add` and
 * `wire.pull` (ADR 0015) as `formatConsoleLine` writes them. This builds both from the real argument
 * schemas, every field at its schema maximum (the longest id each grammar allows, the largest
 * integers, 1 024 waypoints that are each a bore on a 64-character fixture with a tool, 16
 * conductors), and checks the line fits and round-trips through the real registry. It lived in
 * `commands` (`max-line.spec.ts`, against test-only mirrors) until the commands landed (P3 PR 8);
 * `commands` can't import `world-model`, so it moved here. A schema that grows a route field must
 * re-check the cap.
 */

const MAX_COORDINATE_MM = 10_000_000;

/** The longest catalogue id the pattern allows (128 characters). */
const catalogId = `a.${'b'.repeat(126)}`;
/** The longest terminal, hole or die id (32), and the longest camelCase id (method, colour). */
const terminalId = 'T'.repeat(32);
const camelId = `a${'B'.repeat(31)}`;
const otherCamelId = `b${'B'.repeat(31)}`;
const ref = { id: catalogId, version: Number.MAX_SAFE_INTEGER };
/** One of the longest JSON number spellings a finite, non-negative double has. */
const longNumber = 2.2250738585072014e-308;
const corner = { x: -MAX_COORDINATE_MM, y: -MAX_COORDINATE_MM, z: -MAX_COORDINATE_MM };
/** The longest waypoint: a bore (it has a tool) on a fixture (a 64-character id is longer than any entity id). */
const fixtureId = `${'f'.repeat(31)}-${'g'.repeat(32)}`;
const waypoint = { kind: 'bore', positionMm: corner, entity: null, fixture: fixtureId, tool: ref };
const termination = {
  method: camelId,
  strip: { tool: ref, hole: terminalId, lengthMm: 100 },
  accessory: { ref, tool: ref, die: terminalId },
  clamp: { tool: ref, torqueNm: longNumber },
};
const end = { entity: Number.MAX_SAFE_INTEGER, terminal: terminalId, termination };
const colour = { base: camelId, stripe: otherCamelId };
const route = Array.from({ length: MAX_ROUTE_WAYPOINTS }, () => waypoint);

const wireAdd = { ref, a: end, b: end, route, lengthMm: MAX_CONDUCTOR_LENGTH_MM, colour, tool: ref };
const wirePull = {
  route,
  lengthMm: MAX_CONDUCTOR_LENGTH_MM,
  conductors: Array.from({ length: MAX_PULL_CONDUCTORS }, () => ({ ref, colour })),
  tool: ref,
};

const registry = createWorldRegistry();

describe('MAX_CONSOLE_LINE_LENGTH against the real wire.add and wire.pull schemas', () => {
  it.each([
    ['wire.add', WireAddArgs, wireAdd],
    ['wire.pull', WirePullArgs, wirePull],
  ] as const)('admits the largest legal %s, which round-trips', (id, schema, args) => {
    expect(schema.safeParse(args).success).toBe(true);
    expect(registry.get(id)?.args).toBe(schema);
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
