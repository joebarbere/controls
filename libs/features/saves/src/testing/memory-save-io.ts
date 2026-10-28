import {
  type DialogService,
  type FileService,
  type SaveAsTarget,
  type SaveEntry,
  SaveIoError,
  type SaveIoErrorCode,
  type SaveTarget,
} from '@controls/platform-api';

interface Stored {
  entry: SaveEntry;
  bytes: Uint8Array;
}

/**
 * An in-memory save directory and pickers for specs (not the platform contract: that is
 * `describeSaveIoContract`). Manual saves and autosave slots, newest first; autosave slots rotate in
 * order; Open and Save As picks are queued by the spec; `failNext` makes the next call reject.
 */
export class MemorySaveIo {
  readonly files: FileService;
  readonly dialogs: DialogService;
  readonly calls: string[] = [];
  /** Files written through Save As targets. */
  readonly savedAs: { name: string; bytes: Uint8Array }[] = [];
  private readonly stored = new Map<string, Stored>();
  private readonly targets = new Map<string, string>();
  private nextHandle = 0;
  private clock = 1_000_000;
  private lastSlot = 0;
  private failure: { op: string; code: SaveIoErrorCode } | null = null;
  private openPick: { name: string; bytes: Uint8Array } | null = null;
  private saveAsPick: string | null = null;

  constructor() {
    this.files = {
      list: async () => {
        this.check('list');
        return [...this.stored.values()]
          .map((s) => s.entry)
          .filter((e) => e.kind !== 'external')
          .sort((a, b) => b.modifiedMs - a.modifiedMs);
      },
      read: async (handle) => {
        this.check('read');
        const found = this.stored.get(handle);
        if (!found) throw new SaveIoError('unknown-handle');
        return found.bytes.slice();
      },
      write: async (target, bytes) => {
        this.check('write');
        return this.write(target, bytes);
      },
    };
    this.dialogs = {
      open: async () => {
        this.check('open');
        const pick = this.openPick;
        this.openPick = null;
        return pick ? this.put({ kind: 'external', name: pick.name, slot: null }, pick.bytes) : null;
      },
      saveAs: async () => {
        this.check('saveAs');
        const pick = this.saveAsPick;
        this.saveAsPick = null;
        if (pick === null) return null;
        const handle = this.handle();
        this.targets.set(handle, pick);
        return { handle, name: pick } satisfies SaveAsTarget;
      },
    };
  }

  /** Adds a save as if an earlier session had written it. */
  seed(entry: { kind: 'manual' | 'autosave'; name: string; slot?: number }, bytes: Uint8Array): SaveEntry {
    return this.put({ kind: entry.kind, name: entry.name, slot: entry.slot ?? null }, bytes);
  }

  /** The bytes of the save named `name` (manual or `Autosave N`), if any. */
  bytesOf(name: string): Uint8Array | undefined {
    return [...this.stored.values()].find((s) => s.entry.name === name)?.bytes;
  }

  names(): string[] {
    return [...this.stored.values()].filter((s) => s.entry.kind !== 'external').map((s) => s.entry.name);
  }

  /** The next call of `op` (`list`, `read`, `write`, `open`, `saveAs`) rejects with `code`. */
  failNext(op: string, code: SaveIoErrorCode): void {
    this.failure = { op, code };
  }

  nextOpen(pick: { name: string; bytes: Uint8Array } | null): void {
    this.openPick = pick;
  }

  nextSaveAs(fileName: string | null): void {
    this.saveAsPick = fileName;
  }

  private check(op: string): void {
    this.calls.push(op);
    if (this.failure?.op === op) {
      const { code } = this.failure;
      this.failure = null;
      throw new SaveIoError(code);
    }
  }

  private write(target: SaveTarget, bytes: Uint8Array): SaveEntry {
    switch (target.kind) {
      case 'manual': {
        const existing = [...this.stored.values()].find(
          (s) => s.entry.kind === 'manual' && s.entry.name === target.name,
        );
        if (existing && !target.overwrite) throw new SaveIoError('exists');
        if (existing) this.stored.delete(existing.entry.handle);
        return this.put({ kind: 'manual', name: target.name, slot: null }, bytes, existing?.entry.handle);
      }
      case 'autosave': {
        const slot = (this.lastSlot % target.slotCount) + 1;
        this.lastSlot = slot;
        const existing = [...this.stored.values()].find((s) => s.entry.kind === 'autosave' && s.entry.slot === slot);
        if (existing) this.stored.delete(existing.entry.handle);
        return this.put({ kind: 'autosave', name: `Autosave ${slot}`, slot }, bytes, existing?.entry.handle);
      }
      case 'handle': {
        const name = this.targets.get(target.handle);
        if (name === undefined) throw new SaveIoError('unknown-handle');
        this.savedAs.push({ name, bytes: bytes.slice() });
        return {
          handle: target.handle,
          name,
          kind: 'external',
          slot: null,
          modifiedMs: this.clock,
          sizeBytes: bytes.length,
        };
      }
    }
  }

  private put(
    entry: { kind: SaveEntry['kind']; name: string; slot: number | null },
    bytes: Uint8Array,
    handle = this.handle(),
  ): SaveEntry {
    const saved: SaveEntry = { ...entry, handle, modifiedMs: (this.clock += 1000), sizeBytes: bytes.length };
    this.stored.set(handle, { entry: saved, bytes: bytes.slice() });
    return saved;
  }

  private handle(): string {
    return `h${String(this.nextHandle++).padStart(21, '0')}`;
  }
}
