import {
  afterNextRender,
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { type AnyCommandDef, SELECTION_ENTITY_ID_KEY } from '@controls/commands';
import { KeybindingService, Session } from '@controls/feature-session';
import { SettingsStore } from '@controls/feature-settings';
import { MAX_PALETTE_RECENTS } from '@controls/save-format';
import { Button, Dialog } from '@controls/ui';
import type { World } from '@controls/world-model';
import { type ArgErrors, type ArgForm, argsFromValues, buildArgForm, initialValues, validateArgs } from './arg-form';
import { type EntityChoice, PaletteArgForm } from './palette-arg-form';
import { type PaletteItem, paletteItems } from './palette-items';

type Command = AnyCommandDef<World>;

type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'form'; readonly def: Command; readonly form: ArgForm }
  | { readonly kind: 'confirm'; readonly def: Command; readonly form: ArgForm; readonly args: unknown };

const NO_ERRORS: ArgErrors = { fields: {}, form: [] };
let nextPaletteId = 0;

/**
 * The command palette (plan F1.3, spec §4.6): one of the four surfaces over the command registry.
 * `palette.open` (Mod+K, Mod+Shift+P; a global binding) opens it through `Session.onCommand`.
 *
 * - **List:** an ARIA combobox (the search field) controlling a listbox of every registered command,
 *   fuzzy-matched on title, category and id. ↑/↓ move, Enter chooses, Escape closes and focus
 *   returns to where it was. Commands whose `when` is false are listed after the others, marked
 *   unavailable with the reason. Recent commands (settings `palette.recents`) come first.
 * - **Form:** a command with arguments gets a form generated from its Zod `args`
 *   (`buildArgForm`). Errors come from the same schema and show inline; Escape goes back.
 * - **Cheats:** a `cheat` command asks for confirmation before it marks the world as assisted.
 *
 * The palette never changes the world itself: it calls `Session.exec` once it has closed (so a
 * command that moves focus, such as opening another panel, keeps it). If the command is refused,
 * the palette reopens on that command with the message.
 */
@Component({
  selector: 'ctl-command-palette',
  imports: [Dialog, PaletteArgForm, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(click)': 'onClick($event)' },
  templateUrl: './command-palette.html',
  styleUrl: './command-palette.scss',
})
export class CommandPalette {
  private readonly session = inject(Session);
  private readonly keys = inject(KeybindingService);
  private readonly settings = inject(SettingsStore);
  private readonly injector = inject(Injector);

  readonly open = signal(false);
  protected readonly view = signal<View>({ kind: 'list' });
  protected readonly query = signal('');
  protected readonly active = signal(0);
  protected readonly values = signal<Readonly<Record<string, string | boolean>>>({});
  /** Set by the first Run, so errors appear (and then update live) only after an attempt. */
  private readonly attempted = signal(false);
  /** The refusal of the last run, shown on the form it came from. */
  private readonly execError = signal<string | null>(null);
  /** Polite announcements: unavailable commands, results. */
  protected readonly status = signal('');

  protected readonly prefix = `ctl-palette-${nextPaletteId++}`;
  protected readonly listboxId = `${this.prefix}-listbox`;
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');
  private readonly listbox = viewChild<ElementRef<HTMLElement>>('listbox');
  private readonly argForm = viewChild(PaletteArgForm);
  private readonly confirmButton = viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  /** A command waiting for the dialog to close (and focus to return) before it runs. */
  private pending: { def: Command; form: ArgForm; args: unknown } | null = null;

  protected readonly items = computed(() =>
    paletteItems(this.session.registry, this.session.contextKeys(), this.query(), this.recents()),
  );
  protected readonly activeItem = computed<PaletteItem<World> | undefined>(() => this.items()[this.active()]);
  private readonly recents = computed(() => this.settings.settings().palette.recents);

  /** The selected world entity (context key `selection.entityId`), offered by entity-reference fields. */
  protected readonly selectedEntity = computed<EntityChoice | null>(() => {
    const id = this.session.contextKeys()[SELECTION_ENTITY_ID_KEY];
    if (typeof id !== 'number') return null;
    return this.entities().find((e) => e.id === id) ?? null;
  });
  protected readonly entities = computed<EntityChoice[]>(() =>
    this.session.world().entities.map((e) => ({ id: e.id, label: e.ref.id })),
  );

  protected readonly errors = computed<ArgErrors>(() => {
    const view = this.view();
    const failure = this.execError();
    if (view.kind !== 'form') return NO_ERRORS;
    const errors = this.attempted() ? this.validate(view)[1] : NO_ERRORS;
    return failure === null ? errors : { ...errors, form: [failure, ...errors.form] };
  });

  constructor() {
    const off = this.session.onCommand('palette.open', () => this.show());
    inject(DestroyRef).onDestroy(off);
    // Keep the active option visible while arrowing through a long list (DOM side effect).
    afterRenderEffect(() => {
      const index = this.active();
      const option = this.listbox()?.nativeElement.querySelector(`#${this.optionId(index)}`);
      if (option && typeof option.scrollIntoView === 'function') option.scrollIntoView({ block: 'nearest' });
    });
  }

  /** Opens the palette on the command list with an empty query (also when it is already open). */
  show(): void {
    this.pending = null;
    this.toList('');
    this.status.set('');
    this.open.set(true);
  }

  protected optionId(index: number): string {
    return `${this.prefix}-option-${index}`;
  }

  protected chords(id: string): string[] {
    return this.keys.chordsOf(id).map((chord) => this.keys.label(chord));
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.active.set(0);
  }

  /** Combobox keys: ↑/↓ (wrapping), Home/End, Enter. Escape bubbles to the dialog, which closes. */
  protected onSearchKeydown(event: KeyboardEvent): void {
    const count = this.items().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (count === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this.active.update((i) => (i + step + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = this.activeItem();
      if (item) this.choose(item);
    }
  }

  /** Mouse: clicking an option chooses it (keyboard users never need this). */
  protected onClick(event: MouseEvent): void {
    const option = (event.target as Element).closest?.('[data-index]');
    if (!option || !this.listbox()?.nativeElement.contains(option)) return;
    const index = Number(option.getAttribute('data-index'));
    this.active.set(index);
    const item = this.items()[index];
    if (item) this.choose(item);
  }

  /**
   * Keys on the cheat confirmation's buttons: Escape backs out (handled here, inside the dialog, so
   * the dialog doesn't close), any arrow moves to the other button.
   */
  protected onConfirmKeydown(event: KeyboardEvent): void {
    const button = event.target as HTMLButtonElement;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.back();
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const buttons = Array.from(
        button.closest('.actions')?.querySelectorAll<HTMLButtonElement>('[data-confirm-action]') ?? [],
      );
      event.preventDefault();
      buttons[(buttons.indexOf(button) + 1) % buttons.length]?.focus();
    }
  }

  private choose(item: PaletteItem<World>): void {
    if (!item.enabled) {
      this.status.set(`${item.def.title}: ${item.reason}`);
      return;
    }
    const built = buildArgForm(item.def.args);
    if (!built.ok) {
      this.status.set(`${item.def.title} can't be run from the palette (${built.reason}).`);
      return;
    }
    if (built.form.fields.length === 0) {
      this.proceed(item.def, built.form, {});
      return;
    }
    this.toForm(item.def, built.form);
  }

  /** The form's Run: validate with the command's schema, then confirm (cheats) or run. */
  protected runForm(): void {
    const view = this.view();
    if (view.kind !== 'form') return;
    this.attempted.set(true);
    this.execError.set(null);
    const [args] = this.validate(view);
    if (args !== undefined) this.proceed(view.def, view.form, args);
    else this.focusAfterRender(() => this.argForm()?.focusFirstInvalid());
  }

  private validate(view: { def: Command; form: ArgForm }): [unknown, ArgErrors] {
    const result = validateArgs(view.def.args, view.form, argsFromValues(view.form, this.values()));
    return result.ok ? [result.args, NO_ERRORS] : [undefined, result.errors];
  }

  private proceed(def: Command, form: ArgForm, args: unknown): void {
    if (def.cheat && !this.session.world().assisted) {
      this.view.set({ kind: 'confirm', def, form, args });
      this.focusAfterRender(() => this.confirmButton()?.nativeElement.focus());
      return;
    }
    this.pending = { def, form, args };
    this.open.set(false);
  }

  protected confirmCheat(): void {
    const view = this.view();
    if (view.kind !== 'confirm') return;
    this.pending = { def: view.def, form: view.form, args: view.args };
    this.open.set(false);
  }

  /** Back one step: confirmation → form (or list), form → list. */
  protected back(): void {
    const view = this.view();
    if (view.kind === 'confirm' && view.form.fields.length > 0) this.toForm(view.def, view.form, false);
    else this.toList(this.query());
  }

  /** After the dialog has closed and restored focus: run the pending command. */
  protected onClosed(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    const result = this.session.exec(pending.def.id, pending.args);
    if (result.ok) {
      this.remember(pending.def.id);
      return;
    }
    // Refused (for example "No entity with id 7"): reopen on the command with the message.
    this.toForm(pending.def, pending.form, false);
    this.execError.set(result.error.message);
    this.open.set(true);
  }

  private remember(id: string): void {
    const recents = [id, ...this.recents().filter((r) => r !== id)].slice(0, MAX_PALETTE_RECENTS);
    this.settings.update('palette', { recents });
  }

  private toList(query: string): void {
    this.view.set({ kind: 'list' });
    this.query.set(query);
    this.active.set(0);
    this.execError.set(null);
    this.focusAfterRender(() => this.searchInput()?.nativeElement.focus());
  }

  private toForm(def: Command, form: ArgForm, reset = true): void {
    if (reset) {
      const selected = this.session.contextKeys()[SELECTION_ENTITY_ID_KEY];
      this.values.set(initialValues(form, { selectedEntityId: typeof selected === 'number' ? selected : null }));
      this.attempted.set(false);
    }
    this.execError.set(null);
    this.view.set({ kind: 'form', def, form });
    this.focusAfterRender(() => this.argForm()?.focusFirst());
  }

  private focusAfterRender(focus: () => void): void {
    afterNextRender(focus, { injector: this.injector });
  }
}
