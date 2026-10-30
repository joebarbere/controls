import { SaveIoError, type SaveIoErrorCode } from '@controls/platform-api';
import type { LoadGameError } from '@controls/scripting-api';

/*
 * Player-facing messages for save and load failures (F1.8b). Written here, from the error's kind or
 * code only: never from the error's own message, so nothing read from a file (an entry name, a
 * Zod issue path, a version string we didn't validate) or a path from the host reaches the screen.
 */

const DAMAGED = 'The save is damaged, or it isn’t a Controls save.';

/** Why `loadGame` / `readCtrl` refused a save, for a notification. */
export function loadErrorReason(error: LoadGameError): string {
  switch (error.kind) {
    case 'too-large':
    case 'total-too-large':
    case 'entry-too-large':
    case 'too-many-entries':
      return 'The save is larger than this version of Controls can load.';
    case 'newer-than-build':
      return 'The save was made by a newer version of Controls. Update the game to load it.';
    case 'invalid-document':
      if (error.error.kind === 'migration-failed' || error.error.kind === 'unsupported-version')
        return 'The save is from a version of Controls this one can’t upgrade.';
      return DAMAGED;
    case 'not-a-zip':
    case 'unsupported-zip':
    case 'unsafe-path':
    case 'duplicate-entry':
    case 'corrupt-entry':
    case 'unexpected-entry':
    case 'missing-entry':
    case 'not-utf8':
    case 'not-json':
    case 'version-mismatch':
    case 'invalid-thumbnail':
      return DAMAGED;
    case 'invalid-device-state':
      return 'The save holds devices this version of Controls doesn’t recognise in that state, or it is damaged.';
  }
}

export type SaveAction = 'save' | 'load' | 'list';

/** The `SaveIoError` code of a rejection, or `io` for anything else (a host error we don't trust). */
export function saveIoCodeOf(error: unknown): SaveIoErrorCode {
  return error instanceof SaveIoError ? error.code : 'io';
}

/** Why the platform refused or failed a save operation, for a notification. */
export function saveIoReason(error: unknown, action: SaveAction): string {
  switch (saveIoCodeOf(error)) {
    case 'invalid':
      return action === 'save' ? 'That name can’t be used for a save.' : 'The save couldn’t be read.';
    case 'unknown-handle':
    case 'not-found':
      return 'The save isn’t there any more.';
    case 'exists':
      return 'A save with that name already exists.';
    case 'too-large':
      return action === 'save' ? 'The game is too large to save.' : 'The save is too large to load.';
    case 'read-only':
      return 'That file can only be read.';
    case 'write-only':
      return 'That file can only be written.';
    case 'not-a-file':
      return 'That isn’t a save file.';
    case 'busy':
      return 'A file dialog is already open.';
    case 'unavailable':
      return 'Saving isn’t available here: this browser gives the game no storage.';
    case 'io':
      return action === 'save' ? 'The file couldn’t be written.' : 'The file couldn’t be read.';
  }
}
