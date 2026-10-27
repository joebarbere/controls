# @controls/feature-session

The Angular adapter over the scripting API's `Game` (`type:feature`, plan F1.2, F1.6), the same object `sim-cli` scripts drive. `Session` holds the world as a signal (`world`, `hash`, `entries`, `canUndo`, `canRedo`, `contextKeys`) and is the UI's only way to change it: `exec(id, args)` through the one registry from `@controls/world-model`. View commands take effect through `onCommand(id, handler)`; `setContext(key, value)` feeds `when`. With `?e2e=1` it exposes `window.__controlsSession` for Playwright. Semantics: [ADR 0006](../../../docs/decisions/0006-command-system.md).

Tests: `pnpm nx test feature-session`.
