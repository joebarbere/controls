import { type Signal, signal } from '@angular/core';

const NO_BREAK_SPACE = ' ';

/** The viewport's one polite routing live region, shared by the wiring flows (routing, cables, landing). */
export interface Announcer {
  /** The latest announcement. */
  readonly message: Signal<string>;
  /** Says `message`; the same words twice still change the region (a trailing no-break space), so they are read again. */
  announce(message: string): void;
}

export function createAnnouncer(): Announcer {
  const message = signal('');
  return {
    message: message.asReadonly(),
    announce: (text: string) => message.set(message() === text ? `${text}${NO_BREAK_SPACE}` : text),
  };
}
