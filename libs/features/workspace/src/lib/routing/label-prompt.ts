import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Button, Dialog } from '@controls/ui';
import { type LabelDraft, type LabelRequest, labelCommand } from './wiring-model';

/** An open label prompt: the request and the command's last refusal, in words, else `null`. */
export interface LabelPrompt {
  readonly request: LabelRequest;
  readonly refusal: string | null;
}

/** What the label prompt asks the flow to log. */
export type LabelConfirm = Extract<ReturnType<typeof labelCommand>, { ok: true }>;

let nextId = 0;

/**
 * The label-maker prompt (F3.2 part 4): a small modal `ctl-dialog` with the label text and the label
 * maker (the default-tool rule's, changeable). Print emits one `wire.label` or `cable.label` for the
 * flow to check with the command's own `run` and log; with a label already printed, an empty text
 * removes it. A refusal (`wrong-tool`, bad text) is an alert inside the dialog until the draft changes.
 */
@Component({
  selector: 'ctl-label-prompt',
  imports: [Dialog, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-dialog [heading]="heading()" [description]="description()" [(open)]="open" (closed)="onClosed()">
      @if (request(); as r) {
        <form class="form" novalidate data-testid="label-prompt" (submit)="submit($event)">
          <div class="ctl-field">
            <label [for]="id('text')">Label text</label>
            <input
              class="ctl-input"
              type="text"
              spellcheck="false"
              autocomplete="off"
              maxlength="32"
              [id]="id('text')"
              [value]="draft().text"
              [attr.aria-invalid]="problem()?.field === 'text' ? 'true' : null"
              [attr.aria-describedby]="id('text-hint')"
              (input)="set('text', $event)"
            />
            <p class="ctl-hint" [id]="id('text-hint')">
              Up to 32 printable characters.
              @if (r.current !== null) {
                Now “{{ r.current }}”; clear it to remove the label.
              }
            </p>
          </div>
          <div class="ctl-field">
            <label [for]="id('tool')">Label maker</label>
            <select
              class="ctl-input"
              [id]="id('tool')"
              [attr.aria-invalid]="problem()?.field === 'tool' ? 'true' : null"
              (change)="set('tool', $event)"
            >
              <option value="" [selected]="draft().tool === null">Choose…</option>
              @for (t of r.makers; track t.key) {
                <option [value]="t.key" [selected]="t.key === draft().tool">{{ t.label }}</option>
              }
            </select>
          </div>
          <p class="message" role="alert" data-testid="label-message">{{ message() }}</p>
          <button type="submit" class="ctl-visually-hidden" tabindex="-1" aria-hidden="true">Print</button>
        </form>
      }
      <button ctlButton type="button" ctlDialogActions (click)="open.set(false)">Cancel</button>
      <button ctlButton="primary" type="button" ctlDialogActions (click)="submit()">Print</button>
    </ctl-dialog>
  `,
  styles: `
    .form {
      display: grid;
      gap: var(--ctl-space-3);
      min-width: min(360px, calc(100vw - 96px));
    }
    .ctl-hint,
    .message {
      margin: 0;
    }
    .message {
      min-height: 1.4em;
      color: var(--ctl-danger);
    }
  `,
})
export class LabelPromptDialog {
  readonly prompt = input<LabelPrompt | null>(null);
  readonly confirm = output<LabelConfirm>();
  readonly dismissed = output<void>();

  private readonly uid = `ctl-label-${nextId++}`;
  protected readonly request = computed(() => this.prompt()?.request ?? null);
  protected readonly open = linkedSignal(() => this.request() !== null);
  protected readonly draft = linkedSignal<LabelDraft | null, LabelDraft>({
    source: () => this.request()?.draft ?? null,
    computation: (d) => d ?? { tool: null, text: '' },
  });
  private readonly attempted = signal(false);
  private readonly refusedDraft = linkedSignal<LabelPrompt | null, LabelDraft>({
    source: this.prompt,
    computation: () => untracked(this.draft),
  });

  protected readonly heading = computed(() => (this.request()?.current ? 'Relabel' : 'Label'));
  protected readonly description = computed(() => this.request()?.title ?? '');
  protected readonly problem = computed(() => {
    const r = this.request();
    if (!r || !this.attempted()) return null;
    const result = labelCommand(r, this.draft());
    return result.ok ? null : result.problem;
  });
  protected readonly message = computed(() => {
    const problem = this.problem();
    if (problem) return problem.message;
    const refusal = this.prompt()?.refusal ?? null;
    return refusal !== null && this.refusedDraft() === this.draft() ? `Refused: ${refusal}` : '';
  });

  protected id(field: string): string {
    return `${this.uid}-${field}`;
  }

  protected set(field: keyof LabelDraft, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    this.draft.update((d) => ({ ...d, [field]: field === 'tool' ? (value === '' ? null : value) : value }));
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    const r = this.request();
    if (!r) return;
    const result = labelCommand(r, this.draft());
    if (!result.ok) {
      this.attempted.set(true);
      return;
    }
    this.confirm.emit(result);
  }

  protected onClosed(): void {
    this.attempted.set(false);
    if (this.request() !== null) this.dismissed.emit();
  }
}
