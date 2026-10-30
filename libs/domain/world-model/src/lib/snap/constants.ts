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
    source: 'IEC 60715:2017 Ed. 2.0 (adopted in Europe as EN IEC 60715), top-hat rail TS 35 × 7.5: overall width 35 mm',
  },
  heightMm: {
    valueMm: 7.5,
    kind: 'real-world',
    source: 'IEC 60715:2017 Ed. 2.0 (adopted in Europe as EN IEC 60715), top-hat rail TS 35 × 7.5: depth 7.5 mm',
  },
  crownWidthMm: {
    valueMm: 27,
    kind: 'real-world',
    source:
      'IEC 60715:2017 Ed. 2.0 (adopted in Europe as EN IEC 60715), TS 35 profile: 27 mm across the outer faces of the hat walls (the web that sits on the mounting plate; the 35 mm brims stand off it)',
  },
  thicknessMm: {
    valueMm: 1,
    kind: 'real-world',
    source: 'IEC 60715:2017 Ed. 2.0 (adopted in Europe as EN IEC 60715), TS 35 × 7.5: 1 mm sheet thickness',
  },
} as const satisfies Record<string, SourcedLength>;

/**
 * Width of one module of a modular installation device (MCBs, RCDs, modular contactors and relays).
 * Terminal blocks and slim interface relays use their own pitches and must not snap to this one. Kept
 * exact: slot `k` on a rail starts `round(k × 17.5)` mm from the rail's end, rounded once like the
 * stud layout, so 40 modules span exactly 700 mm. (Until F1.9 this was a rounded 18 mm pitch.)
 */
export const DIN_MODULE_PITCH: SourcedLength = {
  valueMm: 17.5,
  kind: 'real-world',
  source:
    'DIN 43880:1988 (built-in equipment for electrical installations, overall dimensions): module width 17.5 mm; slot starts are rounded once to integer mm',
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

/** Depth of a nominal 2×4 stud across the wall (3-1/2 in). */
export const WALL_STUD_DEPTH: SourcedLength = {
  valueMm: 88.9,
  kind: 'real-world',
  source: 'American Softwood Lumber Standard (NIST DOC PS 20-20): nominal 4 in dressed dry = 3-1/2 in = 88.9 mm',
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

/** Placement grid on a bench top (F1.9). */
export const BENCH_TOP_GRID_PITCH: SourcedLength = {
  valueMm: 10,
  kind: 'game-design',
  source: 'game-design: 10 mm grid for setting props down on a bench top',
};

/** Keep-out border around a bench top's edge, so props never overhang it. */
export const BENCH_TOP_MARGIN: SourcedLength = {
  valueMm: 10,
  kind: 'game-design',
  source: 'game-design: 10 mm keep-out border on bench tops',
};

/** How far (perpendicular) from a DIN rail centreline the cursor may be and still snap to it. */
export const DIN_RAIL_CAPTURE: SourcedLength = {
  valueMm: 40,
  kind: 'game-design',
  source: 'game-design: capture band around the rail centreline',
};

/** Keep-out border around a backplate's edge for free placement. */
export const BACKPLATE_MARGIN: SourcedLength = {
  valueMm: 20,
  kind: 'game-design',
  source: 'game-design: 20 mm keep-out border so placed parts never overhang the backplate edge',
};

/**
 * How far off a surface's plane (along its normal) a cursor hit may be and still count as on that
 * surface. Large enough for a hit on top of a TS35 rail (7.5 mm proud of the backplate).
 */
export const SNAP_PLANE_TOLERANCE: SourcedLength = {
  valueMm: 10,
  kind: 'game-design',
  source: 'game-design: covers a cursor hit on a TS35 rail top (7.5 mm, EN 60715) plus 2.5 mm slack',
};
