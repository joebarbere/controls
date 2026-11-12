import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { Button, focusableElements } from '@controls/ui';
import {
  addListItem,
  type ArgErrors,
  type ArgField,
  type ArgForm,
  type ArgFormContext,
  type ArgValue,
  type ArgValues,
  canAddItem,
  canRemoveItem,
  type ChoiceField,
  chosenOption,
  type EnumField,
  isOptionalObject,
  itemCount,
  listHint,
  listItem,
  type ListField,
  moveListItem,
  numberHint,
  type NumberField,
  type ObjectField,
  removeListItem,
  scalarHint,
} from './arg-form';

let nextFormId = 0;

/** An entity the form can offer for an entity-reference field. */
export interface EntityChoice {
  readonly id: number;
  readonly label: string;
}

const NO_CONTEXT: ArgFormContext = { selectedEntityId: null };

/**
 * Renders a command's generated argument form (see `buildArgForm`). Presentational: it edits
 * `values` and reports `runCommand` / `goBack`; the palette validates with the command's schema and
 * passes the inline `errors` back.
 *
 * Keyboard: Tab or ↑/↓ move between fields (↑/↓ except in a `<select>` or a radio group, which use
 * them to choose), Enter runs, Enter or Space toggles a checkbox, Escape goes back to the command
 * list. A list's items each have Move up, Move down and Remove buttons (`aria-disabled` at the
 * ends and at `minItems`) and the list has an Add button (`aria-disabled` at `maxItems`); each change
 * is announced in a polite live region and focus follows the item (after a remove, it goes to the
 * item that took its place, else the one before, else Add).
 */
@Component({
  selector: 'ctl-palette-arg-form',
  host: { '(keydown)': 'onKeydown($event)' },
  imports: [NgTemplateOutlet, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './palette-arg-form.html',
  styleUrl: './palette-arg-form.scss',
})
export class PaletteArgForm {
  /** Title of the command being run, for the heading and the Run button. */
  readonly commandTitle = input.required<string>();
  readonly form = input.required<ArgForm>();
  readonly values = model.required<ArgValues>();
  readonly errors = input<ArgErrors>({ fields: {}, form: [] });
  /** The selected world entity, offered by entity-reference fields. */
  readonly selectedEntity = input<EntityChoice | null>(null);
  /** Entities in the world, suggested by entity-reference fields. */
  readonly entities = input<readonly EntityChoice[]>([]);
  /** The selection, for reference hints and for prefilling items the player adds to a list. */
  readonly context = input<ArgFormContext>(NO_CONTEXT);
  /** Emitted when the player runs the form (Enter or the Run button). */
  readonly runCommand = output<void>();
  /** Emitted on Escape or the Back button. */
  readonly goBack = output<void>();

  protected readonly prefix = `ctl-palette-arg-${nextFormId++}`;
  /** The polite live region's text: what the last list edit did. */
  protected readonly announcement = signal('');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** Focuses the first field (or the Run button for a form without fields). */
  focusFirst(): void {
    focusableElements(this.host.nativeElement)[0]?.focus();
  }

  /**
   * Focuses the first invalid field, if any (after a Run attempt). Never called on live updates:
   * errors re-validate as the player types, and moving focus then would steal their keystrokes.
   */
  focusFirstInvalid(): boolean {
    const invalid = this.host.nativeElement.querySelector<HTMLElement>('[aria-invalid="true"]');
    invalid?.focus();
    return invalid !== null;
  }

  protected domId(field: ArgField, suffix = ''): string {
    return `${this.prefix}-${field.id.replace(/\./g, '-')}${suffix}`;
  }

  protected describedBy(field: ArgField): string | null {
    const ids: string[] = [];
    if (this.hintOf(field) !== null) ids.push(this.domId(field, '-hint'));
    if (this.errorsOf(field).length > 0) ids.push(this.domId(field, '-error'));
    return ids.length > 0 ? ids.join(' ') : null;
  }

  protected errorsOf(field: ArgField): readonly string[] {
    return this.errors().fields[field.id] ?? [];
  }

  protected hintOf(field: ArgField): string | null {
    const parts: string[] = [];
    if (field.kind === 'number') {
      parts.push(numberHint(field));
      if (field.ref !== null) parts.push(this.selectionHint(field));
    }
    if (field.kind === 'scalar') parts.push(scalarHint(field));
    if (field.kind === 'list') parts.push(listHint(field));
    if (field.description) parts.push(field.description);
    const nullable = 'nullable' in field && field.nullable;
    if (nullable && field.defaultValue === undefined) parts.push('Leave blank for none');
    else if (!field.required && field.defaultValue === undefined && field.kind !== 'object') parts.push('Optional');
    return parts.length > 0 ? parts.join('. ') : null;
  }

  private selectionHint(field: NumberField): string {
    if (field.ref === 'entity') {
      const selected = this.selectedEntity();
      return selected ? `Selected: ${selected.id} (${selected.label})` : 'Nothing selected';
    }
    const context = this.context();
    const id = field.ref === 'connection' ? context.selectedConnectionId : context.selectedCableId;
    return typeof id === 'number' ? `Selected: ${id}` : 'Nothing selected';
  }

  protected text(field: ArgField): string {
    const value = this.values()[field.id];
    return typeof value === 'string' ? value : '';
  }

  protected checked(field: ArgField): boolean {
    return this.values()[field.id] === true;
  }

  protected optionLabel(field: EnumField, index: number): string {
    const option = field.options[index];
    if (option === true) return 'Yes';
    if (option === false) return 'No';
    return option === null ? 'None' : String(option);
  }

  /** A text field must be filled in: required, and blank doesn't mean `null`. */
  protected isRequiredText(field: ArgField): boolean {
    return field.required && !('nullable' in field && field.nullable);
  }

  protected inputMode(field: NumberField): string {
    return field.integer ? 'numeric' : 'decimal';
  }

  protected readonly isOptionalObject = isOptionalObject;

  /** Types the recursive template's context (`ngTemplateOutlet` contexts are untyped). */
  protected fieldsOf(fields: unknown): readonly ArgField[] {
    return fields as readonly ArgField[];
  }

  // Choices -----------------------------------------------------------------------------------

  /** The object member's fields, while the object option is chosen. */
  protected chosenObject(field: ChoiceField): ObjectField | null {
    return chosenOption(field, this.values())?.kind === 'object' ? field.object : null;
  }

  protected isChosen(field: ChoiceField, index: number): boolean {
    return this.values()[field.id] === String(index);
  }

  protected choose(field: ChoiceField, index: number): void {
    this.set(field, String(index));
  }

  // Lists -------------------------------------------------------------------------------------

  protected items(field: ListField): ArgField[] {
    return Array.from({ length: itemCount(field, this.values()) }, (_, i) => listItem(field, i));
  }

  protected itemLegend(field: ListField, index: number): string {
    return `${field.itemLabel} ${index + 1} of ${itemCount(field, this.values())}`;
  }

  protected canAdd(field: ListField): boolean {
    return canAddItem(field, this.values());
  }

  protected canRemove(field: ListField): boolean {
    return canRemoveItem(field, this.values());
  }

  protected isLast(field: ListField, index: number): boolean {
    return index === itemCount(field, this.values()) - 1;
  }

  protected addItem(field: ListField): void {
    if (!this.canAdd(field)) {
      this.announcement.set(`No more ${field.itemLabel.toLowerCase()}s: at most ${field.maxItems}.`);
      return;
    }
    const index = itemCount(field, this.values());
    this.values.set(addListItem(field, this.values(), this.context()));
    this.announcement.set(`${field.itemLabel} ${index + 1} added.`);
    this.focusLater(() => this.firstControlOf(listItem(field, index)) ?? this.byId(this.domId(field, '-add')));
  }

  protected removeItem(field: ListField, index: number): void {
    if (!this.canRemove(field)) {
      this.announcement.set(`${field.itemLabel} ${index + 1} can't be removed: at least ${field.minItems} needed.`);
      return;
    }
    this.values.set(removeListItem(field, this.values(), index));
    const count = itemCount(field, this.values());
    this.announcement.set(`${field.itemLabel} ${index + 1} removed. ${count} left.`);
    // Focus the item that took its place, else the one before, else Add.
    const next = index < count ? index : index - 1;
    this.focusLater(() =>
      next >= 0
        ? (this.firstControlOf(listItem(field, next)) ?? this.byId(this.domId(field, '-add')))
        : this.byId(this.domId(field, '-add')),
    );
  }

  protected moveItem(field: ListField, index: number, step: -1 | 1): void {
    const to = index + step;
    if (to < 0 || to >= itemCount(field, this.values())) {
      this.announcement.set(`${field.itemLabel} ${index + 1} is already ${step < 0 ? 'first' : 'last'}.`);
      return;
    }
    this.values.set(moveListItem(field, this.values(), index, to));
    this.announcement.set(`${field.itemLabel} moved to ${to + 1} of ${itemCount(field, this.values())}.`);
    // Focus follows the moved item, on the same button.
    const suffix = step < 0 ? '-up' : '-down';
    this.focusLater(() => this.byId(this.domId(listItem(field, to), suffix)));
  }

  private firstControlOf(item: ArgField): HTMLElement | null {
    const group = this.byId(this.domId(item, '-item'));
    return group ? (focusableElements(group)[0] ?? null) : null;
  }

  private byId(id: string): HTMLElement | null {
    // Ids are built from the prefix and field ids (letters, digits, '-', '_'), so no escaping is needed.
    return this.host.nativeElement.querySelector<HTMLElement>(`[id="${id}"]`);
  }

  private focusLater(target: () => HTMLElement | null): void {
    afterNextRender(() => target()?.focus(), { injector: this.injector });
  }

  // Editing -----------------------------------------------------------------------------------

  protected set(field: ArgField, value: ArgValue): void {
    this.values.update((v) => ({ ...v, [field.id]: value }));
  }

  protected onText(field: ArgField, event: Event): void {
    this.set(field, (event.target as HTMLInputElement | HTMLSelectElement).value);
  }

  protected onCheck(field: ArgField, event: Event): void {
    this.set(field, (event.target as HTMLInputElement).checked);
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    this.runCommand.emit();
  }

  protected onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (event.key === 'Escape') {
      event.preventDefault(); // handled: the dialog must not close, and the shell must not open the menu
      event.stopPropagation();
      this.goBack.emit();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const isInput = target instanceof HTMLInputElement;
    if (event.key === 'Enter' && isInput && (target.type === 'checkbox' || target.type === 'radio')) {
      event.preventDefault();
      if (target.type === 'checkbox') target.click();
      else target.form?.requestSubmit(); // a radio is chosen by focus and arrows; Enter runs, as in a text field
      return;
    }
    if (event.key === 'Enter' && target instanceof HTMLSelectElement) {
      event.preventDefault(); // a <select> doesn't submit on Enter by itself
      target.form?.requestSubmit();
      return;
    }
    const native = target.tagName === 'SELECT' || (isInput && target.type === 'radio');
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !native) {
      const items = focusableElements(this.host.nativeElement);
      const index = items.indexOf(target);
      if (index < 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length].focus();
    }
  }
}
