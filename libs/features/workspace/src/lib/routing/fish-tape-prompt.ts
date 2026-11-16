import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Button, Dialog } from '@controls/ui';
import type { WirePullArgs } from '@controls/world-model';
import {
  atElbow,
  elbowsPassed,
  feedTape,
  MAX_PULL_ROWS,
  pullArgs,
  type PullRequest,
  type PullRow,
  pullRules,
  pullTrack,
  retractTape,
  startTape,
  type TapeEvent,
  type TapeState,
  twistTape,
} from './pull-model';

/** An open fish tape prompt: the request and the command's last refusal of it, in words, else `null`. */
export interface PullPrompt {
  readonly request: PullRequest;
  readonly refusal: string | null;
}

let nextId = 0;
const mm = (n: number): string => `${Math.ceil(n)} mm`;

/**
 * The fish tape prompt (F3.4 part 2, D10): a modal `ctl-dialog` in two steps.
 *
 * 1. **Setup**: the run (its length and bends, `pullRun`) against the tape's reach, a refusal from
 *    `checkPullReach` before any play, and the conductors to pull (a conductor and a colour per row,
 *    1–16 rows). "Feed the tape" checks the arguments with the command (`check`, the flow's
 *    `precheck`) and starts the game; at Trainee "Pull without feeding" skips it.
 * 2. **The minigame** (`pull-model`): a deterministic track of feeds and elbows. F or ↑ feeds, T twists
 *    the tape round an elbow, R or ↓ pulls it back; pushing into an elbow jams it, and at the
 *    difficulty's limit the tape kinks and the pull fails (nothing logged; Try again starts over).
 *    Through at the far end, P (or the button) pulls the conductors back: the prompt emits `confirm`
 *    with the same `wire.pull` arguments as a skip.
 *
 * Every step is announced in the dialog's own polite status (a live region outside a modal is inert);
 * a kink or a refusal is an alert. Nothing moves on its own: the tape bar steps with each key, and with
 * reduced motion (`reducedMotion`: the setting or the system's) it jumps without a transition. The
 * keys work while focus is anywhere in the game (buttons included), never in a select.
 */
@Component({
  selector: 'ctl-fish-tape-prompt',
  imports: [Dialog, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown)': 'onKey($event)' },
  template: `
    <ctl-dialog
      heading="Fish tape: pull conductors"
      [description]="description()"
      [(open)]="open"
      (closed)="onClosed()"
    >
      @if (request(); as r) {
        <div class="body" data-testid="fish-tape-prompt" [attr.data-phase]="phase()">
          <ul class="facts">
            <li data-testid="pull-run">{{ runLine() }}</li>
            <li data-testid="pull-tape">{{ tapeLine() }}</li>
          </ul>
          @if (phase() === 'setup') {
            <form class="form" novalidate (submit)="start($event)">
              <fieldset class="rows">
                <legend>Conductors to pull ({{ rows().length }} of at most {{ maxRows }})</legend>
                @for (row of rows(); track $index; let i = $index) {
                  <div class="row">
                    <div class="ctl-field">
                      <label [for]="id('conductor-' + i)">Conductor {{ i + 1 }}</label>
                      <select class="ctl-input" [id]="id('conductor-' + i)" (change)="setRow(i, 'conductor', $event)">
                        <option value="" [selected]="row.conductor === null">Choose…</option>
                        @for (c of r.conductors; track c.key) {
                          <option [value]="c.key" [selected]="c.key === row.conductor">{{ c.title }}</option>
                        }
                      </select>
                    </div>
                    <div class="ctl-field">
                      <label [for]="id('colour-' + i)">Colour {{ i + 1 }}</label>
                      <select class="ctl-input" [id]="id('colour-' + i)" (change)="setRow(i, 'colour', $event)">
                        <option value="" [selected]="row.colour === null">Choose…</option>
                        @for (c of coloursOf(row); track c.key) {
                          <option [value]="c.key" [selected]="c.key === row.colour">{{ c.label }}</option>
                        }
                      </select>
                    </div>
                    <button
                      ctlButton
                      type="button"
                      [attr.aria-label]="'Remove conductor ' + (i + 1)"
                      (click)="removeRow(i)"
                    >
                      Remove
                    </button>
                  </div>
                }
                <button ctlButton type="button" [disabled]="rows().length >= maxRows" (click)="addRow()">
                  Add conductor
                </button>
              </fieldset>
              <p class="message" role="alert" data-testid="pull-message">{{ setupMessage() }}</p>
              <div class="buttons">
                @if (rules().skip) {
                  <button ctlButton type="button" (click)="skip()">Pull without feeding</button>
                }
                <button ctlButton="primary" type="submit">Feed the tape</button>
              </div>
            </form>
          } @else if (tape(); as t) {
            <div class="game" role="group" aria-label="Fish tape" [attr.aria-describedby]="id('keys')">
              <p class="ctl-hint" [id]="id('keys')">
                F or ↑ feeds the tape, T twists it, R or ↓ pulls it back{{
                  t.phase === 'through' ? ', P pulls the conductors' : ''
                }}.
              </p>
              @if (rules().showElbows) {
                <ol class="track" aria-label="The run, end a to end b">
                  @for (s of t.track; track $index; let i = $index) {
                    <li [attr.data-state]="i < t.at ? 'passed' : i === t.at ? 'next' : null">
                      {{ s.kind === 'elbow' ? 'Elbow ' + (s.index + 1) + ' (90°)' : 'Straight'
                      }}{{ i < t.at ? ': passed' : i === t.at && t.phase === 'feeding' ? ': next' : '' }}
                    </li>
                  }
                </ol>
              }
              <label class="progress-label" [for]="id('progress')">Tape fed</label>
              <progress [id]="id('progress')" [value]="t.at" [max]="t.track.length">
                {{ t.at }} of {{ t.track.length }}
              </progress>
              <div class="bar" aria-hidden="true">
                <div class="fill" [class.still]="reducedMotion()" [style.width.%]="(100 * t.at) / t.track.length"></div>
              </div>
              <p data-testid="tape-position">{{ positionLine() }}</p>
              <div class="buttons">
                @switch (t.phase) {
                  @case ('feeding') {
                    <button
                      ctlButton="primary"
                      type="button"
                      data-game-focus
                      aria-keyshortcuts="F ArrowUp"
                      (click)="act('feed')"
                    >
                      Feed (F)
                    </button>
                    <button ctlButton type="button" aria-keyshortcuts="T" (click)="act('twist')">Twist (T)</button>
                    <button ctlButton type="button" aria-keyshortcuts="R ArrowDown" (click)="act('retract')">
                      Pull back (R)
                    </button>
                  }
                  @case ('through') {
                    <button ctlButton="primary" type="button" data-game-focus aria-keyshortcuts="P" (click)="pull()">
                      Pull the conductors (P)
                    </button>
                  }
                  @case ('kinked') {
                    <button ctlButton="primary" type="button" data-game-focus (click)="retry()">Try again</button>
                  }
                }
              </div>
              <p class="message" role="alert" data-testid="tape-alert">{{ gameAlert() }}</p>
            </div>
          }
          <p class="ctl-visually-hidden" role="status" aria-live="polite" data-testid="tape-status">{{ status() }}</p>
        </div>
      }
      <button ctlButton type="button" ctlDialogActions (click)="open.set(false)">Cancel</button>
    </ctl-dialog>
  `,
  styles: `
    .body,
    .form,
    .game {
      display: grid;
      gap: var(--ctl-space-3);
      min-width: min(420px, calc(100vw - 96px));
    }
    .facts {
      margin: 0;
      padding-left: 1.2em;
    }
    .rows {
      display: grid;
      gap: var(--ctl-space-2);
      margin: 0;
      padding: var(--ctl-space-3);
      border: 1px solid var(--ctl-border);
      border-radius: var(--ctl-radius);
    }
    .row {
      display: grid;
      grid-template-columns: minmax(12rem, 2fr) minmax(7rem, 1fr) auto;
      gap: var(--ctl-space-2);
      align-items: end;
    }
    .buttons {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ctl-space-2);
    }
    .track {
      margin: 0;
      padding-left: 1.6em;
    }
    .track li[data-state='passed'] {
      color: var(--ctl-fg-muted);
    }
    .track li[data-state='next'] {
      font-weight: 600;
    }
    .bar {
      height: 0.5rem;
      border: 1px solid var(--ctl-border);
      border-radius: var(--ctl-radius);
      overflow: hidden;
    }
    .fill {
      height: 100%;
      background: var(--ctl-fg);
      transition: width 150ms ease-out;
    }
    .fill.still {
      transition: none;
    }
    @media (prefers-reduced-motion: reduce) {
      .fill {
        transition: none;
      }
    }
    progress {
      width: 100%;
    }
    .message,
    .ctl-hint,
    p {
      margin: 0;
    }
    .message {
      min-height: 1.4em;
      color: var(--ctl-danger);
    }
  `,
})
export class FishTapePromptDialog {
  readonly prompt = input<PullPrompt | null>(null);
  /** Whether the tape bar jumps without a transition (settings `display.reducedMotion`, or the system's). */
  readonly reducedMotion = input(false);
  /** Checks arguments as `wire.pull` would now (the flow's `precheck`): its refusal in words, else `null`. */
  readonly check = input<(args: WirePullArgs) => string | null>(() => null);
  /** A successful pull (or a Trainee skip): the one `wire.pull` to log. */
  readonly confirm = output<WirePullArgs>();
  readonly dismissed = output<void>();

  protected readonly maxRows = MAX_PULL_ROWS;
  private readonly uid = `ctl-pull-${nextId++}`;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly request = computed(() => this.prompt()?.request ?? null);
  protected readonly open = linkedSignal(() => this.request() !== null);
  protected readonly rows = linkedSignal<PullRequest | null, readonly PullRow[]>({
    source: this.request,
    computation: (r) => (r ? r.rows.map((row) => ({ ...row })) : []),
  });
  protected readonly rules = computed(() => pullRules(this.request()?.difficulty ?? 'journeyman'));
  /** The game in play, or `null` in the setup step; every new prompt (a refusal included) goes back to setup. */
  protected readonly tape = linkedSignal<PullPrompt | null, TapeState | null>({
    source: this.prompt,
    computation: () => null,
  });
  /** The arguments the game was started with (what a success logs). */
  private args: WirePullArgs | null = null;
  protected readonly phase = computed(() => this.tape()?.phase ?? 'setup');
  /** The setup step's own problem (rows, the command's check), shown until the rows change. */
  private readonly problem = linkedSignal<readonly PullRow[], string | null>({
    source: this.rows,
    computation: () => null,
  });
  private readonly refusedRows = linkedSignal<PullPrompt | null, readonly PullRow[]>({
    source: this.prompt,
    computation: () => untracked(this.rows),
  });
  protected readonly status = signal('');
  /** Asks the render after this change to focus the game's main button. */
  private readonly focusGame = signal(0);

  protected readonly description = computed(() => {
    const r = this.request();
    if (!r) return '';
    const a = r.run.ends.a;
    const from = a ? ` from box #${a.enclosure}, entry ${a.entry}` : '';
    return `${r.run.title}${from}.`;
  });
  protected readonly runLine = computed(() => {
    const r = this.request();
    if (!r) return '';
    const elbows = r.reach.elbows.length;
    return `Run: ${mm(r.reach.lengthMm)} of conduit, ${elbows} elbow${elbows === 1 ? '' : 's'} (${r.reach.bendDeg}° of bends).`;
  });
  protected readonly tapeLine = computed(() => {
    const r = this.request();
    if (!r) return '';
    const reach = r.tool.pull;
    const limits = reach ? `: reaches ${mm(reach.lengthMm)} and ${reach.maxBendDeg}° of bends` : '';
    return `Tape: ${r.toolSource}${limits}.`;
  });
  protected readonly setupMessage = computed(() => {
    const own = this.problem();
    if (own) return own;
    const r = this.request();
    if (r?.refusal) return `Refused: ${r.refusal}`;
    const refusal = this.prompt()?.refusal ?? null;
    return refusal !== null && this.refusedRows() === this.rows() ? `Refused: ${refusal}` : '';
  });
  protected readonly positionLine = computed(() => {
    const t = this.tape();
    if (!t) return '';
    const r = this.rules();
    const jams =
      r.jamLimit === null ? `${t.jams} (it never kinks at Trainee)` : `${t.jams} of ${r.jamLimit} before it kinks`;
    const elbows = t.track.filter((s) => s.kind === 'elbow').length;
    return `Station ${t.at} of ${t.track.length}; round ${elbowsPassed(t)} of ${elbows} elbows; jams ${jams}.`;
  });
  protected readonly gameAlert = computed(() => {
    const t = this.tape();
    if (t?.phase !== 'kinked') return '';
    return `The tape kinked against a bend after ${t.jams} jam${t.jams === 1 ? '' : 's'}. Nothing was pulled. Try again, or Cancel.`;
  });

  constructor() {
    afterRenderEffect({
      write: () => {
        if (this.focusGame() === 0) return;
        untracked(() => this.host.nativeElement.querySelector<HTMLElement>('[data-game-focus]')?.focus());
      },
    });
  }

  protected id(field: string): string {
    return `${this.uid}-${field}`;
  }

  protected coloursOf(row: PullRow) {
    return this.request()?.conductors.find((c) => c.key === row.conductor)?.colours ?? [];
  }

  protected setRow(index: number, field: keyof PullRow, event: Event): void {
    const value = (event.target as HTMLSelectElement).value || null;
    this.rows.update((rows) =>
      rows.map((row, i) => {
        if (i !== index) return row;
        if (field === 'colour') return { ...row, colour: value };
        // A new conductor keeps the colour when it is made in it, else takes its first.
        const colours = this.request()?.conductors.find((c) => c.key === value)?.colours ?? [];
        const colour = colours.some((c) => c.key === row.colour) ? row.colour : (colours[0]?.key ?? null);
        return { conductor: value, colour };
      }),
    );
  }

  protected addRow(): void {
    const rows = this.rows();
    if (rows.length >= MAX_PULL_ROWS) return;
    const last = rows.at(-1) ?? this.request()?.rows[0] ?? { conductor: null, colour: null };
    this.rows.set([...rows, { ...last }]);
    this.status.set(`Conductor ${rows.length + 1} added.`);
  }

  protected removeRow(index: number): void {
    this.rows.update((rows) => rows.filter((_, i) => i !== index));
    this.status.set(`Conductor ${index + 1} removed; ${this.rows().length} left.`);
  }

  /** The arguments the rows make, checked by the command, or `null` with the problem shown. */
  private checked(): WirePullArgs | null {
    const r = this.request();
    if (!r) return null;
    if (r.refusal) {
      this.status.set(`Refused: ${r.refusal}`);
      return null;
    }
    const built = pullArgs(r, this.rows());
    const refusal = built.ok ? this.check()(built.args) : null;
    const problem = built.ok ? refusal && `Refused: ${refusal}` : built.message;
    if (problem) {
      this.problem.set(problem);
      return null;
    }
    return built.ok ? built.args : null;
  }

  protected start(event?: Event): void {
    event?.preventDefault();
    const args = this.checked();
    const r = this.request();
    if (!args || !r) return;
    this.args = args;
    const track = pullTrack(r.run);
    this.tape.set(startTape(track));
    const a = r.run.ends.a;
    this.status.set(
      `Feeding the tape in at end a${a ? ` (box #${a.enclosure}, entry ${a.entry})` : ''}: ` +
        `${track.length} station${track.length === 1 ? '' : 's'} to the far end. F feeds, T twists, R pulls back.`,
    );
    this.focusGame.update((n) => n + 1);
  }

  protected skip(): void {
    if (!this.rules().skip) return;
    const args = this.checked();
    if (args) this.confirm.emit(args);
  }

  protected act(key: 'feed' | 'twist' | 'retract'): void {
    const t = this.tape();
    if (!t) return;
    const rules = this.rules();
    const step = key === 'feed' ? feedTape(t, rules) : key === 'twist' ? twistTape(t) : retractTape(t);
    this.tape.set(step.state);
    this.status.set(this.say(step.event, step.state));
    if (step.state.phase !== t.phase) this.focusGame.update((n) => n + 1);
  }

  protected pull(): void {
    if (this.tape()?.phase !== 'through' || !this.args) return;
    this.confirm.emit(this.args);
  }

  protected retry(): void {
    const t = this.tape();
    if (!t) return;
    this.tape.set(startTape(t.track));
    this.status.set('The tape is back out. F feeds it in again.');
    this.focusGame.update((n) => n + 1);
  }

  private say(event: TapeEvent, s: TapeState): string {
    const where = `station ${s.at} of ${s.track.length}`;
    const show = this.rules().showElbows;
    const limit = this.rules().jamLimit;
    switch (event) {
      case 'fed':
        return `Fed: ${where}.`;
      case 'reachedElbow':
        return show
          ? `Fed: ${where}. Elbow ${elbowsPassed(s) + 1} ahead: twist (T) to get round it.`
          : `Fed: ${where}.`;
      case 'jammed':
        return (
          `The tape is jammed against a bend (${s.jams} jam${s.jams === 1 ? '' : 's'}` +
          `${limit === null ? '' : ` of ${limit}`}). Twist (T), or pull back (R).`
        );
      case 'kinked':
        return `The tape kinked. Nothing was pulled.`;
      case 'twisted':
        return `Round elbow ${elbowsPassed(s)}: ${where}.`;
      case 'twistedFree':
        return atElbow(s) ? 'The tape turns.' : 'The tape spins; no bend to get round here.';
      case 'retracted':
        return `Pulled back: ${where}.`;
      case 'atStart':
        return 'The tape is all the way out.';
      case 'through':
        return 'The tape is through at end b. Pull the conductors back (P).';
      case 'idle':
        return this.status();
    }
  }

  /** The game's keys, anywhere in the dialog but a select (where letters choose options). */
  protected onKey(event: KeyboardEvent): void {
    const t = this.tape();
    if (!t || event.ctrlKey || event.metaKey || event.altKey) return;
    if ((event.target as HTMLElement | null)?.closest('select, input, textarea')) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    let run: (() => void) | null = null;
    if (key === 'f' || key === 'ArrowUp') run = () => this.act('feed');
    else if (key === 't') run = () => this.act('twist');
    else if (key === 'r' || key === 'ArrowDown') run = () => this.act('retract');
    else if (key === 'p') run = () => this.pull();
    if (!run) return;
    event.preventDefault();
    event.stopPropagation();
    run();
  }

  protected onClosed(): void {
    this.args = null;
    this.status.set('');
    if (this.request() !== null) this.dismissed.emit();
  }
}
