import { MAX_SETTINGS_JSON_LENGTH, parseStoredSettings, type SettingsLoadResult } from '@controls/ipc-contract';
import { defaultSettings } from '@controls/save-format';
import * as fsp from 'node:fs/promises';
import { writeFileAtomic, type AtomicWriteFs } from './atomic-write';

const corrupt = (): SettingsLoadResult => ({ settings: defaultSettings(), fallbackReason: 'corrupt' });

/** The subset of `node:fs/promises` used here, injectable so tests can fail a write midway. */
export interface SettingsFs extends AtomicWriteFs {
  readFile: typeof fsp.readFile;
  stat: typeof fsp.stat;
}

export { writeFileAtomic };

/**
 * The settings file under Electron's `userData` (which `CONTROLS_USER_DATA_DIR` overrides).
 * Reads never throw: a missing, oversized, corrupt, foreign or newer file yields defaults plus a
 * reason. Writes are serialised, so the last `write` call always wins on disk.
 */
export class SettingsFile {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly fs: SettingsFs = fsp,
  ) {}

  async read(): Promise<SettingsLoadResult> {
    let text: string;
    try {
      // Refuse an oversized file before reading it into memory (UTF-8 is at most 4 bytes per unit).
      const { size } = await this.fs.stat(this.path);
      if (size > MAX_SETTINGS_JSON_LENGTH * 4) return corrupt();
      text = await this.fs.readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parseStoredSettings(null);
      return corrupt(); // unreadable (permissions, a directory, …)
    }
    return parseStoredSettings(text);
  }

  /** Writes already-validated JSON. Resolves once this write (and every earlier one) is on disk. */
  write(json: string): Promise<void> {
    const next = this.queue.then(() => writeFileAtomic(this.path, json, this.fs));
    this.queue = next.catch(() => undefined);
    return next;
  }
}
