# @controls/ui

Presentational Angular components and design tokens (`type:ui`). No services, state or commands.

- `src/styles/` – design tokens (`light-dark()` themes, reduced motion) and shared element styles; included once by `apps/game/src/styles.scss`.
- `ctlButton` – token-styled native buttons.
- `ctl-dialog` – modal on native `<dialog>`: initial focus, Escape, focus trap, focus restoration.
- `ctlFocusTrap`, `focusableElements()`, `restoreFocus()` – focus utilities (a radio group is one tab stop).
- `ctl-splitter` – WAI-ARIA window splitter (keyboard and pointer).
- `ctl-toast-stack` – notifications in polite/assertive live regions, keyboard-dismissable.

Tests: `pnpm nx test ui`. See [UI caveats](../../docs/caveats/ui.md).
