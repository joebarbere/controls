# ADR 0005: Docking workspace (custom split panes, not dockview)

**Status:** Accepted
**Date:** 2026-10-27 (Phase 1, F1.1)
**Sources:** plan §4.2, §4.9, §6 P1 (F1.1); [phase-1 plan](../../plans/phase-1-game-shell.md) F1.1 acceptance and risks; [ADR 0003](0003-licence-policy.md); [electron caveats](../caveats/electron.md) (CSP)

## Context

F1.1 needs a workspace with the 3D viewport, a side panel (inspector) and a bottom panel (the F1.5 console host). Panels must resize, and the layout must persist in settings. Later phases dock 2D editors next to the viewport (plan §4.9 _Editor_ mode: prints in P6, ladder in P10, ST/FBD in P11, HMI in P12).

The plan names two options: **dockview** (`dockview-angular` + `dockview-core`, MIT) or **custom split panes**. The criteria are support for Angular 22 zoneless, working under the strict CSP, keyboard operation, a serialisable layout, the licence and bundle size.

## Evidence

A throwaway spike (not merged) put dockview in the real app: the existing viewport in one panel, plus an inspector and a console panel. It was built with `pnpm build:desktop` and run in Electron through `apps/desktop-e2e` with `CONTROLS_E2E_HEADLESS=1`, under the real `app://` CSP.

- **Version.** `dockview-angular` 8.7.0 was published 2026-10-26 22:54 UTC, under pnpm 11's 24-hour minimum release age at evaluation time, and 8.7.1 the next day. The spike pinned **8.6.2** (2026-10-25) instead of adding a `minimumReleaseAgeExclude`. That is five releases in 17 days (8.5.0 to 8.7.1). Peer deps: `@angular/core`/`@angular/common` `>=21.0.6` and `rxjs >=7`, so Angular 22.2 resolves without overrides.
- **Licence.** MIT for `dockview-angular`, `dockview` and `dockview-core`. Acceptable under ADR 0003.
- **Angular 22 zoneless.** Works. The viewport reached `data-status="ready"` inside a dockview panel, and panels rendered and updated with no `zone.js`. The wrapper's own comments assume zone.js-driven ticks, but it uses `createComponent`/`ApplicationRef.attachView`, which also work zoneless.
- **CSP.** Works. A `securitypolicyviolation` listener recorded **zero** violations. dockview-core injects one `<style>` element and uses `adoptedStyleSheets`, which the current `style-src 'self' 'unsafe-inline'` allows. It has no `eval` or `new Function` (checked in the shipped ESM bundle).
- **Keyboard.** **Fails our bar.** Tabs are `role="tab"` in a `tablist` with keydown handling, but the **sashes (resize handles) are pointer-only**: a plain `div.dv-sash` with no `tabindex`, no `role="separator"`, no ARIA value and only a `pointerdown` listener. Tabbing through the spike reached the tabs and the panel content, never a sash or a tab's close button. Resizing from the keyboard would mean adding our own key handling over `api.getGroup(...).api.setSize()` around a third-party DOM we don't control.
- **Serialisable layout.** Strong. `api.toJSON()` gave 671 bytes of plain JSON for three panels, and `fromJSON()` restores it.
- **Bundle size.** Measured against the same production build of `apps/game`:

  | Build                                        | `main` JS raw | `main` JS gzip | Global CSS |
  | -------------------------------------------- | ------------- | -------------- | ---------- |
  | Before F1.1                                  | 1 589 694 B   | 397 919 B      | 204 B      |
  | + dockview spike (docking only)              | 1 978 583 B   | 491 358 B      | 141 158 B  |
  | Custom panes, **whole F1.1 shell** (shipped) | 1 647 442 B   | 416 149 B      | 3 426 B    |

  dockview adds ≈389 KB raw (≈93 KB gzip) of JS and 141 KB of CSS (all of its themes), and pushed the initial bundle over the 2 MB warning budget. The entire F1.1 shell (menu, dialogs, settings, HUD, notifications, workspace and splitters) adds ≈58 KB raw (≈18 KB gzip).

## Options

1. **dockview now.** Gives tabs, drag-and-drop docking, floating groups and popouts. Keyboard resizing would need our own layer over its DOM, it adds ≈0.5 MB, and the API churns quickly.
2. **Custom split panes now, behind `feature-workspace`'s own API.** A CSS grid with the WAI-ARIA _window splitter_ pattern (`role="separator"`, `aria-valuenow`/`min`/`max`, arrows, Home/End, Enter to collapse), using pointer capture for drags. The layout is a tiny JSON object. No tabs, drag-docking or floating panels.
3. **Custom now, and revisit dockview for the editor phases.** Option 2, with the evaluation repeated when tabbed editor docking is actually needed.

## Decision

**Option 3.** P1 uses custom split panes in `@controls/feature-workspace`:

- the `ctl-workspace` component, a fixed set of panels (viewport, `inspector` on the right, `bottom` under the viewport), with content slots for each;
- `ctl-splitter` in `@controls/ui` (presentational, keyboard-first);
- `WorkspaceLayout` (`{ inspector: { size, collapsed }, bottom: { size, collapsed } }`, integer px), stored in settings as `workspace.layout`, clamped by `normaliseLayout`;
- Reset layout, which becomes the `view.resetLayout` command in F1.2.

dockview is **not** added, so there is no `THIRD_PARTY_NOTICES.md` row. It stays in the `type:domain` banned-imports list in case it's chosen later.

**Revisit** when tabbed or drag-docked editors are needed (expected P6 prints or P10 ladder): re-run this spike against the then-current dockview, specifically checking keyboard-operable sashes and tab close buttons, release cadence and size. A switch must keep the `ctl-workspace` content slots and migrate `workspace.layout` in the settings schema.

## Consequences

- Every workspace action is keyboard-operable today. A Playwright test (`apps/game-e2e/src/keyboard-shell.spec.ts`) resizes, collapses and resets panels with the keyboard only.
- We own a small amount of layout code, and multi-panel tabbing, drag-to-dock and floating panels don't exist. Adding a fourth fixed panel is cheap; a general docking tree isn't, and that is the trigger to revisit.
- The layout format is ours and minimal. The settings schema keeps `workspace.layout` opaque (`null` = default); `feature-workspace` stores `{ kind: 'split-panes', version: 1, inspector, bottom }` there and parses it with Zod, falling back to the default layout for anything it doesn't recognise. A future dockview layout can use a different `kind` and migrate in `feature-workspace`, without a settings schema change.
- No new runtime dependency, nothing new to keep under the CSP, and no exposure to dockview's release cadence during P1.
