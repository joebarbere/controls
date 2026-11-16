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
import { awgName, type TerminalMethodSpec } from '@controls/catalog';
import { Button, Dialog } from '@controls/ui';
import type { TerminationArgs } from '@controls/world-model';
import type { TerminationPrompt } from './routing-flow';
import {
  accessoryChoices,
  argsOf,
  drivesName,
  driverTorque,
  type FieldProblem,
  hasTorqueStep,
  methodName,
  methodOf,
  refKey,
  sizeName,
  stripProblems,
  type TerminationDraft,
  torqueProblems,
} from './termination-model';

let nextId = 0;

const STRANDING_NAMES: Readonly<Record<string, string>> = {
  solid: 'solid',
  stranded: 'stranded',
  strandedFerrule: 'stranded in a ferrule',
};

/** `Takes 22–10 AWG: solid, stranded or stranded in a ferrule.` */
function takes(spec: TerminalMethodSpec): string {
  const kinds = spec.stranding.map((s) => STRANDING_NAMES[s] ?? s);
  const list = kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} or ${kinds.at(-1)}` : (kinds[0] ?? '');
  return `Takes ${awgName(spec.awgRange.smallest)}–${awgName(spec.awgRange.largest)} AWG: ${list}.`;
}

/**
 * One end's termination prompt (F3.3 part 2, D9): a modal `ctl-dialog` with two steps, **strip and
 * finish** (method, stripper and hole, strip length, an optional ferrule or lug with the crimper's die)
 * and, for a method tightened to a torque, **tighten** (the driver and its setting; a plain screwdriver
 * has none, and the command draws its spread). Apprentice opens with every field filled from
 * `suggestTermination`; Journeyman and Realistic with only the tools in hand.
 *
 * The two number fields are `type="text"` with an `inputmode`: a `type="number"` field reports `''`
 * for an intermediate `0.`, which the `[value]` binding then wrote back mid-typing (`0.6` became `60`).
 * The model validates the text (`stripProblems`, `torqueProblems`).
 *
 * Keyboard-first: focus starts on the first field and moves to the first field of each step, Enter in
 * a text field goes on, Escape (or Cancel) dismisses it and focus returns to the canvas. Blank fields
 * and the command's refusal of a draft (`wrong-tool`, `gauge-out-of-range`, `beyond-tool-capacity`, …)
 * are an alert inside the dialog (a live region outside a modal dialog is inert). The prompt never
 * shows the outcome: it emits arguments, the flow checks and logs them.
 */
@Component({
  selector: 'ctl-termination-prompt',
  imports: [Dialog, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-dialog [heading]="heading()" [description]="description()" [(open)]="open" (closed)="onClosed()">
      @if (request(); as r) {
        <form class="form" novalidate data-testid="termination-prompt" (submit)="submit($event)">
          <p class="ctl-visually-hidden" role="status" aria-live="polite">{{ stepStatus() }}</p>
          @if (r.note) {
            <p class="ctl-hint">{{ r.note }}</p>
          }
          @if (step() === 'strip') {
            <div class="ctl-field">
              <label [for]="id('method')">Method</label>
              <select
                class="ctl-input"
                [id]="id('method')"
                [attr.aria-invalid]="invalid('method')"
                [attr.aria-describedby]="id('method-hint')"
                (change)="set('method', $event)"
              >
                <option value="" [selected]="draft().method === null">Choose…</option>
                @for (m of r.methods; track m.method) {
                  <option [value]="m.method" [selected]="m.method === draft().method">
                    {{ methodLabel(m.method) }}
                  </option>
                }
              </select>
              <p class="ctl-hint" [id]="id('method-hint')">{{ methodHint() }}</p>
            </div>
            <div class="ctl-field">
              <label [for]="id('stripTool')">Stripper</label>
              <select
                class="ctl-input"
                [id]="id('stripTool')"
                [attr.aria-invalid]="invalid('stripTool')"
                (change)="set('stripTool', $event)"
              >
                <option value="" [selected]="draft().stripTool === null">Choose…</option>
                @for (t of r.strippers; track t.key) {
                  <option [value]="t.key" [selected]="t.key === draft().stripTool">{{ t.label }}</option>
                }
              </select>
            </div>
            <div class="ctl-field">
              <label [for]="id('hole')">Strip hole</label>
              <select
                class="ctl-input"
                [id]="id('hole')"
                [attr.aria-invalid]="invalid('hole')"
                [attr.aria-describedby]="id('hole-hint')"
                (change)="set('hole', $event)"
              >
                <option value="" [selected]="draft().hole === null">Choose…</option>
                @for (h of holes(); track h.id) {
                  <option [value]="h.id" [selected]="h.id === draft().hole">{{ holeLabel(h.awg, h.stranding) }}</option>
                }
              </select>
              <p class="ctl-hint" [id]="id('hole-hint')">The conductor is {{ r.conductorSize }}.</p>
            </div>
            <div class="ctl-field">
              <label [for]="id('stripLengthMm')">Strip length (mm)</label>
              <input
                class="ctl-input"
                type="text"
                inputmode="numeric"
                spellcheck="false"
                autocomplete="off"
                [id]="id('stripLengthMm')"
                [value]="draft().stripLengthMm"
                [attr.aria-invalid]="invalid('stripLengthMm')"
                [attr.aria-describedby]="id('strip-hint')"
                (input)="set('stripLengthMm', $event)"
              />
              <p class="ctl-hint" [id]="id('strip-hint')">{{ stripHint() }}</p>
            </div>
            <div class="ctl-field">
              <label [for]="id('accessory')">Ferrule or lug</label>
              <select
                class="ctl-input"
                [id]="id('accessory')"
                [attr.aria-invalid]="invalid('accessory')"
                (change)="set('accessory', $event)"
              >
                <option value="none" [selected]="draft().accessory === 'none'">None (bare conductor)</option>
                @for (a of accessories(); track a.id + a.version) {
                  <option [value]="key(a)" [selected]="key(a) === draft().accessory">{{ a.title }}</option>
                }
              </select>
            </div>
            @if (draft().accessory !== 'none') {
              <div class="ctl-field">
                <label [for]="id('crimpTool')">Crimper</label>
                <select
                  class="ctl-input"
                  [id]="id('crimpTool')"
                  [attr.aria-invalid]="invalid('crimpTool')"
                  (change)="set('crimpTool', $event)"
                >
                  <option value="" [selected]="draft().crimpTool === null">Choose…</option>
                  @for (t of r.crimpers; track t.key) {
                    <option [value]="t.key" [selected]="t.key === draft().crimpTool">{{ t.label }}</option>
                  }
                </select>
              </div>
              <div class="ctl-field">
                <label [for]="id('die')">Crimp die</label>
                <select
                  class="ctl-input"
                  [id]="id('die')"
                  [attr.aria-invalid]="invalid('die')"
                  (change)="set('die', $event)"
                >
                  <option value="" [selected]="draft().die === null">Choose…</option>
                  @for (d of dies(); track d.id) {
                    <option [value]="d.id" [selected]="d.id === draft().die">{{ d.label }}</option>
                  }
                </select>
              </div>
            }
          } @else {
            <div class="ctl-field">
              <label [for]="id('driver')">Screwdriver</label>
              <select
                class="ctl-input"
                [id]="id('driver')"
                [attr.aria-invalid]="invalid('driver')"
                [attr.aria-describedby]="id('driver-hint')"
                (change)="set('driver', $event)"
              >
                <option value="" [selected]="draft().driver === null">Choose…</option>
                @for (t of r.drivers; track t.key) {
                  <option [value]="t.key" [selected]="t.key === draft().driver">{{ t.label }}</option>
                }
              </select>
              <p class="ctl-hint" [id]="id('driver-hint')">{{ screwHint() }}</p>
            </div>
            @if (torqueRange(); as range) {
              <div class="ctl-field">
                <label [for]="id('torqueNm')">Torque setting (N·m)</label>
                <input
                  class="ctl-input"
                  type="text"
                  inputmode="decimal"
                  spellcheck="false"
                  autocomplete="off"
                  [id]="id('torqueNm')"
                  [value]="draft().torqueNm"
                  [attr.aria-invalid]="invalid('torqueNm')"
                  [attr.aria-describedby]="id('torque-hint')"
                  (input)="set('torqueNm', $event)"
                />
                <p class="ctl-hint" [id]="id('torque-hint')">
                  This driver sets {{ range.minNm }}–{{ range.maxNm }} N·m.
                </p>
              </div>
            } @else if (draft().driver !== null) {
              <p class="ctl-hint">No torque setting: this screwdriver is tightened by feel.</p>
            }
          }
          <p class="message" role="alert" data-testid="termination-message">{{ message() }}</p>
          <button type="submit" class="ctl-visually-hidden" tabindex="-1" aria-hidden="true">Next</button>
        </form>
      }
      <button ctlButton type="button" ctlDialogActions (click)="open.set(false)">Cancel</button>
      @if (step() === 'torque') {
        <button ctlButton type="button" ctlDialogActions (click)="back()">Back</button>
      }
      <button ctlButton="primary" type="button" ctlDialogActions (click)="submit()">
        {{ finalStep() ? 'Land end ' + (request()?.end ?? '') : 'Next' }}
      </button>
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
export class TerminationPromptDialog {
  /** The prompt to show, or `null` (closed). */
  readonly prompt = input<TerminationPrompt | null>(null);
  /** The filled-in arguments (the flow checks them as the command would, then logs the route). */
  readonly confirm = output<TerminationArgs>();
  /** Escape or Cancel: the pick is not taken. */
  readonly dismissed = output<void>();

  private readonly uid = `ctl-term-${nextId++}`;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly request = computed(() => this.prompt()?.request ?? null);
  protected readonly open = linkedSignal(() => this.request() !== null);
  /** The form values; reset by each new request. */
  protected readonly draft = linkedSignal<TerminationDraft | null, TerminationDraft>({
    source: () => this.request()?.draft ?? null,
    computation: (d) =>
      d ?? {
        method: null,
        stripTool: null,
        hole: null,
        stripLengthMm: '',
        accessory: 'none',
        crimpTool: null,
        die: null,
        driver: null,
        torqueNm: '',
      },
  });
  protected readonly step = linkedSignal<unknown, 'strip' | 'torque'>({
    source: this.request,
    computation: () => 'strip',
  });
  /** Whether the step's blank fields are shown (after a Next or Land with some). */
  private readonly attempted = linkedSignal<unknown, boolean>({
    source: () => [this.request(), this.step()],
    computation: () => false,
  });
  /**
   * The draft as it was when the prompt last changed (a new refusal arrives as a new prompt object):
   * the refusal shows until the player edits the draft.
   */
  private readonly refusedDraft = linkedSignal<TerminationPrompt | null, TerminationDraft>({
    source: this.prompt,
    computation: () => untracked(this.draft),
  });

  protected readonly heading = computed(() => {
    const r = this.request();
    if (!r) return 'Terminate';
    return `End ${r.end}: ${this.step() === 'strip' ? 'strip and finish' : 'tighten'}`;
  });
  protected readonly description = computed(() => {
    const r = this.request();
    return r ? `${r.conductorTitle} (${r.conductorSize}) onto ${r.terminalTitle}.` : '';
  });
  private readonly method = computed(() => {
    const r = this.request();
    return r ? methodOf(r, this.draft()) : undefined;
  });
  protected readonly finalStep = computed(() => {
    const r = this.request();
    return this.step() === 'torque' || !r || !hasTorqueStep(r, this.draft());
  });
  protected readonly stepStatus = computed(() => {
    const r = this.request();
    if (!r) return '';
    const total = hasTorqueStep(r, this.draft()) ? 2 : 1;
    return this.step() === 'strip'
      ? `End ${r.end}, step 1 of ${total}: strip and finish.`
      : `End ${r.end}, step 2 of 2: tighten.`;
  });
  protected readonly methodHint = computed(() => {
    const m = this.method();
    return m ? takes(m.spec) : 'Choose how the conductor lands on the terminal.';
  });
  protected readonly stripHint = computed(() => {
    const m = this.method();
    return m
      ? `The terminal is marked for ${m.spec.stripLengthMm.nominal} mm (±${m.spec.stripLengthMm.tolerance}).`
      : 'Choose a method to see the terminal’s strip length.';
  });
  protected readonly screwHint = computed(() => {
    const m = this.method();
    if (!m) return '';
    const marked = m.spec.torqueNm === null ? 'no marked torque' : `marked ${m.spec.torqueNm} N·m`;
    return `The screw takes ${drivesName(m.spec.drives)}, ${marked}.`;
  });
  protected readonly holes = computed(() => {
    const r = this.request();
    return r?.strippers.find((t) => t.key === this.draft().stripTool)?.tool.holes ?? [];
  });
  protected readonly dies = computed(() => {
    const r = this.request();
    return r?.crimpers.find((t) => t.key === this.draft().crimpTool)?.tool.dies ?? [];
  });
  protected readonly accessories = computed(() => {
    const r = this.request();
    return r ? accessoryChoices(r, this.draft()) : [];
  });
  protected readonly torqueRange = computed(() => {
    const r = this.request();
    return r ? driverTorque(r, this.draft()) : null;
  });
  private readonly problems = computed<FieldProblem[]>(() => {
    const r = this.request();
    if (!r) return [];
    return this.step() === 'strip' ? stripProblems(r, this.draft()) : torqueProblems(r, this.draft());
  });
  protected readonly message = computed(() => {
    if (this.attempted() && this.problems().length > 0) return this.problems()[0].message;
    const refusal = this.prompt()?.refusal ?? null;
    return refusal !== null && this.refusedDraft() === this.draft() ? `Refused: ${refusal}` : '';
  });

  protected id(field: string): string {
    return `${this.uid}-${field}`;
  }

  protected invalid(field: keyof TerminationDraft): 'true' | null {
    return this.attempted() && this.problems().some((p) => p.field === field) ? 'true' : null;
  }

  protected methodLabel(method: string): string {
    return methodName(method);
  }

  protected holeLabel(awg: number, stranding: string): string {
    return sizeName(awg, stranding);
  }

  protected key(a: { id: string; version: number }): string {
    return refKey(a);
  }

  protected set(field: keyof TerminationDraft, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    const text = field === 'stripLengthMm' || field === 'torqueNm' || field === 'accessory';
    this.draft.update((d) => ({ ...d, [field]: text ? value : value === '' ? null : value }));
  }

  protected back(): void {
    this.step.set('strip');
    this.focusFirst();
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    const r = this.request();
    if (!r) return;
    const problems = this.problems();
    if (problems.length > 0) {
      this.attempted.set(true);
      this.focus(problems[0].field);
      return;
    }
    if (!this.finalStep()) {
      this.step.set('torque');
      this.focusFirst();
      return;
    }
    const args = argsOf(r, this.draft());
    if (args === null) return;
    this.confirm.emit(args);
  }

  protected onClosed(): void {
    if (this.request() !== null) this.dismissed.emit();
  }

  private focus(field: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`#${this.id(field)}`)?.focus(), {
      injector: this.injector,
    });
  }

  private focusFirst(): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('form select, form input')?.focus(), {
      injector: this.injector,
    });
  }
}
