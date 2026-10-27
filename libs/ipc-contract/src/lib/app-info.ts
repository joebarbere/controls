import { z } from 'zod';

/** Response of {@link IpcChannel.AppInfo}: who/what is running. */
export const AppInfoSchema = z.object({
  appVersion: z.string(),
  platform: z.enum(['linux', 'darwin', 'win32', 'web']),
  arch: z.string(),
  isPackaged: z.boolean(),
  versions: z.object({
    electron: z.string().optional(),
    chrome: z.string().optional(),
    node: z.string().optional(),
  }),
});

export type AppInfo = z.infer<typeof AppInfoSchema>;
