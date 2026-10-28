# @controls/feature-palette

The command palette (`type:feature`, plan F1.3), one of the four surfaces over the one command registry (spec §4.6). `ctl-command-palette` opens on the `palette.open` command (Mod+K or Mod+Shift+P, a global binding through `KeybindingService`), fuzzy-searches every registered command by title, category and id, lists commands whose `when` is false as unavailable with the reason, puts recent commands (settings `palette.recents`) first, and runs the choice with `Session.exec`.

Commands with arguments get a form generated from their Zod `args` (`buildArgForm`: `z.toJSONSchema` plus `.meta()` hints such as `title`, `description` and `x-controls-ref: entity`). Validation is the command's own schema (`validateArgs`), shown inline. Cheat commands ask for confirmation before they mark the world as assisted.

Architecture: [UI shell](../../../docs/architecture/ui-shell.md#command-palette-f13). Tests: `pnpm nx test feature-palette`.
