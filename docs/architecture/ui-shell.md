# UI shell

> **Status (F1.1):** the shell, workspace, settings screen, HUD, notifications and theming exist. The command registry (F1.2), keybinding service (F1.4), palette (F1.3), console (F1.5) and `feature-session` are still to come; their hooks are marked `TODO(F1.x)` in the code. Settings persistence lands with F1.8a. Gotchas: [UI caveats](../caveats/ui.md). Docking choice: [ADR 0005](../decisions/0005-docking-workspace.md).

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
    PAPI["platform-api<br/>Platform (canQuit, quit)<br/>SettingsService · SettingsDocument"]:::done
    REND["renderer"]:::done
    SESS["feature-session (F1.2)<br/>world signal, exec, context keys"]:::later
    PAL["feature-palette (F1.3)"]:::later
    CON["feature-console (F1.5)"]:::later

    GAME --> SHELL & WS & SET & UI & PAPI
    SET --> SHELL & UI & PAPI
    SHELL --> UI
    WS --> UI & REND
    PAL & CON -.-> SESS
    SESS -.-> WS
```

`ui` is presentational: it holds no services, state or commands. Features may use each other (`feature-settings` uses `NotificationService` from `feature-shell`), but none of them imports a concrete platform. The app provides `PLATFORM` (Electron bridge or web harness) and will provide the real `SETTINGS_SERVICE`.

## Screens and focus

The workspace is always mounted. Behind the main menu it shows only the viewport (`[chrome]="false"`) and is `inert`, so the menu sits over a live 3D backdrop.

```mermaid
stateDiagram-v2
    [*] --> Menu: boot (focus: first menu item)
    Menu --> Workspace: New sandbox / Resume (focus: 3D viewport)
    Workspace --> Menu: Escape or Menu button (focus: Resume)
    Menu --> Workspace: Escape (session running)
    state Menu {
        [*] --> Items
        Items --> SettingsDialog: Settings
        SettingsDialog --> Items: Back / Escape (focus returns to Settings)
        Items --> AboutDialog: About
        AboutDialog --> Items: Close / Escape (focus returns to About)
    }
```

- **Dialogs** are native `<dialog>` elements opened with `showModal()` (`ctl-dialog`). The page behind them is inert, focus moves inside and is trapped, Escape closes, and focus returns to the opener.
- **Escape** is handled innermost-first: a dialog consumes it, then `App.onEscape` toggles between the menu and the workspace. F1.4 moves this into the keybinding service.
- **Main menu** items are plain buttons in a `<nav>`. Tab, Up/Down, Home and End move between them. Continue and Load are `aria-disabled` with a reason until F1.8b, and Quit is hidden where `Platform.canQuit` is false (the web harness).

## Workspace layout

```mermaid
flowchart TB
    subgraph ws["ctl-workspace (CSS grid)"]
        direction TB
        TB["toolbar: [ctlWorkspaceToolbar] · Inspector · Console · Reset layout"]
        subgraph row[" "]
            direction LR
            VP["3D viewport (region, tabindex 0)<br/>ctl-viewport + [ctlViewportOverlay] (HUD)"]
            VS["ctl-splitter<br/>vertical"]
            INS["Inspector<br/>[ctlInspector]"]
        end
        HS["ctl-splitter horizontal"]
        BOT["Console panel<br/>[ctlBottomPanel] (F1.5)"]
    end
    TB --> row --> HS --> BOT
```

- `WorkspaceLayout` is plain JSON: `{ inspector: { size, collapsed }, bottom: { size, collapsed } }`, with integer CSS pixels clamped by `normaliseLayout` (inspector 200–640, bottom 96–560, and at most 60 % of the window in CSS).
- It is two-way bound to `settings.workspace.layout`, so it persists once F1.8a wires the storage.
- Splitters follow the WAI-ARIA window-splitter pattern: arrows resize (Shift for big steps), Home/End jump to the limits, and Enter collapses or restores. Pointer drags use pointer capture.
- **Reset layout** becomes the `view.resetLayout` command in F1.2.

## Settings, theme and notifications

```mermaid
flowchart LR
    FORM["SettingsForm<br/>(native labelled controls)"] -->|"update(section, patch)"| STORE["SettingsStore<br/>signal&lt;SettingsDocument&gt;"]
    STORE -->|"debounced 300 ms"| SVC["SETTINGS_SERVICE<br/>MemorySettingsService today<br/>Electron IPC / web storage (F1.8a)"]
    SVC -->|"load(): settings + fallbackReason"| STORE
    STORE -->|"corrupt / unknown version"| NOTE["NotificationService"]
    STORE -->|"effect: data-theme, data-motion"| HTML["&lt;html&gt;"]
    HTML --> TOK["ui tokens: light-dark(), --ctl-duration"]
    NOTE --> TOAST["ctl-toast-stack<br/>role=status (polite) · role=alert (assertive)"]
```

- **Theme:** tokens are `light-dark()` pairs under `color-scheme: light dark`, so they follow `prefers-color-scheme`. A settings override pins `color-scheme` through `data-theme`.
- **Reduced motion:** applies when `prefers-reduced-motion: reduce` is set or `data-motion="reduce"` is on `<html>`.
- **Notifications:** info and success auto-dismiss after 8 s; warnings and errors stay until dismissed. Expiry pauses while the pointer or keyboard focus is in the stack. Each toast has a Dismiss button, Escape dismisses the focused toast, and focus then moves to the next toast or back to where it came from.

## Related

- [ADR 0005 Docking workspace](../decisions/0005-docking-workspace.md) · [UI caveats](../caveats/ui.md) · [Architecture overview](overview.md)
- Plan §4.6 (one registry, four surfaces), §4.9 (modes) and the [phase-1 plan](../../plans/phase-1-game-shell.md) F1.1–F1.5.
