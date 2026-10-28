/**
 * Every IPC channel name, in one place. Main registers handlers only for these;
 * the preload exposes only these. Adding a channel = add it here + a Zod schema.
 * All are renderer → main `invoke`s except {@link IpcChannel.FlushRequest}.
 */
export const IpcChannel = {
  AppInfo: 'app:info',
  /** Read the settings document (main parses it with `loadSettings`; defaults on any problem). */
  SettingsGet: 'settings:get',
  /** Write the whole settings document atomically. Validated and size-capped in main. */
  SettingsSet: 'settings:set',
  /** Quit the app (all platforms, including macOS). */
  AppQuit: 'app:quit',
  /**
   * Main → renderer (`webContents.send`, the only channel in that direction): finish pending writes
   * before the window closes or the app quits (`FlushRequestSchema`). Main registers no handler for it.
   */
  FlushRequest: 'app:flush-request',
  /** Renderer → main: the flush request is done (`FlushAckSchema`). Main then closes or quits. */
  FlushAck: 'app:flush-ack',
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
