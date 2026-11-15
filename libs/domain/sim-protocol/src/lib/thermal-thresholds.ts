/*
 * The engine's connection thermal thresholds, as display copies for readers that can't import
 * sim-core (the renderer's heat scale, F3.6 part 3). Like `CONNECTION_AMBIENT_K` and
 * `CONNECTION_OVERHEAT_RISE_K` in `connection-output.ts`, each is a copy of a sourced sim-core
 * constant that a sim-core spec (`engine/connection-records.spec.ts`) requires equal; the sources
 * live there. They are **not protocol data**: no record field or message carries them, so they sit
 * outside the protocol fingerprint's modules and changing one needs no `SIM_PROTOCOL_VERSION` bump.
 */

/** sim-core `INSULATION_DAMAGE_MARGIN_K`: `insulationDamaged` is set at an insulation's dry rating + this (ADR 0018 §6). */
export const CONNECTION_INSULATION_DAMAGE_MARGIN_K = 40;

/** sim-core `OXIDATION_ONSET_K`: a termination's contact degrades above this hot-spot temperature (ADR 0018 §5). */
export const CONNECTION_OXIDATION_ONSET_K = 422.15;
