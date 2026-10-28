# @controls/feature-console

The in-game dev console (`type:feature`, plan F1.5). `ctl-dev-console` docks in the workspace's bottom panel (`[ctlBottomPanel]`) and takes `[available]` from `isConsoleAvailable(...)`, which it publishes as the `console.available` context key that gates `console.toggle` (backtick). Lines are parsed with the shared console grammar from `@controls/commands` and run through `Session.exec`; console-line files go through `runConsoleScript` from `@controls/scripting-api`. Nothing here changes the world directly.

- `DevConsole`: the interpreter and UI state (output, pending cheat); history lives in settings `console.history`.
- Framework-free helpers: `resolveConsoleLine`, `TabCompleter`, `consoleHelp`, `appendHistory`, `HistoryCursor`, `isConsoleAvailable`.
- `console-editor.ts`: the one-line CodeMirror 6 input. It is loaded with `import()`; don't export or import it statically.

Architecture: [dev console](../../../docs/architecture/console.md). Decisions: [ADR 0008](../../../docs/decisions/0008-console-and-scripts.md). Gotchas: [UI caveats](../../../docs/caveats/ui.md).

Tests: `pnpm nx test feature-console`; e2e in `apps/game-e2e/src/console.spec.ts` and `apps/desktop-e2e/src/smoke.spec.ts`.
