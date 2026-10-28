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
  /** List manual saves and autosave slots in the main-owned save directory (`SaveListResponseSchema`). */
  SaveList: 'save:list',
  /** Read the bytes behind a handle (`SaveReadRequestSchema`). Size-capped. */
  SaveRead: 'save:read',
  /** Atomically write bytes to a manual save, the next autosave slot or a writable handle (`SaveWriteRequestSchema`). */
  SaveWrite: 'save:write',
  /** Native Open dialog; the picked file becomes a read-only handle (`DialogOpenRequestSchema`). */
  DialogOpen: 'dialog:open',
  /** Native Save As dialog; the picked path becomes a write-only handle (`DialogSaveAsRequestSchema`). */
  DialogSaveAs: 'dialog:saveAs',
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
