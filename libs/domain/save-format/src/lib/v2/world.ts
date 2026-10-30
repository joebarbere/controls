import { z } from 'zod';
import {
  CatalogRef,
  DeviceStateBag,
  Difficulty,
  Extensions,
  FiniteNumber,
  Int,
  RegionId,
  TerminalId,
} from '../primitives';
import { FixtureV1, TransformV1 } from '../v1/world';

/*
 * FROZEN once v0.3.0 ships: schemaVersion 2 (ADR 0013). Until then it may still change, with its
 * fixtures updated in the same PR; after that, add `v3/world.ts` and a v2 → v3 migration instead.
 *
 * v2 adds what the circuit engine (P2) needs persisted: connections (test leads), each entity's two
 * device state bags, the connection id counter and the last electrical solution. Fixtures and
 * transforms are unchanged from v1 and reuse its schemas.
 */

/** One end of a connection: a terminal of an entity (`{ entity: 3, terminal: 'pos' }`). */
export const TerminalRefV2 = z
  .strictObject({
    entity: Int.min(1),
    terminal: TerminalId,
  })
  .meta({ id: 'TerminalRefV2', description: 'A terminal of an entity: its entity id and the terminal id.' });
export type TerminalRefV2 = z.infer<typeof TerminalRefV2>;

/**
 * A two-ended connection between device terminals: a test lead in P2 (`lead.connect`), wires from
 * P3 (world v3). `ref` names its catalogue entry (a `lead` model kind). Ids come from
 * `WorldV2.nextConnectionId`, by the same rule as entity ids (ADR 0013).
 */
export const ConnectionV2 = z
  .strictObject({
    /** Allocated from `WorldV2.nextConnectionId` (ADR 0013). */
    id: Int.min(1),
    ref: CatalogRef,
    a: TerminalRefV2,
    b: TerminalRefV2,
    extensions: Extensions,
  })
  .meta({ id: 'ConnectionV2' });
export type ConnectionV2 = z.infer<typeof ConnectionV2>;

/** A placed thing in the as-built world, by catalogue reference, with its device state (ADR 0011 §1). */
export const EntityV2 = z
  .strictObject({
    /** Allocated from `WorldV2.nextEntityId`; never from `crypto.randomUUID` (ADR 0007). */
    id: Int.min(1),
    ref: CatalogRef,
    transform: TransformV1,
    /**
     * Commanded device state (a switch's `closed`): written only by commands. Its keys are the
     * commanded keys of the device's model kind (`MODEL_KINDS`), checked when a world loads; `{}` for
     * props and devices without commanded state.
     */
    state: DeviceStateBag,
    /**
     * Sim-owned device state (a battery's `stateOfCharge`): written only by `materialiseWorld` when a
     * save or `world.hash` is taken. Inert in the live world: never read during play (ADR 0011 §1).
     */
    sim: DeviceStateBag,
    extensions: Extensions,
  })
  .meta({ id: 'EntityV2' });
export type EntityV2 = z.infer<typeof EntityV2>;

/** A SHA-256 digest as 64 lower-case hex digits. */
export const Sha256HexV2 = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .meta({ id: 'Sha256HexV2', description: 'A SHA-256 digest as 64 lower-case hex digits.' });

/**
 * The last electrical solution (ADR 0011 §9.6, decision U3): what the engine needs to continue
 * bit-exactly from a tick between solves. Written only by `materialiseWorld`. Node voltages and
 * branch currents are `re, im` pairs, interleaved, in the netlist compiler's order (F2.1). The engine
 * checks `topologyHash` and the lengths against the compiled netlist when it starts (a mismatch is
 * `start-failed`, never a silent re-solve).
 */
export const SimSolutionV2 = z
  .strictObject({
    /** The tick of the solve. At most the world's `tick`. */
    lastSolveTick: Int.min(0),
    /** F2.1's `topologyHash` of the netlist that was solved. */
    topologyHash: Sha256HexV2,
    /** Node voltages (V): `re₀, im₀, re₁, im₁, …`. */
    nodes: z.array(FiniteNumber),
    /** Branch currents (A): `re₀, im₀, re₁, im₁, …`. */
    branches: z.array(FiniteNumber),
    /** Per island, in netlist order: its `singular`/`nonConverged` flag bits and outer-loop iterations. */
    islands: z.array(
      z.strictObject({
        flags: Int.min(0).max(0xff),
        iterations: Int.min(0).max(0xffff),
      }),
    ),
  })
  .meta({ id: 'SimSolutionV2' });
export type SimSolutionV2 = z.infer<typeof SimSolutionV2>;

/**
 * The world document (`world.json`), schemaVersion 2. Entities, fixtures and connections are each
 * sorted by strictly ascending `id`; entity ids are below `nextEntityId` and connection ids below
 * `nextConnectionId`; every connection joins two different terminals of entities that exist. So each
 * world has exactly one serialised form, and no connection dangles.
 */
export const WorldV2 = z
  .strictObject({
    schemaVersion: z.literal(2),
    /** World PRNG seed, an unsigned 32-bit integer (ADR 0007). */
    seed: Int.min(0).max(0xffff_ffff),
    /** Integer sim tick: 1 tick = 1 ms of sim time (ADR 0011 §2). */
    tick: Int.min(0),
    /** The next entity id to allocate. */
    nextEntityId: Int.min(1),
    /** The next connection id to allocate (ADR 0013). */
    nextConnectionId: Int.min(1),
    regionId: RegionId,
    difficulty: Difficulty,
    /** Set once a cheat command has run; never cleared. */
    assisted: z.boolean(),
    /** Fixed level geometry, sorted by strictly ascending `id` (UTF-16 code units). */
    fixtures: z.array(FixtureV1),
    entities: z.array(EntityV2),
    /** Connections between entity terminals (test leads), sorted by strictly ascending `id`. */
    connections: z.array(ConnectionV2),
    /** The last electrical solution, or `null`: not solved since the session started (ADR 0011 §9.6). */
    sim: SimSolutionV2.nullable(),
    extensions: Extensions,
  })
  .superRefine((world, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    world.fixtures.forEach((fixture, index) => {
      if (index > 0 && !(world.fixtures[index - 1].id < fixture.id)) {
        issue(['fixtures', index, 'id'], 'Fixture ids must be unique and sorted in ascending order');
      }
    });
    let previous = 0;
    const entityIds = new Set<number>();
    world.entities.forEach((entity, index) => {
      if (entity.id <= previous)
        issue(['entities', index, 'id'], 'Entity ids must be unique and sorted in ascending order');
      if (entity.id >= world.nextEntityId) issue(['entities', index, 'id'], 'Entity id must be below nextEntityId');
      previous = entity.id;
      entityIds.add(entity.id);
    });
    previous = 0;
    world.connections.forEach((connection, index) => {
      if (connection.id <= previous) {
        issue(['connections', index, 'id'], 'Connection ids must be unique and sorted in ascending order');
      }
      if (connection.id >= world.nextConnectionId) {
        issue(['connections', index, 'id'], 'Connection id must be below nextConnectionId');
      }
      previous = connection.id;
      for (const end of ['a', 'b'] as const) {
        if (!entityIds.has(connection[end].entity)) {
          issue(['connections', index, end, 'entity'], 'A connection must join entities that exist');
        }
      }
      if (connection.a.entity === connection.b.entity && connection.a.terminal === connection.b.terminal) {
        issue(['connections', index, 'b'], 'A connection must join two different terminals');
      }
    });
    if (world.sim !== null) {
      if (world.sim.lastSolveTick > world.tick) issue(['sim', 'lastSolveTick'], 'lastSolveTick must not be after tick');
      if (world.sim.nodes.length % 2 !== 0) issue(['sim', 'nodes'], 'nodes holds re, im pairs');
      if (world.sim.branches.length % 2 !== 0) issue(['sim', 'branches'], 'branches holds re, im pairs');
    }
  })
  .meta({
    title: 'Controls world document, schemaVersion 2',
    description:
      'world.json in a .ctrl save (ADR 0004, ADR 0007, ADR 0013). Zod in @controls/save-format is authoritative; this JSON Schema omits cross-field rules (sorted unique entity, fixture and connection ids below their counters, connections joining two different terminals of existing entities, sim solution pairs and tick), string well-formedness, and the per-model-kind state keys (json-schema/device-state.<kind>.schema.json in @controls/catalog).',
  });
export type WorldV2 = z.infer<typeof WorldV2>;
