/**
 * Every IPC channel name, in one place. Main registers handlers only for these;
 * the preload exposes only these. Adding a channel = add it here + a Zod schema.
 */
export const IpcChannel = {
  AppInfo: 'app:info',
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
