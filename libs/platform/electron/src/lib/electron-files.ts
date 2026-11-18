import {
  DialogOpenRequestSchema,
  DialogOpenResponseSchema,
  DialogSaveAsRequestSchema,
  DialogSaveAsResponseSchema,
  isSaveThumbnail,
  isUint8Array,
  MAX_SAVE_BYTES,
  SaveDeleteRequestSchema,
  saveErrorCodeOf,
  SaveEntrySchema,
  SaveListResponseSchema,
  SaveReadRequestSchema,
  SaveThumbnailRequestSchema,
  SaveWriteRequestSchema,
  type ControlsBridge,
  type DialogFileType,
  type SaveAsTarget,
  type SaveEntry,
  type SaveHandle,
  type SaveName,
  type SaveTarget,
} from '@controls/ipc-contract';
import { SaveIoError, type DialogService, type FileService } from '@controls/platform-api';

/** Turns a bridge rejection into a {@link SaveIoError} with main's reason code (never its text). */
async function call<T>(invoke: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  let response: unknown;
  try {
    response = await invoke();
  } catch (error) {
    const code = saveErrorCodeOf(error instanceof Error ? error.message : String(error));
    throw new SaveIoError(code);
  }
  try {
    return parse(response);
  } catch {
    throw new SaveIoError('io', 'The save response from the desktop app was malformed.');
  }
}

/** Validates a request locally first: a request main would refuse fails the same way without a round trip. */
function request<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SaveIoError('invalid');
  return parsed.data;
}

/**
 * Saves over `save:list` / `save:read` / `save:write` / `save:delete` / `save:thumbnail`. Main owns the directory, the paths and the
 * atomic writes; this side checks requests before sending them (same schemas, same codes) and
 * re-validates every response, so a bad reply never reaches the game.
 */
export class ElectronFileService implements FileService {
  constructor(private readonly bridge: ControlsBridge) {}

  list(): Promise<SaveEntry[]> {
    return call(
      () => this.bridge.listSaves(),
      (r) => SaveListResponseSchema.parse(r),
    );
  }

  async read(handle: SaveHandle): Promise<Uint8Array> {
    const payload = request(SaveReadRequestSchema, { handle });
    return call(
      () => this.bridge.readSave(payload),
      (r) => {
        if (!isUint8Array(r) || r.byteLength > MAX_SAVE_BYTES) throw new Error('not save bytes');
        return r;
      },
    );
  }

  async write(target: SaveTarget, bytes: Uint8Array): Promise<SaveEntry> {
    const payload = request(SaveWriteRequestSchema, { target, bytes });
    if (payload.bytes.byteLength > MAX_SAVE_BYTES) throw new SaveIoError('too-large');
    return call(
      () => this.bridge.writeSave(payload),
      (r) => SaveEntrySchema.parse(r),
    );
  }

  async delete(handle: SaveHandle): Promise<void> {
    const payload = request(SaveDeleteRequestSchema, { handle });
    await call(
      () => this.bridge.deleteSave(payload),
      (r) => {
        if (r !== undefined) throw new Error('unexpected delete response');
      },
    );
  }

  async thumbnail(handle: SaveHandle): Promise<Uint8Array | null> {
    const payload = request(SaveThumbnailRequestSchema, { handle });
    return call(
      () => this.bridge.readSaveThumbnail(payload),
      (r) => {
        if (!isSaveThumbnail(r)) throw new Error('not a thumbnail');
        return r;
      },
    );
  }
}

/** Native Open and Save As dialogs in main (`dialog:open`, `dialog:saveAs`). */
export class ElectronDialogService implements DialogService {
  constructor(private readonly bridge: ControlsBridge) {}

  async open(options: { readonly fileType: DialogFileType }): Promise<SaveEntry | null> {
    const payload = request(DialogOpenRequestSchema, { fileType: options.fileType });
    return call(
      () => this.bridge.showOpenDialog(payload),
      (r) => DialogOpenResponseSchema.parse(r),
    );
  }

  async saveAs(options: {
    readonly fileType: DialogFileType;
    readonly suggestedName: SaveName;
  }): Promise<SaveAsTarget | null> {
    const payload = request(DialogSaveAsRequestSchema, {
      fileType: options.fileType,
      suggestedName: options.suggestedName,
    });
    return call(
      () => this.bridge.showSaveAsDialog(payload),
      (r) => DialogSaveAsResponseSchema.parse(r),
    );
  }
}
