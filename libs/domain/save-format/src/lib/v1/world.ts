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

/**
 * The world document (`world.json`), schemaVersion 1. Entities are sorted by strictly ascending `id`
 * and every id is below `nextEntityId`, so each world has exactly one serialised form.
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
    entities: z.array(EntityV1),
    extensions: Extensions,
  })
  .superRefine((world, ctx) => {
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
      'world.json in a .ctrl save (ADR 0004, ADR 0007). Zod in @controls/save-format is authoritative; this JSON Schema omits cross-field rules (sorted unique entity ids below nextEntityId) and string well-formedness.',
  });
export type WorldV1 = z.infer<typeof WorldV1>;
