import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { chordFromEvent, inputChordFromEvent, type ResolvedBinding } from '@controls/commands';
import { KeybindingService } from '@controls/feature-session';
import { Button } from '@controls/ui';

interface Row {
  readonly id: string;
  readonly title: string;
  readonly isInput: boolean;
  readonly keys: readonly string[];
  readonly customised: boolean;
  readonly conflicts: readonly string[];
  readonly invalid: string | null;
}

interface Group {
  readonly category: string;
  readonly rows: readonly Row[];
}

/**
 * The rebinding table (plan F1.4): every command binding and input action with its keys, grouped
 * by category. Change captures the next key press; Escape cancels and Tab leaves (both reserved).
 * Conflicts are listed on every binding involved and summarised at the top, never silently
 * shadowed. Unbind and Reset act on one binding; Reset all restores every default.
 *
 * Buttons that have nothing to do use `aria-disabled` rather than `disabled`, so focus never drops
 * to the page when a button turns inactive under it.
 */
@Component({
  selector: 'ctl-keybindings-editor',
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="summary" [class.has-conflicts]="conflictCount() > 0" data-testid="keybinding-conflicts">
      @if (conflictCount() === 0) {
        No conflicts.
      } @else {
        {{ conflictCount() === 1 ? '1 conflict' : conflictCount() + ' conflicts' }}: the same keys are bound to more
        than one action. Change or unbind one of each pair.
      }
    </p>
    <p class="ctl-visually-hidden" role="status" aria-live="polite">{{ status() }}</p>
    @for (group of groups(); track group.category) {
      <table>
        <caption>
          {{
            group.category
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col">Keys</th>
            <th scope="col"><span class="ctl-visually-hidden">Change</span></th>
          </tr>
        </thead>
        <tbody>
          @for (row of group.rows; track row.id) {
            <tr [attr.data-binding]="row.id" [class.conflicted]="row.conflicts.length > 0">
              <th scope="row">{{ row.title }}</th>
              <td>
                <span class="keys" [attr.data-testid]="'keys-' + row.id">
                  @for (key of row.keys; track $index) {
                    <kbd>{{ key }}</kbd>
                  } @empty {
                    <span class="muted">Unbound</span>
                  }
                </span>
                @if (row.conflicts.length > 0 || row.invalid) {
                  <span class="problem" [id]="'ctl-kb-problem-' + row.id">
                    @for (conflict of row.conflicts; track $index) {
                      <span class="line">Conflicts with {{ conflict }}</span>
                    }
                    @if (row.invalid) {
                      <span class="line">{{ row.invalid }}</span>
                    }
                  </span>
                }
              </td>
              <td class="actions">
                <button
                  ctlButton
                  type="button"
                  [attr.aria-label]="(capturing() === row.id ? 'Press new keys for ' : 'Change ') + row.title"
                  [attr.aria-pressed]="capturing() === row.id"
                  [attr.aria-describedby]="row.conflicts.length > 0 || row.invalid ? 'ctl-kb-problem-' + row.id : null"
                  (click)="startCapture(row.id)"
                  (keydown)="capture($event, row)"
                  (blur)="stopCapture(row.id)"
                >
                  {{ capturing() === row.id ? 'Press keys…' : 'Change' }}
                </button>
                <button
                  ctlButton="ghost"
                  type="button"
                  [attr.aria-label]="'Unbind ' + row.title"
                  [attr.aria-disabled]="row.keys.length === 0"
                  (click)="unbind(row)"
                >
                  Unbind
                </button>
                <button
                  ctlButton="ghost"
                  type="button"
                  [attr.aria-label]="'Reset ' + row.title"
                  [attr.aria-disabled]="!row.customised"
                  (click)="reset(row)"
                >
                  Reset
                </button>
              </td>
            </tr>
          }
        </tbody>
      </table>
    }
    <button ctlButton type="button" class="reset-all" [attr.aria-disabled]="!keys.customised()" (click)="resetAll()">
      Reset all bindings
    </button>
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--ctl-space-4);
    }
    .summary {
      margin: 0;
      color: var(--ctl-fg-muted);
    }
    .summary.has-conflicts,
    .problem {
      color: var(--ctl-warning);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    caption {
      padding-bottom: var(--ctl-space-1);
      font-weight: 600;
      text-align: start;
    }
    th,
    td {
      padding: var(--ctl-space-1) var(--ctl-space-2);
      border-top: 1px solid var(--ctl-border);
      text-align: start;
      vertical-align: top;
    }
    thead th {
      border-top: none;
      color: var(--ctl-fg-muted);
      font-weight: 400;
    }
    tbody th {
      font-weight: 400;
    }
    .keys {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ctl-space-1);
    }
    kbd {
      padding: 0 var(--ctl-space-1);
      border: 1px solid var(--ctl-border);
      border-radius: var(--ctl-radius);
      background: var(--ctl-surface-raised);
      font: inherit;
      font-size: 0.9em;
    }
    .muted {
      color: var(--ctl-fg-muted);
    }
    .problem {
      display: grid;
      margin-top: var(--ctl-space-1);
      font-size: 0.85em;
    }
    tr.conflicted th {
      box-shadow: inset 3px 0 0 var(--ctl-warning);
    }
    .actions {
      white-space: nowrap;
    }
    .reset-all {
      justify-self: start;
    }
  `,
})
export class KeybindingsEditor {
  protected readonly keys = inject(KeybindingService);
  /** Binding id waiting for a key press, if any. */
  protected readonly capturing = signal<string | null>(null);
  protected readonly status = signal('');

  protected readonly conflictCount = computed(() => this.keys.keymap().conflicts.length);

  protected readonly groups = computed<Group[]>(() => {
    const keymap = this.keys.keymap();
    const groups = new Map<string, Row[]>();
    for (const binding of keymap.bindings) {
      const rows = groups.get(binding.decl.category) ?? [];
      rows.push(this.row(binding));
      groups.set(binding.decl.category, rows);
    }
    return [...groups].map(([category, rows]) => ({ category, rows }));
  });

  protected startCapture(id: string): void {
    this.capturing.set(this.capturing() === id ? null : id);
    if (this.capturing() === id) this.status.set('Press the new keys. Escape cancels.');
  }

  protected stopCapture(id: string): void {
    if (this.capturing() === id) this.capturing.set(null);
  }

  /** While capturing, the next key press becomes the binding. Nothing else sees it. */
  protected capture(event: KeyboardEvent, row: Row): void {
    if (this.capturing() !== row.id) return;
    if (event.key === 'Tab') {
      this.capturing.set(null); // Tab is reserved: let it move focus
      return;
    }
    event.preventDefault();
    event.stopPropagation(); // not the dialog's Escape, not the keybinding service
    if (event.key === 'Escape') {
      this.capturing.set(null);
      this.status.set(`Kept the keys for ${row.title}.`);
      return;
    }
    if (event.repeat) return;
    const chord = row.isInput ? inputChordFromEvent(event) : chordFromEvent(event, this.keys.platform);
    if (chord === null) {
      if (!row.isInput && /^(Shift|Control|Alt|Meta)/.test(event.code)) return; // a modifier: wait for the key
      this.status.set('That key can’t be bound.');
      return;
    }
    const result = this.keys.setBinding(row.id, chord);
    this.capturing.set(null);
    if (!result.ok) {
      this.status.set(`Not bound: ${result.error}.`);
      return;
    }
    const conflicts = this.keys.keymap().conflictsOf(row.id).length;
    this.status.set(
      `${row.title}: ${this.keys.label(result.chord ?? chord)}.` +
        (conflicts > 0 ? ` It conflicts with ${conflicts === 1 ? 'another binding' : `${conflicts} bindings`}.` : ''),
    );
  }

  protected unbind(row: Row): void {
    if (row.keys.length === 0) return;
    this.keys.setBinding(row.id, null);
    this.status.set(`${row.title} is unbound.`);
  }

  protected reset(row: Row): void {
    if (!row.customised) return;
    this.keys.reset(row.id);
    this.status.set(`${row.title} is back to its default.`);
  }

  protected resetAll(): void {
    if (!this.keys.customised()) return;
    this.keys.resetAll();
    this.status.set('Every binding is back to its default.');
  }

  private row(binding: ResolvedBinding): Row {
    const keymap = this.keys.keymap();
    const conflicts = keymap.conflictsOf(binding.id).map((c) => {
      const otherId = c.first === binding.id ? c.second : c.first;
      return `${keymap.get(otherId)?.decl.title ?? otherId} on ${this.keys.label(c.chord)}`;
    });
    const invalid = keymap.invalid.find((i) => i.id === binding.id);
    return {
      id: binding.id,
      title: binding.decl.title,
      isInput: binding.decl.target.kind === 'input',
      keys: binding.chords.map((c) => this.keys.label(c)),
      customised: binding.source === 'user' || invalid !== undefined,
      conflicts,
      invalid: invalid ? `Saved keys ignored: ${invalid.reason}` : null,
    };
  }
}
