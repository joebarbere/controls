/**
 * The P1 demo sub-panel as data: a 600 × 800 mm backplate centred on the world origin (front face at
 * z = 0, facing +z) with two 500 mm TS35 DIN rails. The renderer draws it from this table, and
 * scripts snap against {@link demoPanelSnapTargets}, so a cursor point snaps to the same place in
 * the game and headless.
 *
 * Layout values are game-design (a small demo panel, not a product). TODO(F1.9): the workshop level
 * document replaces this table; the backplate and rails become level entities.
 */
import { BACKPLATE_MARGIN } from './constants';
import type { BackplateGridTarget, DinRailTarget, SnapTarget } from './snap';

export interface DemoPanelRail {
  readonly id: string;
  /** World y of the rail's centreline. */
  readonly yMm: number;
  readonly lengthMm: number;
}

export interface DemoPanelLayout {
  readonly backplate: { readonly id: string; readonly widthMm: number; readonly heightMm: number };
  /** Rails in id order, centred on x = 0, their backs on the plate face. */
  readonly rails: readonly DemoPanelRail[];
  readonly source: string;
}

export const DEMO_PANEL: DemoPanelLayout = {
  backplate: { id: 'backplate', widthMm: 600, heightMm: 800 },
  rails: [
    { id: 'din-rail-1', yMm: 150, lengthMm: 500 },
    { id: 'din-rail-2', yMm: -50, lengthMm: 500 },
  ],
  source: 'game-design: P0/P1 demo sub-panel layout (600 × 800 mm plate, two 500 mm rails)',
};

/** The backplate's snap target: frame origin at its lower-left corner on the front face. */
export function demoBackplateTarget(layout: DemoPanelLayout = DEMO_PANEL): BackplateGridTarget {
  const { id, widthMm, heightMm } = layout.backplate;
  return {
    kind: 'backplate-grid',
    id,
    frame: { origin: { x: -widthMm / 2, y: -heightMm / 2, z: 0 }, normal: '+z' },
    widthMm,
    heightMm,
    marginMm: BACKPLATE_MARGIN.valueMm,
  };
}

/** A rail's snap target: frame origin at its left end, on the centreline, on the plate face. */
export function demoRailTarget(rail: DemoPanelRail): DinRailTarget {
  return {
    kind: 'din-rail',
    id: rail.id,
    frame: { origin: { x: -rail.lengthMm / 2, y: rail.yMm, z: 0 }, normal: '+z' },
    lengthMm: rail.lengthMm,
  };
}

/** Every snap target on the demo panel: the backplate, then the rails. */
export function demoPanelSnapTargets(layout: DemoPanelLayout = DEMO_PANEL): SnapTarget[] {
  return [demoBackplateTarget(layout), ...layout.rails.map(demoRailTarget)];
}
