import { z } from 'zod';
import { CatalogRef, Difficulty, Extensions, Int, RegionId } from '../primitives';

/*
 * FROZEN once v0.2.0 ships: schemaVersion 1. Never edit this file after that release; add
 * `v2/world.ts` and a v1 → v2 migration instead (ADR 0004, ADR 0007).
 */

/** Largest |coordinate| in mm (±10 km). Keeps the sum of squared differences of two points a safe integer. */
export const MAX_COORDINATE_MM = 10_000_000;

/** Orientation angles are integer millidegrees in `[0, 360000)` (ADR 0007). */
export const MILLIDEGREES_PER_TURN = 360_000;

/** An integer-millimetre coordinate (ADR 0004: right-handed, +y up). */
export const CoordinateMmV1 = Int.min(-MAX_COORDINATE_MM).max(MAX_COORDINATE_MM);

const AngleMdegV1 = Int.min(0).max(MILLIDEGREES_PER_TURN - 1);

export const PositionMmV1 = z
  .strictObject({ x: CoordinateMmV1, y: CoordinateMmV1, z: CoordinateMmV1 })
  .meta({ id: 'PositionMmV1', description: 'Integer millimetres, right-handed, +y up.' });

/**
 * Intrinsic Tait-Bryan angles applied yaw (about +y), then pitch (about the new +x), then roll (about
 * the new +z), each an integer number of millidegrees in [0, 360000). See ADR 0007.
 */
export const OrientationMdegV1 = z.strictObject({ yaw: AngleMdegV1, pitch: AngleMdegV1, roll: AngleMdegV1 }).meta({
  id: 'OrientationMdegV1',
  description: 'Intrinsic Y-X-Z (yaw, pitch, roll) angles in integer millidegrees, each in [0, 360000).',
});

export const TransformV1 = z
  .strictObject({ positionMm: PositionMmV1, orientationMdeg: OrientationMdegV1 })
  .meta({ id: 'TransformV1' });

/** A placed thing in the as-built world, by catalogue reference. */
export const EntityV1 = z
  .strictObject({
    /** Allocated from `WorldV1.nextEntityId`; never from `crypto.randomUUID` (ADR 0007). */
    id: Int.min(1),
    ref: CatalogRef,
    transform: TransformV1,
    extensions: Extensions,
  })
  .meta({ id: 'EntityV1' });
export type EntityV1 = z.infer<typeof EntityV1>;

/** Fixture ids: lower-case words joined by single hyphens, at most 64 characters (`backplate`, `din-rail-1`). */
export const FIXTURE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Prefix reserved for the view ids of entities (`entity-12`), so a fixture id can never collide with
 * one in `view.focus` or the selection.
 */
export const RESERVED_FIXTURE_ID_PREFIX = 'entity-';

export const FixtureIdV1 = z
  .string()
  .max(64)
  .regex(FIXTURE_ID_PATTERN)
  .refine((id) => !id.startsWith(RESERVED_FIXTURE_ID_PREFIX), {
    message: `Fixture ids may not start with "${RESERVED_FIXTURE_ID_PREFIX}" (reserved for entity view ids)`,
  })
  .meta({ id: 'FixtureIdV1', description: 'Lower-case words joined by single hyphens, at most 64 characters.' });

/**
 * Fixed level geometry (F1.9): walls, benches, backplates and DIN rails that come with a level. A
 * fixture is drawn by a procedural recipe for its catalogue ref and may offer one snap target and a
 * focus target, both named by its `id`. No command creates, moves or deletes fixtures; they change
 * only when a level document does. They are not entities, so they take no entity ids.
 */
export const FixtureV1 = z
  .strictObject({
    id: FixtureIdV1,
    ref: CatalogRef,
    transform: TransformV1,
    extensions: Extensions,
  })
  .meta({ id: 'FixtureV1' });
export type FixtureV1 = z.infer<typeof FixtureV1>;

/**
 * The world document (`world.json`), schemaVersion 1. Entities are sorted by strictly ascending `id`
 * and every id is below `nextEntityId`, and fixtures by strictly ascending `id`, so each world has
 * exactly one serialised form.
 */
export const WorldV1 = z
  .strictObject({
    schemaVersion: z.literal(1),
    /** World PRNG seed, an unsigned 32-bit integer (ADR 0007). */
    seed: Int.min(0).max(0xffff_ffff),
    /** Integer sim tick. Stays 0 until the P2 sim clock exists. */
    tick: Int.min(0),
    /** The next entity id to allocate. */
    nextEntityId: Int.min(1),
    regionId: RegionId,
    difficulty: Difficulty,
    /** Set once a cheat command has run; never cleared. */
    assisted: z.boolean(),
    /** Fixed level geometry, sorted by strictly ascending `id` (UTF-16 code units). */
    fixtures: z.array(FixtureV1),
    entities: z.array(EntityV1),
    extensions: Extensions,
  })
  .superRefine((world, ctx) => {
    world.fixtures.forEach((fixture, index) => {
      if (index > 0 && !(world.fixtures[index - 1].id < fixture.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fixtures', index, 'id'],
          message: 'Fixture ids must be unique and sorted in ascending order',
        });
      }
    });
    let previous = 0;
    world.entities.forEach((entity, index) => {
      if (entity.id <= previous) {
        ctx.addIssue({
          code: 'custom',
          path: ['entities', index, 'id'],
          message: 'Entity ids must be unique and sorted in ascending order',
        });
      }
      if (entity.id >= world.nextEntityId) {
        ctx.addIssue({
          code: 'custom',
          path: ['entities', index, 'id'],
          message: 'Entity id must be below nextEntityId',
        });
      }
      previous = entity.id;
    });
  })
  .meta({
    title: 'Controls world document, schemaVersion 1',
    description:
      'world.json in a .ctrl save (ADR 0004, ADR 0007). Zod in @controls/save-format is authoritative; this JSON Schema omits cross-field rules (sorted unique entity ids below nextEntityId, sorted unique fixture ids, the reserved "entity-" fixture id prefix) and string well-formedness.',
  });
export type WorldV1 = z.infer<typeof WorldV1>;
