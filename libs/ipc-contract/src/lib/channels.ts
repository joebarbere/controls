/**
 * Every IPC channel name, in one place. Main registers handlers only for these;
 * the preload exposes only these. Adding a channel = add it here + a Zod schema.
 */
export const IpcChannel = {
  AppInfo: 'app:info',
  /** Read the settings document (main parses it with `loadSettings`; defaults on any problem). */
  SettingsGet: 'settings:get',
  /** Write the whole settings document atomically. Validated and size-capped in main. */
  SettingsSet: 'settings:set',
  /** Quit the app (all platforms, including macOS). */
  AppQuit: 'app:quit',
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
