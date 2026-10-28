import * as fsp from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** The subset of `node:fs/promises` an atomic write uses, injectable so tests can fail one midway. */
export interface AtomicWriteFs {
  open: typeof fsp.open;
  rename: typeof fsp.rename;
  rm: typeof fsp.rm;
  mkdir: typeof fsp.mkdir;
}

let tempCounter = 0;

/** Temp files start with a dot and end in `.tmp`, so listings skip them. */
export const isTempFileName = (name: string): boolean => name.startsWith('.') && name.endsWith('.tmp');

/**
 * Writes `data` to `path` atomically:
 * 1. a temp file **in the same directory** (so the rename can't cross file systems), mode 0600;
 * 2. write and `fsync` it, so its data is on disk before it gets the name;
 * 3. `rename` it over the target (atomic on POSIX and on NTFS through `MoveFileEx`);
 * 4. `fsync` the directory (POSIX), so the rename itself survives a power cut.
 *
 * If any step up to the rename fails, the temp file is removed and the previous file is untouched.
 * The directory `fsync` is best effort: the rename has happened, so failing the write then would
 * tell the player a save failed that in fact landed. Windows can't open a directory to sync it.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array, fs: AtomicWriteFs = fsp): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${basename(path)}.${process.pid}.${tempCounter++}.tmp`);
  try {
    // 'wx': never follow or reuse something already at the temp name.
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await (typeof data === 'string' ? handle.writeFile(data, 'utf8') : handle.writeFile(data));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, path);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(dir, fs);
}

/** `fsync` a directory so a rename in it is durable. No-op on Windows; never throws. */
export async function syncDirectory(dir: string, fs: Pick<AtomicWriteFs, 'open'> = fsp): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const handle = await fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort (some file systems refuse to sync a directory); the rename has already happened.
  }
}
