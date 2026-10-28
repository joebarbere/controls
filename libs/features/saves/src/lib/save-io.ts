import { Injectable, InjectionToken } from '@angular/core';
import { type DialogService, type FileService, SaveIoError } from '@controls/platform-api';

const unavailable = (): Promise<never> => Promise.reject(new SaveIoError('unavailable'));

/**
 * The host's save directory (`Platform.files`, ADR 0009). apps/game provides the platform's
 * (`provideSaveIoFromPlatform()`); the default has no storage and refuses everything with
 * `unavailable`, which is what component specs that don't save get.
 */
export const SAVE_FILES = new InjectionToken<FileService>('controls.saveFiles', {
  providedIn: 'root',
  factory: () => ({ list: unavailable, read: unavailable, write: unavailable }),
});

/** The host's Open and Save As pickers (`Platform.dialogs`). Call them from a user gesture. */
export const SAVE_DIALOGS = new InjectionToken<DialogService>('controls.saveDialogs', {
  providedIn: 'root',
  factory: () => ({ open: unavailable, saveAs: unavailable }),
});

/**
 * What a load does when the save's replay log doesn't reproduce its world (`replay.status:
 * 'restarted'`): `notify` loads the world and tells the player a new log started (the current
 * decision, ADR 0007: the world wins), `refuse` refuses the save. One switch, so changing the
 * decision is a one-line provider change.
 */
export type ReplayMismatchPolicy = 'notify' | 'refuse';
export const REPLAY_MISMATCH_POLICY = new InjectionToken<ReplayMismatchPolicy>('controls.replayMismatchPolicy', {
  providedIn: 'root',
  factory: () => 'notify',
});

/** PNG bytes for a save's `thumbnail.png`, or null when there is nothing to capture. */
export type ThumbnailSource = () => Promise<Uint8Array | null>;

/**
 * Where save thumbnails come from. The app registers the viewport's capture once the workspace
 * exists; until then (and in specs) saves have no thumbnail. A failing capture never fails a save.
 */
@Injectable({ providedIn: 'root' })
export class SaveThumbnails {
  private source: ThumbnailSource | null = null;

  /** Sets the capture function. Returns a function that removes it again. */
  register(source: ThumbnailSource): () => void {
    this.source = source;
    return () => {
      if (this.source === source) this.source = null;
    };
  }

  /** A thumbnail, or null (no source, or the capture failed). Never rejects. */
  async capture(): Promise<Uint8Array | null> {
    try {
      return (await this.source?.()) ?? null;
    } catch {
      return null;
    }
  }
}
