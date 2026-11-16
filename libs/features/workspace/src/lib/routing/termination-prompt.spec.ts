import { TestBed } from '@angular/core/testing';
import { BUILTIN_CATALOG } from '@controls/catalog';
import { KEY_PLATFORM, Session } from '@controls/feature-session';
import type { Difficulty } from '@controls/save-format';
import type { TerminationArgs } from '@controls/world-model';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import type { TerminationPrompt } from './routing-flow';
import { terminationRequest } from './termination-model';
import { TerminationPromptDialog } from './termination-prompt';

const THHN = { id: 'conductor.tallowmere-thhn-14-solid', version: 1 };
const BLOCK = { id: 'tb.quennick-st4', version: 1 };
const EMPTY_BELT = Array.from({ length: 9 }, () => null);
const ref = (id: string) => ({ id, version: 1 });
const IDEAL: TerminationArgs = {
  method: 'screw',
  strip: { tool: ref('tool.veltmark-ws-1018'), hole: 'sol14', lengthMm: 9 },
  accessory: null,
  clamp: { tool: ref('tool.calderyn-ts-03'), torqueNm: 0.6 },
};

/** The prompt for end a on a block's terminal 1 at `difficulty`, rendered, with what it emitted. */
async function render(difficulty: Difficulty, refusal: string | null = null) {
  TestBed.configureTestingModule({ providers: [{ provide: KEY_PLATFORM, useValue: 'other' }] });
  const session = TestBed.inject(Session);
  session.newSandbox({ seed: 0, difficulty });
  session.exec('entity.place', {
    ref: BLOCK,
    positionMm: { x: -100, y: 0, z: 40 },
    orientationMdeg: { yaw: 0, pitch: 0, roll: 0 },
    mountedOn: null,
  });
  const built = terminationRequest(
    session.world(),
    BUILTIN_CATALOG,
    EMPTY_BELT,
    THHN,
    'a',
    { entity: 1, terminal: 'a' },
    'Block #1, terminal 1',
  );
  if (!built.ok || !built.request) throw new Error('no request');
  const prompt: TerminationPrompt = { request: built.request, refusal };
  const fixture = TestBed.createComponent(TerminationPromptDialog);
  const confirmed: TerminationArgs[] = [];
  let cancelled = 0;
  fixture.componentInstance.confirm.subscribe((a) => confirmed.push(a));
  fixture.componentInstance.dismissed.subscribe(() => cancelled++);
  fixture.componentRef.setInput('prompt', prompt);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return {
    fixture,
    prompt,
    confirmed,
    cancelled: () => cancelled,
    user: userEvent.setup(),
    dialog: () => screen.getByRole('dialog'),
  };
}

const value = (name: string | RegExp) => (screen.getByLabelText(name) as HTMLInputElement | HTMLSelectElement).value;

describe('TerminationPromptDialog (F3.3 part 2)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    TestBed.resetTestingModule();
  });

  it('Apprentice: opens on the strip step with every field preselected; Next then Land emits the suggestion', async () => {
    const { fixture, confirmed, user, dialog } = await render('apprentice');
    expect(within(dialog()).getByRole('heading', { name: 'End a: strip and finish' })).toBeTruthy();
    expect(dialog().getAttribute('aria-describedby')).not.toBeNull();
    expect(value('Method')).toBe('screw');
    expect(value('Stripper')).toBe('tool.veltmark-ws-1018@1');
    expect(value('Strip hole')).toBe('sol14');
    expect(value('Strip length (mm)')).toBe('9');
    expect(value('Ferrule or lug')).toBe('none');
    expect(screen.getByText('The terminal is marked for 9 mm (±1).')).toBeTruthy();
    // Focus starts in the form, on the first field.
    expect(document.activeElement).toBe(screen.getByLabelText('Method'));

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await fixture.whenStable();
    expect(screen.getByRole('heading', { name: 'End a: tighten' })).toBeTruthy();
    expect(value('Screwdriver')).toBe('tool.calderyn-ts-03@1');
    expect(value('Torque setting (N·m)')).toBe('0.6');
    expect(screen.getByText('The screw takes slotted or Pozidriv, marked 0.6 N·m.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('End a, step 2 of 2: tighten.');
    await user.click(screen.getByRole('button', { name: 'Land end a' }));
    expect(confirmed).toStrictEqual([IDEAL]);
  });

  it('Journeyman: blank hole, length and torque; Land with blanks is an alert on the field, then typed values land', async () => {
    const { fixture, confirmed, user } = await render('journeyman');
    expect(value('Strip hole')).toBe('');
    expect(value('Strip length (mm)')).toBe('');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toBe('Choose a strip hole.');
    expect(screen.getByLabelText('Strip hole').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('Strip hole'));

    await user.selectOptions(screen.getByLabelText('Strip hole'), '14 AWG solid');
    await user.type(screen.getByLabelText('Strip length (mm)'), '9{Enter}'); // Enter goes on
    await fixture.whenStable();
    expect(screen.getByRole('heading', { name: 'End a: tighten' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Screwdriver'));
    expect(value('Torque setting (N·m)')).toBe('');
    expect(screen.getByText('This driver sets 0.3–1.2 N·m.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await fixture.whenStable();
    expect(value('Strip length (mm)')).toBe('9'); // the draft is kept
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await fixture.whenStable();
    await user.type(screen.getByLabelText('Torque setting (N·m)'), '0.6{Enter}');
    expect(confirmed).toStrictEqual([IDEAL]);
  });

  it('Journeyman with a plain screwdriver: no torque setting, tightened by feel', async () => {
    const { fixture, confirmed, user } = await render('journeyman');
    await user.selectOptions(screen.getByLabelText('Strip hole'), '14 AWG solid');
    await user.type(screen.getByLabelText('Strip length (mm)'), '9');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await fixture.whenStable();
    await user.selectOptions(screen.getByLabelText('Screwdriver'), 'tool.veltmark-sd-2@1');
    await fixture.whenStable();
    expect(screen.queryByLabelText('Torque setting (N·m)')).toBeNull();
    expect(screen.getByText('No torque setting: this screwdriver is tightened by feel.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Land end a' }));
    expect(confirmed.map((a) => a.clamp)).toStrictEqual([{ tool: ref('tool.veltmark-sd-2'), torqueNm: null }]);
  });

  it('a ferrule shows the crimper and its die', async () => {
    const { fixture, user } = await render('journeyman');
    expect(screen.queryByLabelText('Crimp die')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Ferrule or lug'), 'ferrule.thimbleby-14@1');
    await fixture.whenStable();
    expect(value('Crimper')).toBe('tool.veltmark-cr-2210@1');
    expect(value('Crimp die')).toBe('');
  });

  it('Realistic: the same blank prompt; the command’s refusal is an alert until the draft changes', async () => {
    const { fixture, user } = await render('realistic', 'The setting is outside the driver (beyond-tool-capacity)');
    expect(value('Strip hole')).toBe('');
    await user.selectOptions(screen.getByLabelText('Strip hole'), '14 AWG solid');
    await user.type(screen.getByLabelText('Strip length (mm)'), '9');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await fixture.whenStable();
    await user.type(screen.getByLabelText('Torque setting (N·m)'), '3');
    await user.click(screen.getByRole('button', { name: 'Land end a' }));
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toBe(
      'Refused: The setting is outside the driver (beyond-tool-capacity)',
    );
    await user.type(screen.getByLabelText('Torque setting (N·m)'), '{Backspace}1');
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toBe('');
  });

  it('Escape or Cancel dismisses it, and a closed prompt renders no dialog', async () => {
    const { fixture, cancelled, user } = await render('apprentice');
    await user.keyboard('{Escape}');
    await fixture.whenStable();
    expect(cancelled()).toBe(1);
    fixture.componentRef.setInput('prompt', null);
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
