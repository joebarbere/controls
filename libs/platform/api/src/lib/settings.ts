/**
 * The player's settings document.
 *
 * TODO(F1.8a): placeholder. Replace with `SettingsV1` (inferred from the Zod schema in
 * `@controls/save-format`, which owns `settingsVersion` and `defaultSettings()`). Until then this
 * interface only describes what the F1.1 settings screen edits; nothing validates or persists it.
 * Every value is plain JSON (integers where possible) so the swap to the real schema is mechanical.
 */
export interface SettingsDocument {
  readonly graphics: {
    /** Renderer backend preference. `auto` = WebGPU with the WebGL2 fallback. Applies on restart. */
    readonly backend: 'auto' | 'webgl2';
    /** Upper bound for `devicePixelRatio`, in hundredths (100 = 1×, 200 = 2×). */
    readonly pixelRatioCapPercent: number;
  };
  /** Volumes 0–100. Stored only; audio arrives in P4. */
  readonly audio: { readonly master: number; readonly effects: number; readonly ambience: number };
  readonly controls: {
    /** Mouse-look sensitivity in percent of the default (10–300). */
    readonly lookSensitivityPercent: number;
    readonly invertY: boolean;
  };
  readonly units: { readonly display: 'imperial' | 'metric' };
  /** Default for new games; the actual value lives in each world (plan §6 P1 kickoff decisions). */
  readonly difficulty: { readonly default: 'trainee' | 'apprentice' | 'journeyman' | 'realistic' };
  /** NEC only through 1.0; shown disabled. */
  readonly region: { readonly id: 'nec' };
  readonly interface: {
    /** `system` follows `prefers-color-scheme`. */
    readonly theme: 'system' | 'light' | 'dark';
    /** `system` follows `prefers-reduced-motion`; `reduce` forces reduced motion on. */
    readonly motion: 'system' | 'reduce';
  };
  readonly workspace: {
    readonly layout: {
      readonly inspector: { readonly size: number; readonly collapsed: boolean };
      readonly bottom: { readonly size: number; readonly collapsed: boolean };
    };
  };
}

/**
 * Loads and saves {@link SettingsDocument}. Implementations (Electron IPC `settings:get`/`settings:set`,
 * web harness storage) validate with the save-format schema and fall back to defaults, with a
 * notification, when the stored document is missing, corrupt or from an unknown version.
 *
 * TODO(F1.8a): Electron and web implementations land with the real schema.
 */
export interface SettingsService {
  /** The stored settings, or defaults when nothing valid is stored. */
  load(): Promise<SettingsLoadResult>;
  /** Persists the whole document (atomically on desktop). */
  save(settings: SettingsDocument): Promise<void>;
}

export interface SettingsLoadResult {
  readonly settings: SettingsDocument;
  /** Set when the stored document was unusable and defaults were used instead. */
  readonly fallbackReason?: 'missing' | 'corrupt' | 'unknown-version';
}
