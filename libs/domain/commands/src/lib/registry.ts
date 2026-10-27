import { CommandId } from '@controls/save-format';
import type { AnyCommandDef } from './command';
import { type ContextKeys, evaluateWhen, parseWhen, type WhenExpr } from './when';

export type RegistrationFailure = 'malformed-id' | 'duplicate-id' | 'malformed-when';

/** Thrown by {@link CommandRegistry.register}: a malformed command is a programming error. */
export class CommandRegistrationError extends Error {
  constructor(
    readonly reason: RegistrationFailure,
    readonly commandId: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommandRegistrationError';
  }
}

interface Entry<S> {
  readonly def: AnyCommandDef<S>;
  readonly when: WhenExpr | null;
}

/**
 * The one command registry behind the palette, keybindings, console and scripting API (plan §4.6).
 * Ids must match the replay log's command-id grammar (`CommandId` from `@controls/save-format`),
 * so anything that runs can also be logged, and must be unique. `when` is parsed at registration.
 */
export class CommandRegistry<S> {
  private readonly entries = new Map<string, Entry<S>>();

  /** Registers a command. Throws {@link CommandRegistrationError} on a bad or duplicate id or `when`. */
  register(def: AnyCommandDef<S>): this {
    if (!CommandId.safeParse(def.id).success) {
      throw new CommandRegistrationError(
        'malformed-id',
        def.id,
        `Command id "${def.id}" must be dotted camelCase segments, e.g. "entity.place" (at most 128 characters)`,
      );
    }
    if (this.entries.has(def.id)) {
      throw new CommandRegistrationError('duplicate-id', def.id, `Command "${def.id}" is already registered`);
    }
    let when: WhenExpr | null = null;
    if (def.when !== undefined) {
      const parsed = parseWhen(def.when);
      if (!parsed.ok) {
        throw new CommandRegistrationError(
          'malformed-when',
          def.id,
          `Command "${def.id}" has a malformed when (column ${parsed.error.column}): ${parsed.error.message}`,
        );
      }
      when = parsed.expr;
    }
    this.entries.set(def.id, { def, when });
    return this;
  }

  registerAll(defs: Iterable<AnyCommandDef<S>>): this {
    for (const def of defs) this.register(def);
    return this;
  }

  get(id: string): AnyCommandDef<S> | undefined {
    return this.entries.get(id)?.def;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Every command, sorted by id (not by registration order, so listings are deterministic). */
  list(): AnyCommandDef<S>[] {
    return [...this.entries.values()].map((e) => e.def).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** The parsed `when` of a command (`null` if it has none). Undefined for an unknown id. */
  whenOf(id: string): WhenExpr | null | undefined {
    return this.entries.get(id)?.when;
  }

  /**
   * Whether the palette and keybindings should offer the command in this context: it exists and
   * its `when` (if any) holds. `exec` does not consult this (ADR 0006).
   */
  isEnabled(id: string, context: ContextKeys): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    return entry.when === null || evaluateWhen(entry.when, context);
  }
}
