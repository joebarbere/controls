import { z } from 'zod';

/** One docked panel: its size in CSS pixels (integer) and whether it is collapsed. */
export interface PanelLayout {
  readonly size: number;
  readonly collapsed: boolean;
}

/**
 * The workspace layout: plain JSON, stored in settings (`workspace.layout`). The 3D viewport takes
 * whatever space the docked panels leave. ADR 0005 explains why this is a fixed set of panels
 * rather than a general docking tree.
 */
export interface WorkspaceLayout {
  /** Side panel, right of the viewport. */
  readonly inspector: PanelLayout;
  /** Bottom panel under the viewport (the F1.5 console docks here). */
  readonly bottom: PanelLayout;
}

export interface PanelLimits {
  readonly min: number;
  readonly max: number;
}

export const INSPECTOR_LIMITS: PanelLimits = { min: 200, max: 640 };
export const BOTTOM_LIMITS: PanelLimits = { min: 96, max: 560 };

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  inspector: { size: 320, collapsed: false },
  bottom: { size: 200, collapsed: false },
};

/** Brings any stored layout back inside the limits (sizes are whole pixels). */
export function normaliseLayout(layout: WorkspaceLayout): WorkspaceLayout {
  return {
    inspector: normalisePanel(layout.inspector, INSPECTOR_LIMITS),
    bottom: normalisePanel(layout.bottom, BOTTOM_LIMITS),
  };
}

/**
 * How the layout is stored in the opaque `settings.workspace.layout` JSON value. `kind` and
 * `version` let a later layout format (e.g. a dockview tree, ADR 0005) recognise and migrate it.
 * Sizes are finite numbers here and clamped by {@link normaliseLayout}, so a slightly out-of-range
 * stored size is corrected rather than discarded.
 */
const StoredPanel = z.strictObject({ size: z.number().finite(), collapsed: z.boolean() });
const StoredLayoutV1 = z.strictObject({
  kind: z.literal('split-panes'),
  version: z.literal(1),
  inspector: StoredPanel,
  bottom: StoredPanel,
});

/** Reads `settings.workspace.layout`. `null` (the schema's "default"), or anything unrecognised, gives the default layout. */
export function parseWorkspaceLayout(stored: unknown): WorkspaceLayout {
  const result = StoredLayoutV1.safeParse(stored);
  return result.success ? normaliseLayout(result.data) : DEFAULT_WORKSPACE_LAYOUT;
}

/** The JSON stored in `settings.workspace.layout` for `layout`. */
export function serialiseWorkspaceLayout(layout: WorkspaceLayout): {
  kind: 'split-panes';
  version: 1;
  inspector: { size: number; collapsed: boolean };
  bottom: { size: number; collapsed: boolean };
} {
  const { inspector, bottom } = normaliseLayout(layout);
  return { kind: 'split-panes', version: 1, inspector: { ...inspector }, bottom: { ...bottom } };
}

function normalisePanel(panel: PanelLayout, limits: PanelLimits): PanelLayout {
  const size = Number.isFinite(panel.size) ? Math.round(panel.size) : limits.min;
  return { size: Math.min(Math.max(size, limits.min), limits.max), collapsed: panel.collapsed === true };
}
