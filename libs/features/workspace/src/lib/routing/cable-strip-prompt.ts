import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  linkedSignal,
  output,
  untracked,
} from '@angular/core';
import { Button, Dialog } from '@controls/ui';
import type { CableStripArgs } from '@controls/world-model';
import { type StripDraft, stripArgs, stripDraftProblems, type StripRequest } from './wiring-model';

/** An open strip prompt: the request and the command's last refusal, in words, else `null`. */
export interface StripPrompt {
  readonly request: StripRequest;
  readonly refusal: string | null;
}

let nextId = 0;

/**
 * The strip prompt (F3.2 part 4): a modal `ctl-dialog` asking how much jacket to strip at each end of a
 * cable, and with which cable stripper. Each filled-in end becomes one `cable.strip` (the flow checks
 * them with the command's own `run` and logs them); a blank end is left as it is. The hint under each
 * length says the tail and the most a box end allows (6.35 mm of sheath stays inside, NFPA 70 Art.
 * 314.17 by number); a refusal (`strip-too-long`, `cannot-unstrip`, `wrong-tool`) is an alert inside the
 * dialog until the draft changes. Escape or Cancel strips nothing. Lengths are `type="text"` with
 * `inputmode` (see the termination prompt), and Enter strips.
 */
@Component({
  selector: 'ctl-cable-strip-prompt',
  imports: [Dialog, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-dialog [heading]="heading()" [description]="description()" [(open)]="open" (closed)="onClosed()">
      @if (request(); as r) {
        <form class="form" novalidate data-testid="strip-prompt" (submit)="submit($event)">
          <div class="ctl-field">
            <label [for]="id('tool')">Cable stripper</label>
            <select
              class="ctl-input"
              [id]="id('tool')"
              [attr.aria-invalid]="invalid('tool')"
              (change)="set('tool', $event)"
            >
              <option value="" [selected]="draft().tool === null">Choose…</option>
              @for (t of r.strippers; track t.key) {
                <option [value]="t.key" [selected]="t.key === draft().tool">{{ t.label }}</option>
              }
            </select>
          </div>
          @for (e of r.ends; track e.end) {
            <div class="ctl-field">
              <label [for]="id(e.end)">End {{ e.end }}: jacket to strip (mm)</label>
              <input
                class="ctl-input"
                type="text"
                inputmode="numeric"
                spellcheck="false"
                autocomplete="off"
                [id]="id(e.end)"
                [value]="draft()[e.end]"
                [attr.aria-invalid]="invalid(e.end)"
                [attr.aria-describedby]="id(e.end + '-hint')"
                (input)="set(e.end, $event)"
              />
              <p class="ctl-hint" [id]="id(e.end + '-hint')">{{ hint(e) }}</p>
            </div>
          }
          <p class="message" role="alert" data-testid="strip-message">{{ message() }}</p>
          <button type="submit" class="ctl-visually-hidden" tabindex="-1" aria-hidden="true">Strip</button>
        </form>
      }
      <button ctlButton type="button" ctlDialogActions (click)="open.set(false)">Cancel</button>
      <button ctlButton="primary" type="button" ctlDialogActions (click)="submit()">Strip</button>
    </ctl-dialog>
  `,
  styles: `
    .form {
      display: grid;
      gap: var(--ctl-space-3);
      min-width: min(420px, calc(100vw - 96px));
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
export class CableStripPromptDialog {
  readonly prompt = input<StripPrompt | null>(null);
  /** One `cable.strip` per filled-in end (the flow checks and logs them). */
  readonly confirm = output<CableStripArgs[]>();
  /** Escape or Cancel: nothing is stripped. */
  readonly dismissed = output<void>();

  private readonly uid = `ctl-strip-${nextId++}`;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly request = computed(() => this.prompt()?.request ?? null);
  protected readonly open = linkedSignal(() => this.request() !== null);
  protected readonly draft = linkedSignal<StripDraft | null, StripDraft>({
    source: () => this.request()?.draft ?? null,
    computation: (d) => d ?? { tool: null, a: '', b: '' },
  });
  private readonly attempted = linkedSignal<unknown, boolean>({ source: this.request, computation: () => false });
  private readonly refusedDraft = linkedSignal<StripPrompt | null, StripDraft>({
    source: this.prompt,
    computation: () => untracked(this.draft),
  });

  protected readonly heading = computed(() => {
    const r = this.request();
    return r ? `Strip cable ${r.cableId}` : 'Strip';
  });
  protected readonly description = computed(() => this.request()?.cableTitle ?? '');
  private readonly problems = computed(() => {
    const r = this.request();
    return r ? stripDraftProblems(r, this.draft()) : [];
  });
  protected readonly message = computed(() => {
    if (this.attempted() && this.problems().length > 0) return this.problems()[0].message;
    const refusal = this.prompt()?.refusal ?? null;
    return refusal !== null && this.refusedDraft() === this.draft() ? `Refused: ${refusal}` : '';
  });

  protected id(field: string): string {
    return `${this.uid}-${field}`;
  }

  protected invalid(field: string): 'true' | null {
    return this.attempted() && this.problems().some((p) => p.field === field) ? 'true' : null;
  }

  protected hint(e: StripRequest['ends'][number]): string {
    const done = e.strippedMm > 0 ? ` ${e.strippedMm} mm already stripped.` : '';
    if (e.place === 'free') return `Free end, ${e.tailMm} mm tail.${done} Leave blank to keep it.`;
    return (
      `${e.tailMm} mm tail ${e.place}: strip at most ${e.maxMm} mm (6.35 mm of sheath stays inside the box).` +
      `${done} Leave blank to keep it.`
    );
  }

  protected set(field: keyof StripDraft, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    this.draft.update((d) => ({ ...d, [field]: field === 'tool' ? (value === '' ? null : value) : value }));
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    const r = this.request();
    if (!r) return;
    const problems = this.problems();
    if (problems.length > 0) {
      this.attempted.set(true);
      const field = problems[0].field;
      afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`[id="${this.id(field)}"]`)?.focus(), {
        injector: this.injector,
      });
      return;
    }
    const args = stripArgs(r, this.draft());
    if (args !== null) this.confirm.emit(args);
  }

  protected onClosed(): void {
    if (this.request() !== null) this.dismissed.emit();
  }
}
