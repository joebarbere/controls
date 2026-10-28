import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, inject, input, model, output } from '@angular/core';
import { Button, focusableElements } from '@controls/ui';
import {
  type ArgErrors,
  type ArgField,
  type ArgForm,
  type EnumField,
  isOptionalObject,
  numberHint,
  type NumberField,
} from './arg-form';

let nextFormId = 0;

/** An entity the form can offer for an entity-reference field. */
export interface EntityChoice {
  readonly id: number;
  readonly label: string;
}

/**
 * Renders a command's generated argument form (see `buildArgForm`). Presentational: it edits
 * `values` and reports `runCommand` / `goBack`; the palette validates with the command's schema and
 * passes the inline `errors` back.
 *
 * Keyboard: Tab or ↑/↓ move between fields (↑/↓ except in a `<select>`, which uses them to choose),
 * Enter runs, Enter or Space toggles a checkbox, Escape goes back to the command list.
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
  readonly values = model.required<Readonly<Record<string, string | boolean>>>();
  readonly errors = input<ArgErrors>({ fields: {}, form: [] });
  /** The selected world entity, offered by entity-reference fields. */
  readonly selectedEntity = input<EntityChoice | null>(null);
  /** Entities in the world, suggested by entity-reference fields. */
  readonly entities = input<readonly EntityChoice[]>([]);
  /** Emitted when the player runs the form (Enter or the Run button). */
  readonly runCommand = output<void>();
  /** Emitted on Escape or the Back button. */
  readonly goBack = output<void>();

  protected readonly prefix = `ctl-palette-arg-${nextFormId++}`;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

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
      if (field.ref === 'entity') {
        const selected = this.selectedEntity();
        parts.push(selected ? `Selected: ${selected.id} (${selected.label})` : 'Nothing selected');
      }
    }
    if (field.description) parts.push(field.description);
    if (!field.required && field.defaultValue === undefined && field.kind !== 'object') parts.push('Optional');
    return parts.length > 0 ? parts.join('. ') : null;
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

  protected inputMode(field: NumberField): string {
    return field.integer ? 'numeric' : 'decimal';
  }

  protected readonly isOptionalObject = isOptionalObject;

  /** Types the recursive template's context (`ngTemplateOutlet` contexts are untyped). */
  protected fieldsOf(fields: unknown): readonly ArgField[] {
    return fields as readonly ArgField[];
  }

  protected set(field: ArgField, value: string | boolean): void {
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
    if (event.key === 'Enter' && target instanceof HTMLInputElement && target.type === 'checkbox') {
      event.preventDefault();
      target.click();
      return;
    }
    if (event.key === 'Enter' && target instanceof HTMLSelectElement) {
      event.preventDefault(); // a <select> doesn't submit on Enter by itself
      target.form?.requestSubmit();
      return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && target.tagName !== 'SELECT') {
      const items = focusableElements(this.host.nativeElement);
      const index = items.indexOf(target);
      if (index < 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length].focus();
    }
  }
}
