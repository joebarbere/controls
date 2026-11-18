/**
 * Placeholder for the P4 kickoff boundary PR (plans/phase-4-residential.md, kickoff step 4, decision
 * D13): `@controls/inspector` is scaffolding until F4.5 part 1 (the check-kind registry, the rule-set
 * loader and `inspect`, ADR 0022). It exists so the lib has source for the coverage gate to measure
 * and an entry for the path alias; delete it when real code lands.
 */
export const INSPECTOR_PACKAGE = '@controls/inspector' as const;

/**
 * The workspace libs D13 lets the inspector read: the world, the catalogue and the region profile,
 * and sim-core's `wiringGraph`. All `type:domain`.
 */
export const INSPECTOR_READS = [
  '@controls/catalog',
  '@controls/save-format',
  '@controls/world-model',
  '@controls/sim-core',
] as const;

export type InspectorDependency = (typeof INSPECTOR_READS)[number];
