/**
 * The kind of game running. P1 only has sandboxes; career saves arrive with the job system, and
 * the console is hidden there (it would make every career save assisted).
 */
export type SessionKind = 'sandbox' | 'career';

export interface ConsoleAvailabilityInput {
  /** The workspace is on screen (not behind the main menu). */
  readonly inWorkspace: boolean;
  /** The running game's kind, or `null` before one starts. */
  readonly sessionKind: SessionKind | null;
  /** A development build (`isDevMode()`), where the console is always offered. */
  readonly devBuild: boolean;
}

/**
 * Whether the dev console is offered (plan F1.5): in Sandbox and in dev builds, and only while the
 * workspace is showing. The result is published as the `console.available` context key, which
 * gates `console.toggle` for the palette and the backtick binding.
 */
export function isConsoleAvailable({ inWorkspace, sessionKind, devBuild }: ConsoleAvailabilityInput): boolean {
  if (!inWorkspace) return false;
  return devBuild || sessionKind === 'sandbox';
}
