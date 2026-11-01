# UI shell

> **Status (F1.8b part 3):** the shell, workspace, settings screen, HUD, notifications and theming exist. The command registry and `feature-session` landed in F1.2 ([commands](commands.md)), the keybinding service, the Key bindings dialog and the tool belt in F1.4, the command palette (`feature-palette`) in F1.3, the dev console in F1.5 ([dev console](console.md)), and saving and loading (`feature-saves`: Save game, Load game, Continue, autosave) in F1.8b ([below](#saving-and-loading-f18b)). Settings persist on both platforms (below). Reset layout runs the `view.resetLayout` command, and the HUD's assisted badge reads the world's `assisted` flag from the session. Gotchas: [UI caveats](../caveats/ui.md). Docking choice: [ADR 0005](../decisions/0005-docking-workspace.md).

## Libraries

```mermaid
flowchart LR
    classDef done fill:#dff5e1,stroke:#2e7d32;
    classDef later fill:#f4f4f4,stroke:#999,stroke-dasharray: 4 3;

    GAME["apps/game<br/>App: assembles features,<br/>injects PLATFORM"]:::done
    SHELL["feature-shell<br/>MainMenu · AboutDialog · Hud<br/>Notifications · ShellState"]:::done
    WS["feature-workspace<br/>Workspace · Viewport<br/>WorkspaceLayout"]:::done
    SET["feature-settings<br/>SettingsDialog · SettingsForm<br/>SettingsStore · SETTINGS_SERVICE"]:::done
    UI["ui (type:ui)<br/>tokens · ctlButton · ctl-dialog<br/>ctlFocusTrap · ctl-splitter · ctl-toast-stack"]:::done
    PAPI["platform-api<br/>Platform (settings, canQuit, quit)<br/>SettingsService"]:::done
    REND["renderer"]:::done
    SESS["feature-session<br/>Session · KeybindingService · ToolBelt"]:::done
    PAL["feature-palette<br/>CommandPalette · PaletteArgForm<br/>buildArgForm · paletteItems · fuzzy"]:::done
    CON["feature-console (F1.5)<br/>DevConsoleComponent · DevConsole<br/>CodeMirror 6 input (lazy)"]:::done
    SAV["feature-saves (F1.8b)<br/>SaveGames · LoadGameDialog · SaveGameDialog<br/>SAVE_FILES · SAVE_DIALOGS · SaveThumbnails"]:::done

    GAME --> SHELL & WS & SET & UI & PAPI & SESS & PAL
    SET --> SHELL & UI & PAPI & SESS
    SHELL --> UI
    WS --> UI & REND & SESS
    PAL --> UI & SESS & SET
    CON --> SESS & SET & UI
    GAME --> CON & SAV
    SAV --> SESS & SET & SHELL & UI & PAPI
```

`ui` is presentational: it holds no services, state or commands. Features may use each other (`feature-settings` uses `NotificationService` from `feature-shell`), but none of them imports a concrete platform. The app provides `PLATFORM` (Electron bridge or web harness) and, from it, `SETTINGS_SERVICE`, `APP_LIFECYCLE`, `SAVE_FILES` and `SAVE_DIALOGS` (`app.config.ts`).

## Screens and focus

The workspace is always mounted. Behind the main menu it shows only the viewport (`[chrome]="false"`) and is `inert`, so the menu sits over a live 3D backdrop.

```mermaid
stateDiagram-v2
    [*] --> Menu: boot (focus: first menu item)
    Menu --> NewGameDialog: New sandbox (focus: Seed, a fresh seed)
    NewGameDialog --> Workspace: Enter / Start, valid seed → Session.newSandbox (focus: viewport canvas)
    NewGameDialog --> Menu: Escape / Cancel (focus returns to New sandbox)
    Menu --> Workspace: Resume (focus: viewport canvas)
    Menu --> Workspace: Continue resumes the last-played save, else the newest that loads (focus: viewport canvas)
    Workspace --> Menu: Menu button, or Escape outside the canvas (focus: Resume; autosave if changed)
    Menu --> Workspace: Escape (session running)
    state Menu {
        [*] --> Items
        Items --> SaveGameDialog: Save game (game running)
        SaveGameDialog --> Items: Enter / Save, or Escape / Cancel (focus returns to Save game)
        Items --> LoadGameDialog: Load (file.load)
        LoadGameDialog --> Items: Escape / Cancel, or a save that doesn't load (focus returns to Load)
        Items --> SettingsDialog: Settings
        SettingsDialog --> Items: Back / Escape (focus returns to Settings)
        SettingsDialog --> KeyBindingsDialog: Key bindings…
        KeyBindingsDialog --> SettingsDialog: Back / Escape (focus returns to Key bindings…)
        Items --> AboutDialog: About
        AboutDialog --> Items: Close / Escape (focus returns to About)
    }
    Workspace --> Palette: Ctrl+K / Ctrl+Shift+P (palette.open; also from the menu or a dialog)
    Palette --> Workspace: Escape or a command runs (focus returns to the opener)
```

- **Dialogs** are native `<dialog>` elements opened with `showModal()` (`ctl-dialog`). The page behind them is inert, focus moves inside and is trapped, Escape closes, and focus returns to the opener.
- **Escape** is handled innermost-first: a key capture in the Key bindings dialog, a dialog or the focused viewport canvas (cancel a move, cancel placement, clear the selection, in that order; F1.7) consumes it; otherwise `App.onEscape` toggles between the menu and the workspace. Escape is the shell's fixed "back" key, reserved by the keybinding service, so no command can take it.
- **New sandbox** (F1.9) opens the new-game dialog: the level (Workshop), a seed field with a fresh seed (`SEED_SOURCE`, `crypto.getRandomValues`) and a New seed button. A typed seed must be a whole number from 0 to 4294967295 (`parseSeed`); an invalid one is refused inline (`aria-invalid`, an alert) and the dialog stays open. Start runs `Session.newSandbox({ seed, difficulty: settings.gameplay.defaultDifficulty })`, which loads the workshop level with a fresh history and replay log; the viewport resets to its starting view (`Session.generation`).
- **Main menu** items are plain buttons in a `<nav>`: Resume and Save game (while a game runs), New sandbox, Continue, Load, Settings, About and Quit. Tab, Up/Down, Home and End move between them. Continue is `aria-disabled`, described by "No saved games yet.", until the save directory lists a save; it is one element either way, so focus on it survives the list arriving. Quit is hidden where `Platform.canQuit` is false (the web harness).

## Saving and loading (F1.8b)

`SaveGames` (`feature-saves`) is the one place that writes and loads games; `App` injects it at start-up. It sits on `Session` (the game), `loadGame` (`@controls/scripting-api`: bytes to a validated game) and the platform's save I/O (`SAVE_FILES` / `SAVE_DIALOGS`, provided from `Platform.files` / `.dialogs`; [ADR 0009](../decisions/0009-save-io-boundary.md)). The `.ctrl` format and loading rules are on [world and saves](world-and-saves.md#saving-and-loading-in-the-game-f18b-part-3).

```mermaid
flowchart LR
    subgraph surfaces["four surfaces + the menu"]
        PAL2["palette"] & KEYS["Mod+S · Mod+Shift+S<br/>Mod+O · Mod+L"] & CONS["console"] & MENU["menu: Save game,<br/>Continue, Load"]
    end
    surfaces -->|"exec('file.*') (unlogged)"| SESS2["Session.onCommand"]
    MENU -->|"Continue"| SG
    SESS2 --> SG["SaveGames"]
    SG -->|"save: Session.saver() → .ctrl bytes<br/>(+ thumbnail from the viewport)"| IO["Platform.files.write<br/>manual · autosave · Save As handle"]
    SG -->|"load: files.read / dialogs.open → loadGame"| CHECK{"loads?"}
    CHECK -- no --> NOTE["error notification<br/>(from the code, never the file)"]
    CHECK -- yes --> ADOPT["autosave the old game if changed,<br/>Session.adopt(game)"]
    ADOPT --> ENTER["onLoaded → App.enterGame:<br/>clear tool belt, workspace, focus canvas"]
```

- **Commands.** `file.save` (Mod+S; under the game's save name, or the Save game dialog if it has none), `file.saveAs` (Mod+Shift+S; a native Save As, a download in the web harness), `file.open` (Mod+O; a native Open, an upload in the web harness) and `file.load` (Mod+L; the Load game dialog). All four are `logged: false`, `file.save` and `file.saveAs` need `session.active`. Why they are commands but unlogged: [ADR 0006](../decisions/0006-command-system.md#saving-and-loading-f18b).
- **Save game dialog:** one field, opening on the game's save name or `Sandbox <seed>`, selected so typing replaces it. Names follow `SaveNameSchema` and are explained inline; a name another save already has (compared without case) asks first (the button becomes Replace). The save runs after the dialog closes.
- **Load game dialog:** the save directory, newest first, one button per save named by the save and described by kind, time and size; Up/Down, Home and End move between them. Open file… opens the picker inside the click and keeps the dialog open if the player cancels. A chosen save loads after the dialog has closed and returned focus. No thumbnails in the list yet (reading one means reading the whole save).
- **Continue** lists again and tries the save of the game the player was last in first (`settings.saves.lastPlayed`), then the rest newest first (manual and autosave alike); saves that don't load, or a last-played save that has gone, are skipped with one warning naming them.
- **Autosave** writes the next of `autosave.slotCount` slots, only for a game with unsaved changes (its world differs from the last saved, loaded or starting one, so an untouched New sandbox never takes a slot): every `autosave.intervalSeconds` while a game runs, when the player returns to the menu, before a load replaces the game, and before quit (a flush registered with `APP_LIFECYCLE`, without a thumbnail to stay inside the 2 s budget). Settings → Saves edits the three autosave settings.
- **Errors** become notifications written from the `CtrlError` kind or `SaveIoError` code (`messages.ts`); nothing from the file or a host path is shown. A save whose replay log had to restart loads with a warning (`REPLAY_MISMATCH_POLICY`, `notify` by default, `refuse` to refuse such saves).
- **Thumbnails:** `SaveThumbnails` calls the viewport's `captureThumbnail()` (a 320 × 180 PNG, rendered and copied in one task); a failed capture or a non-PNG is dropped and the save goes ahead without one.

## Workspace layout

```mermaid
flowchart TB
    subgraph ws["ctl-workspace (CSS grid)"]
        direction TB
        TB["toolbar: [ctlWorkspaceToolbar] · Inspector · Console · Reset layout"]
        subgraph row[" "]
            direction LR
            VP["3D viewport (region landmark)<br/>ctl-viewport canvas (the focus target)<br/>+ [ctlViewportOverlay] (HUD, fed by viewState)"]
            VS["ctl-splitter<br/>vertical"]
            INS["Inspector<br/>[ctlInspector], or ctl-netlist-inspector (F2.6)"]
        end
        HS["ctl-splitter horizontal"]
        BOT["Console panel<br/>[ctlBottomPanel]: ctl-dev-console (F1.5)"]
    end
    TB --> row --> HS --> BOT
```

- `WorkspaceLayout` is plain JSON: `{ inspector: { size, collapsed }, bottom: { size, collapsed } }`, with integer CSS pixels clamped by `normaliseLayout` (inspector 200–640, bottom 96–560, and at most 60 % of the window in CSS).
- It is two-way bound to `settings.workspace.layout`, so it persists once F1.8a wires the storage.
- Splitters follow the WAI-ARIA window-splitter pattern: arrows resize (Shift for big steps), Home/End jump to the limits, and Enter collapses or restores. Pointer drags use pointer capture.
- **`console.toggle`** (backtick) is applied by the workspace too: it expands the bottom panel and focuses its `[data-autofocus]` element, or collapses it and restores focus when focus is already inside. See [dev console](console.md).
- **`view.netlistInspector`** (F2.6, `when: console.available`, unlogged UI chrome, no default key) shows the netlist inspector in the side panel the same way: it expands the panel if collapsed and focuses the tree, or, with focus already inside, closes it (the projected `[ctlInspector]` content comes back) and restores focus. See [the netlist inspector](#the-netlist-inspector-f26).
- **Reset layout** runs the `view.resetLayout` view command through `Session.exec`. The workspace applies it when the command reports back (`Session.onCommand`), so any surface that runs the command resets the layout. It is logged and never changes the world hash.

## The netlist inspector (F2.6)

`ctl-netlist-inspector` (`feature-workspace`, `netlist/`) lists the sim's islands, each island's nodes (with their member terminals) and branches, with live |V| and |I|. It is a view: it reads the SimHost snapshot and never the world.

```mermaid
flowchart LR
    SH["SimHost.select<br/>10 Hz, trailing sample,<br/>starts from the latest snapshot"] --> NS["netlistSampler<br/>NetlistReadout.of(descriptor).read<br/>→ display strings"]
    NS -->|"set only if a string changed<br/>(sameNetlistValues)"| V["values signal"]
    V --> T["buildNetlistTree(descriptor)<br/>(computed: per generation)"]
    T --> UI["role=tree, flat treeitems<br/>aria-level / setsize / posinset"]
    UI -->|"selected node's members"| HL["Workspace effect →<br/>Viewport.highlightTerminals"]
```

- **Structure** comes from the snapshot's topology descriptor, named as `netlist.dump` (`formatNetlist`) names it: `Node 4: 3:a`, `Branch 1 e3.filament: 3 -> 4`. Rows are keyed by identity (a node by its first member, a branch by its element), so expansion and the selection survive a new generation.
- **Values** go through `NetlistReadout`, the overlays' readout: an island shows its `islandStatus` and nominal band (`solved · band dc12`); a node of an unsolved or unreferenced island and a branch of an unsolved island read `no reading`, never 0 V or 0 A. Quantities have three significant figures and an SI prefix (`formatQuantity`); a DC branch adds its direction against its ends (`a -> b`).
- **Rate:** `SimHost.select` at `PANEL_SAMPLE_HZ` (10 Hz); a sample whose strings and tick are unchanged is not set, so the panel redraws at most ten times a second and not at all while paused. Rows are tracked by key, so a new sample only rewrites text.
- **Keyboard:** one tab stop (roving `tabindex`); Up and Down, Home and End, Right expands or enters, Left collapses or goes to the parent, Enter and Space toggle. The focused row is the selection (`aria-selected`). Selecting a node rings its terminals in 3D (`ViewportRenderer.highlightTerminals`, view state only); closing the inspector clears it.
- **Trace** (phase 2 acceptance): T on a branch row (`aria-keyshortcuts="T"`), or the "Trace selected branch" button below the tree, starts a live trace of that branch's current through `SimHost.watch` (one at a time; T again, or "Stop trace", stops it; closing the inspector stops it). `ctl-trace-plot` draws it as an SVG line against sim time with a value axis from 0 to the peak; a gap is no reading, never 0 A. The plot is `role="img"` with a text alternative, also its caption ("Peak 6.16 A at 0.000 s; now 432 mA at 1.500 s."). It redraws when the trace's `version` changes: at most 10 Hz, or 1 Hz under `prefers-reduced-motion` (`REDUCED_MOTION_TRACE_HZ`), and nothing animates between redraws. The button sits outside the tree, so no treeitem holds an interactive child.

## Keybindings and the tool belt

```mermaid
sequenceDiagram
    participant K as Keyboard
    participant C as Viewport canvas (renderer input actions)
    participant D as document: KeybindingService
    participant S as Session
    participant T as ToolBelt / HUD
    K->>C: keydown (canvas focused)
    C->>C: input action bound and acted? preventDefault
    C-->>D: bubbles (unless handled)
    D->>D: chordFromEvent → keymap.resolve(chord, contextKeys, restricted?)
    D->>S: exec('toolbelt.select', {slot: 2})
    S-->>T: onCommand → active slot, toolbelt.slot context key, HUD "2: Crate"
```

- `KeybindingService` (`feature-session`) owns the one document `keydown` listener for commands. It builds its keymap from the registry (`defaultBindingDecls`) and the player's overrides, which `apps/game` stores in settings with `provideKeybindingOverridesFromSettings()` (`feature-settings`). Without that provider the overrides live in memory.
- The **viewport** pushes `KeybindingService.inputBindings()` into the renderer, names the current keys in the canvas's accessible name, and sets the `viewport.focused` context key while the canvas has focus.
- **Settings → Key bindings…** opens a sibling dialog (`ctl-keybindings-dialog`) with one table per category. **Change** captures the next key press (Escape cancels, Tab leaves); **Unbind**, **Reset** and **Reset all bindings** act at once. Conflicts and ignored stored bindings are shown in the row and wired to the Change button with `aria-describedby`; a polite status region announces each change. Inactive buttons are `aria-disabled`, so focus never falls out of the dialog.
- The **HUD** shows the active tool-belt slot and the prop it holds (settings `toolBelt.slots`).
- **Time controls** (F2.3b, ADR 0011 §13): `ctl-sim-controls` (`feature-session`) sits under the HUD in the viewport overlay (both projected through one `ng-container ctlViewportOverlay`). It shows `SimHost.simTick` (the latest snapshot's tick, never the bus world's), the requested speed as one native radio group that runs `sim.setSpeed`, the achieved speed while running, "Falling behind" and "Catching up", and a polite live region that announces only transitions. The keys are bindings on the sim commands: `P` is `sim.setSpeed.pause` (`!sim.paused`) and `sim.resume` (`sim.paused`), two disjoint `when`s; `Shift+1–3` are `sim.setSpeed.x1/x10/x60`; `Period` and `Shift+Period` are `sim.step.short` (10 ticks) and `sim.step.long` (1 000). All need `session.active && sim.status != 'crashed'`.
- The **viewport** places the active slot's prop (F1.7): it arms the renderer's ghost with it, runs one `entity.place` per click or Enter, and calls `ToolBelt.clear()` (UI state, not a command) when Escape cancels placement. It also applies `view.mode` / `view.focus` and publishes the `mode` and `selection.*` context keys that the V, F and Delete bindings use ([rendering](rendering.md#placement-and-moves)).

## Command palette (F1.3)

`ctl-command-palette` (`feature-palette`, mounted once by `App`) is one of the four surfaces over the registry. `palette.open` is a view command with the default chords `Mod+K` and `Mod+Shift+P` and `globalKeybinding: true`, so it fires from a text field or an open dialog too; the palette opens when the session reports it (`Session.onCommand`). It is `logged: false` UI chrome: it runs through the registry and fires `onCommand`, but never enters the replay log. Closing isn't a command.

```mermaid
stateDiagram-v2
    [*] --> List: palette.open (focus: search combobox)
    List --> List: type (fuzzy filter) · Up/Down (active option)
    List --> Form: Enter on a command with arguments
    List --> Confirm: Enter on a cheat (world not yet assisted)
    List --> Closed: Enter on an argument-less command · Escape
    Form --> Form: Enter with invalid values (inline Zod errors, focus first invalid)
    Form --> List: Escape / Back (query kept)
    Form --> Confirm: Enter, valid, cheat
    Form --> Closed: Enter, valid
    Confirm --> Closed: Run and mark assisted
    Confirm --> Form: Escape / Cancel (List if no arguments)
    Closed --> Form: command refused (reopens with the message)
    Closed --> [*]: focus restored to the opener
```

- **List.** An ARIA combobox (`role="combobox"`, `aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`) over a `listbox` of every registered command except `palette.open`. Focus stays in the search field; Up/Down wrap. `paletteItems` ranks with a small fuzzy matcher (`fuzzyMatch`: ordered subsequence, bonuses for word starts, camelCase humps and runs, a charge for gaps) over title, id and category; every query word must match. Commands whose `when` is false stay listed after the enabled ones, `aria-disabled`, with the reason; Enter on one announces the reason in a status region. Recent commands (settings `palette.recents`, at most 20, most recent first) lead an empty query and get a score boost otherwise. Each option shows the command's current keys.
- **Form.** `buildArgForm(def.args)` runs `z.toJSONSchema(args, { io: 'input' })` and turns the JSON Schema into fields: string, integer/number (bounds become a hint such as "Whole number, 1 to 9"), boolean (a checkbox, or Yes/No/Not set when optional without a default), enum and literal (a `<select>`), nested object (a `fieldset`) and optional object ("Include …"). Defaults, including a parent object's default, prefill the fields. `.meta()` hints: `title` (label), `description` (help text) and `x-controls-ref: entity` (an entity id: prefilled from the `selection.entityId` context key and suggested from the world's entities). Labels otherwise come from the key (`positionMm` → "Position (mm)").
- **Validation** is the command's own schema: `validateArgs` maps each Zod issue to the field at its path (a missing value reads "Required"), shown inline with `aria-invalid` and `aria-describedby`. Errors appear after the first Run and then update as the player types; focus moves to the first invalid field only on Run.
- **Running.** The palette closes first and runs `Session.exec` once the dialog has restored focus, so a command that moves focus keeps it. If the command is refused, the palette reopens on it with the message. A success is added to the recents.
- **Cheats** (`cheat: true`) ask "Run a cheat?" once per world: confirming runs the command, and the bus sets the world's `assisted` flag, which the HUD badge shows and the save keeps. Once the world is assisted there is nothing left to lose, so the palette runs cheats without asking.
- **Keyboard.** List: type, Up/Down, Enter, Escape. Form: Up/Down or Tab between fields (a `<select>` keeps Up/Down for its options), Enter runs (Enter also toggles a checkbox), Escape goes back. Confirmation: arrows switch buttons, Enter, Escape.
- A spec builds and renders a form for every registered command, so a command whose args the palette can't express fails at registration time.

```mermaid
sequenceDiagram
    participant P as Player
    participant K as KeybindingService
    participant S as Session
    participant CP as CommandPalette
    participant D as ctl-dialog
    P->>K: Ctrl+K
    K->>S: exec('palette.open')
    S-->>CP: onCommand → show()
    CP->>D: open (focus: search)
    P->>CP: "place", Enter, fill form, Enter
    CP->>CP: validateArgs (def.args.safeParse)
    CP->>D: close
    D-->>CP: closed (focus restored to the opener)
    CP->>S: exec('entity.place', args)
    S-->>CP: ok → settings palette.recents
```

## Settings, theme and notifications

```mermaid
flowchart LR
    FORM["SettingsForm<br/>(native labelled controls)"] -->|"update(section, patch)"| STORE["SettingsStore<br/>signal&lt;Settings&gt;"]
    WS["Workspace layout"] -->|"serialiseWorkspaceLayout"| STORE
    STORE -->|"debounced 300 ms, after load"| SVC["SETTINGS_SERVICE<br/>= Platform.settings"]
    SVC -->|"load(): settings + fallbackReason"| STORE
    STORE -->|"corrupt / unknown version"| NOTE["NotificationService"]
    STORE -->|"effect: data-theme, data-motion"| HTML["&lt;html&gt;"]
    HTML --> TOK["ui tokens: light-dark(), --ctl-duration"]
    NOTE --> TOAST["ctl-toast-stack<br/>role=status (polite) · role=alert (assertive)"]
```

- **Document:** `Settings` from `@controls/save-format` (`settingsVersion` 2 since the Continue fix: `saves.lastPlayed`). The store edits it section by section; edits made before the first load finishes are replayed on top of the loaded document, and nothing is saved until the load has finished.
- **Theme:** tokens are `light-dark()` pairs under `color-scheme: light dark`, so they follow `prefers-color-scheme`. A settings override pins `color-scheme` through `data-theme`.
- **Reduced motion:** `display.reducedMotion` is `system` (follow `prefers-reduced-motion`), `reduce` (`data-motion="reduce"`) or `full` (`data-motion="full"`, ignores the OS preference).

### Persistence

```mermaid
sequenceDiagram
    participant UI as SettingsStore (renderer)
    participant PE as ElectronSettingsService
    participant PRE as preload bridge
    participant MAIN as main: ipc-handlers
    participant FILE as SettingsFile (userData/settings.json)
    UI->>PE: load()
    PE->>PRE: getSettings()
    PRE->>MAIN: invoke settings:get
    MAIN->>MAIN: senderFrame is app://
    MAIN->>FILE: read(): stat, readFile, loadSettings
    FILE-->>MAIN: { settings, fallbackReason }
    MAIN-->>PE: response
    PE->>PE: re-validate (SettingsGetResponseSchema, loadSettings)
    PE-->>UI: { settings, fallbackReason }
    UI->>PE: save(settings)
    PE->>PRE: setSettings(settings)
    PRE->>MAIN: invoke settings:set
    MAIN->>MAIN: origin, ≤ 1 MiB, current-version Settings
    MAIN->>FILE: write: temp file, fsync, rename
```

- **Web harness:** `WebSettingsService` stores the same JSON in `localStorage` (`controls.settings`), with every access in try/catch. Both platforms parse stored text with `parseStoredSettings` from `@controls/ipc-contract`, so fallback behaviour is identical.
- **Quit:** `Platform.quit()` → `app:quit` → `app.quit()` on desktop (including macOS). The web harness has no Quit.

### Flush before quit

Buffered writes (the settings debounce and, since F1.8b, autosave) must reach disk before the window closes or the app quits; Angular's `DestroyRef` doesn't run then. Features register a flush with `Platform.lifecycle.onBeforeQuit` (Angular: `APP_LIFECYCLE`), and main holds the close or quit until the renderer acknowledges.

```mermaid
sequenceDiagram
    participant P as Player
    participant MAIN as main: QuitGuard
    participant FC as FlushCoordinator
    participant PRE as preload bridge
    participant LC as ElectronAppLifecycle
    participant STORE as SettingsStore.flush
    P->>MAIN: Quit / Cmd+Q / close window
    MAIN->>MAIN: before-quit or close: preventDefault (once)
    MAIN->>FC: request(webContents)
    FC->>PRE: send app:flush-request { requestId }
    PRE->>LC: onFlushRequest(payload only)
    LC->>LC: FlushRequestSchema
    LC->>STORE: run every registered flush
    STORE-->>LC: pending + in-flight saves settled
    LC->>PRE: ackFlush({ requestId, ok })
    PRE->>FC: invoke app:flush-ack
    FC->>FC: app:// sender, FlushAckSchema, id pending for this WebContents
    FC-->>MAIN: flushed | failed (or timeout after 2 s, or gone)
    MAIN->>MAIN: close / app.quit() again (passes)
```

| Channel             | Direction       | Payload (`@controls/ipc-contract`)                   | Notes                                                                                  |
| ------------------- | --------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `app:flush-request` | main → renderer | `FlushRequestSchema`: `{ requestId: int > 0 }`       | `webContents.send`; the preload forwards the payload only, never the IPC event.        |
| `app:flush-ack`     | renderer → main | `FlushAckSchema`: `{ requestId: int > 0, ok: bool }` | `invoke`/`handle`; refused unless the sender is `app://` and the id is pending for it. |

- **Every close path:** `before-quit` (menu Quit through `app:quit`, Cmd+Q, the Dock, `window-all-closed`) flushes every open window; a window's `close` (title-bar button) flushes that window. A close during a quit shares its flush.
- **Never blocks quitting:** `FLUSH_BEFORE_QUIT_TIMEOUT_MS` (2 s) bounds the wait, a destroyed or crashed renderer isn't waited for, and a failed flush still closes (the store has already shown an error).
- **Web harness:** `WebAppLifecycle` runs the flushes on `pagehide`. The browser doesn't wait for promises, so each flush is called synchronously (`runFlushes`), which is enough for the `localStorage` write.
- **Notifications:** info and success auto-dismiss after 8 s; warnings and errors stay until dismissed. Expiry pauses while the pointer or keyboard focus is in the stack. Each toast has a Dismiss button, Escape dismisses the focused toast, and focus then moves to the next toast or back to where it came from.

## Related

- [ADR 0005 Docking workspace](../decisions/0005-docking-workspace.md) · [UI caveats](../caveats/ui.md) · [Architecture overview](overview.md)
- Plan §4.6 (one registry, four surfaces), §4.9 (modes) and the [phase-1 plan](../../plans/phase-1-game-shell.md) F1.1–F1.5 and F1.8b.
- [Commands](commands.md) (registry, `when`, view commands) · [Scripting](scripting.md) (the palette scenario's hash against `sim run`).
