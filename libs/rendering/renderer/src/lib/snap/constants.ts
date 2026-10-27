/**
 * Snap constants. Realism charter (plan §3): every real-world dimension carries a `source`;
 * values chosen for play are marked `kind: 'game-design'` and say so in `source`.
 * Re-checked by `electrical-realism-reviewer` once it exists (P2).
 *
 * Published values are kept exact (they may be fractional, e.g. 406.4 mm); the snap functions
 * round to integer millimetres at the last step.
 */
export interface SourcedLength {
  readonly valueMm: number;
  readonly kind: 'real-world' | 'game-design';
  readonly source: string;
}

/** TS35 top-hat rail profile (35 × 7.5 mm, 1 mm steel). */
export const DIN_RAIL_TS35 = {
  widthMm: {
    valueMm: 35,
    kind: 'real-world',
    source: 'EN 60715:2017 (IEC 60715), top-hat rail TS 35 × 7.5: overall width 35 mm',
  },
  heightMm: {
    valueMm: 7.5,
    kind: 'real-world',
    source: 'EN 60715:2017 (IEC 60715), top-hat rail TS 35 × 7.5: depth 7.5 mm',
  },
  crownWidthMm: {
    valueMm: 27,
    kind: 'real-world',
    source: 'EN 60715:2017 (IEC 60715), TS 35 profile: 27 mm between the outer faces of the raised section',
  },
  thicknessMm: {
    valueMm: 1,
    kind: 'real-world',
    source: 'EN 60715:2017 (IEC 60715), TS 35 × 7.5: 1 mm sheet thickness',
  },
} as const satisfies Record<string, SourcedLength>;

/**
 * Pitch for modular DIN-rail devices (one "module"). DIN 43880 gives a 17.5 mm module width; modular
 * devices are commonly built to an 18 mm pitch, which is also integer-mm. Using 18 mm is a rounding
 * choice, labelled as such.
 */
export const DIN_MODULE_PITCH: SourcedLength = {
  valueMm: 18,
  kind: 'real-world',
  source:
    'DIN 43880:1988 module width 17.5 mm; 18 mm is the per-module pitch common in modular-device catalogues (rounded up to integer mm: game-design choice)',
};

/** Studs at 16 in on centre, the usual US light-frame wall layout. */
export const WALL_STUD_SPACING: SourcedLength = {
  valueMm: 406.4,
  kind: 'real-world',
  source:
    'IRC 2021 Table R602.3(5) permits 16 in o.c. stud spacing (paraphrased, not reproduced); 16 in = 406.4 mm exactly (NIST SP 811)',
};

/** Dressed thickness of a nominal 2×4 stud (1-1/2 in). */
export const WALL_STUD_THICKNESS: SourcedLength = {
  valueMm: 38.1,
  kind: 'real-world',
  source: 'American Softwood Lumber Standard (NIST DOC PS 20-20): nominal 2 in dressed dry = 1-1/2 in = 38.1 mm',
};

/** Backplate placement grid. Real sub-panels are drilled anywhere; the grid is for play. */
export const BACKPLATE_GRID_PITCH: SourcedLength = {
  valueMm: 5,
  kind: 'game-design',
  source: 'game-design: 5 mm grid for free backplate placement (no standard grid exists)',
};

/** Vertical increment for wall-mounted items. */
export const WALL_VERTICAL_PITCH: SourcedLength = {
  valueMm: 10,
  kind: 'game-design',
  source: 'game-design: 10 mm vertical increment on walls',
};

/** How far (perpendicular) from a DIN rail centreline the cursor may be and still snap to it. */
export const DIN_RAIL_CAPTURE: SourcedLength = {
  valueMm: 40,
  kind: 'game-design',
  source: 'game-design: capture band around the rail centreline',
};
