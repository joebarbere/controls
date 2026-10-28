import type { SaveHandle } from '@controls/ipc-contract';
import { randomBytes } from 'node:crypto';
import type { SaveLocation } from './save-store';

/** 128 random bits, base64url: 22 characters (`SaveHandleSchema`). */
export const randomSaveHandle = (): SaveHandle => randomBytes(16).toString('base64url');

interface Issued {
  readonly ownerId: number;
  readonly location: SaveLocation;
  readonly key: string | null;
}

/**
 * Opaque save handles (ADR 0009). Main maps each random token to a {@link SaveLocation} and the
 * `WebContents` it was issued to; the renderer only ever holds the token.
 * - A token from another window, a guessed one or a stale one resolves to nothing (`unknown-handle`).
 * - Save-directory locations get one stable token per window (listing twice gives the same handle);
 *   every dialog pick gets a fresh token.
 * - The table is bounded: past `limit` the oldest token is forgotten (the renderer lists again).
 */
export class SaveHandleTable {
  private readonly byToken = new Map<SaveHandle, Issued>();
  private readonly byKey = new Map<string, SaveHandle>();

  constructor(
    private readonly random: () => SaveHandle = randomSaveHandle,
    private readonly limit = 4096,
  ) {}

  issue(ownerId: number, location: SaveLocation): SaveHandle {
    const key = stableKey(ownerId, location);
    const existing = key === null ? undefined : this.byKey.get(key);
    if (existing !== undefined) return existing;
    let token = this.random();
    while (this.byToken.has(token)) token = this.random();
    this.byToken.set(token, { ownerId, location, key });
    if (key !== null) this.byKey.set(key, token);
    while (this.byToken.size > this.limit) this.evictOldest();
    return token;
  }

  /** The location behind `token`, only for the window it was issued to. */
  resolve(ownerId: number, token: SaveHandle): SaveLocation | undefined {
    const issued = this.byToken.get(token);
    return issued && issued.ownerId === ownerId ? issued.location : undefined;
  }

  /** Forgets every handle of a window (its `WebContents` was destroyed). */
  forgetOwner(ownerId: number): void {
    for (const [token, issued] of this.byToken)
      if (issued.ownerId === ownerId) {
        this.byToken.delete(token);
        if (issued.key !== null) this.byKey.delete(issued.key);
      }
  }

  get size(): number {
    return this.byToken.size;
  }

  private evictOldest(): void {
    const first = this.byToken.entries().next();
    if (first.done) return;
    const [token, issued] = first.value;
    this.byToken.delete(token);
    if (issued.key !== null) this.byKey.delete(issued.key);
  }
}

function stableKey(ownerId: number, location: SaveLocation): string | null {
  switch (location.kind) {
    case 'manual':
      return `${ownerId}\u0000manual\u0000${location.name}`;
    case 'autosave':
      return `${ownerId}\u0000autosave\u0000${location.slot}`;
    case 'external':
      return null;
  }
}
