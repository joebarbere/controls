import { TestBed } from '@angular/core/testing';
import { BUILTIN_CATALOG } from '@controls/catalog';
import { KEY_PLATFORM } from '@controls/feature-session';
import type { CableStripArgs, World } from '@controls/world-model';
import { cableRunBus } from '@controls/world-model/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { CableStripPromptDialog, type StripPrompt } from './cable-strip-prompt';
import { type LabelConfirm, type LabelPrompt, LabelPromptDialog } from './label-prompt';
import { labelRequest, stripRequest } from './wiring-model';

/*
 * F3.2 part 4: the strip and label prompts, keyboard first, with their refusals shown inside the
 * dialog (a live region outside a modal dialog is inert). Rendered on `cableRunBus`'s cable.
 */

const ref = (id: string) => ({ id, version: 1 });
const EMPTY_BELT = Array.from({ length: 9 }, () => null);

/** `cableRunBus` plus a second cable (id 2) from the box's other top clamp to a free end with a 150 mm tail. */
function withFreeEnd(): World {
  const bus = cableRunBus();
  const free = { kind: 'free', positionMm: { x: 74, y: 300, z: 40 }, entity: null, fixture: null, tool: null };
  expect(bus.exec('enclosure.openEntry', { id: 1, entry: 'clamp-top-2', tool: ref('tool.veltmark-sd-2') }).ok).toBe(
    true,
  );
  const added = bus.exec('cable.add', {
    ref: ref('cable.sorrelby-nmb-14-2'),
    a: { entity: 1, entry: 'clamp-top-2' },
    b: null,
    route: [free],
    lengthMm: 1000,
    tailsMm: { a: 200, b: 150 },
    tool: ref('tool.veltmark-dc-8'),
  });
  expect(added.ok).toBe(true);
  return bus.state;
}

async function mountStrip(
  difficulty: 'trainee' | 'journeyman',
  refusal: string | null = null,
  world: World = cableRunBus().state,
  cable = 1,
) {
  TestBed.configureTestingModule({ providers: [{ provide: KEY_PLATFORM, useValue: 'other' }] });
  const built = stripRequest({ ...world, difficulty }, BUILTIN_CATALOG, EMPTY_BELT, cable);
  if (!built.ok) throw new Error(built.message);
  const fixture = TestBed.createComponent(CableStripPromptDialog);
  const confirmed: CableStripArgs[][] = [];
  let dismissed = 0;
  fixture.componentInstance.confirm.subscribe((a) => confirmed.push(a));
  fixture.componentInstance.dismissed.subscribe(() => dismissed++);
  const prompt: StripPrompt = { request: built.request, refusal };
  fixture.componentRef.setInput('prompt', prompt);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, prompt, confirmed, dismissed: () => dismissed, user: userEvent.setup() };
}

async function mountLabel(refusal: string | null = null) {
  TestBed.configureTestingModule({ providers: [{ provide: KEY_PLATFORM, useValue: 'other' }] });
  const built = labelRequest(cableRunBus().state, BUILTIN_CATALOG, EMPTY_BELT, { kind: 'connection', id: 1 });
  if (!built.ok) throw new Error(built.message);
  const fixture = TestBed.createComponent(LabelPromptDialog);
  const confirmed: LabelConfirm[] = [];
  fixture.componentInstance.confirm.subscribe((a) => confirmed.push(a));
  const prompt: LabelPrompt = { request: built.request, refusal };
  fixture.componentRef.setInput('prompt', prompt);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, prompt, confirmed, user: userEvent.setup() };
}

const value = (name: string) => (screen.getByLabelText(name) as HTMLInputElement | HTMLSelectElement).value;

describe('CableStripPromptDialog (F3.2 part 4)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    TestBed.resetTestingModule();
  });

  it('Trainee: prefilled with the most each box end allows; Enter in a length strips both ends', async () => {
    const { confirmed, user } = await mountStrip('trainee');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Strip cable 1' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Cable stripper'));
    expect(value('Cable stripper')).toBe('tool.veltmark-ws-nm12@1');
    expect(value('End a: jacket to strip (mm)')).toBe('193');
    expect(value('End b: jacket to strip (mm)')).toBe('293');
    expect(
      screen.getByText(/^200 mm tail in 2-gang .*: strip at most 193 mm \(6.35 mm of sheath stays inside the box\)/),
    ).toBeTruthy();
    await user.click(screen.getByLabelText('End a: jacket to strip (mm)'));
    await user.keyboard('{Enter}');
    expect(confirmed).toStrictEqual([
      [
        { id: 1, end: 'a', jacketMm: 193, tool: ref('tool.veltmark-ws-nm12') },
        { id: 1, end: 'b', jacketMm: 293, tool: ref('tool.veltmark-ws-nm12') },
      ],
    ]);
  });

  it('Journeyman: blank; Strip with nothing filled in is an alert on the first field; one end only strips it', async () => {
    const { fixture, confirmed, user } = await mountStrip('journeyman');
    expect(value('End a: jacket to strip (mm)')).toBe('');
    await user.click(screen.getByRole('button', { name: 'Strip' }));
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toBe('Enter how much jacket to strip at one end at least.');
    expect(screen.getByLabelText('End a: jacket to strip (mm)').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('End a: jacket to strip (mm)'));
    await user.type(screen.getByLabelText('End b: jacket to strip (mm)'), '120{Enter}');
    expect(confirmed).toStrictEqual([[{ id: 1, end: 'b', jacketMm: 120, tool: ref('tool.veltmark-ws-nm12') }]]);
  });

  it('a free cable end is bounded by its whole tail (no box keeps sheath), and its hint says so', async () => {
    const { confirmed, user } = await mountStrip('trainee', null, withFreeEnd(), 2);
    expect(value('End a: jacket to strip (mm)')).toBe('193');
    expect(value('End b: jacket to strip (mm)')).toBe('150');
    expect(screen.getByText('Free end, 150 mm tail. Leave blank to keep it.')).toBeTruthy();
    await user.click(screen.getByLabelText('End b: jacket to strip (mm)'));
    await user.keyboard('{Enter}');
    expect(confirmed[0]?.[1]).toStrictEqual({ id: 2, end: 'b', jacketMm: 150, tool: ref('tool.veltmark-ws-nm12') });
  });

  it('shows the command’s refusal until the draft changes; Escape dismisses without stripping', async () => {
    const { fixture, confirmed, dismissed, user } = await mountStrip('trainee', 'end a: too long (strip-too-long)');
    expect(screen.getByRole('alert').textContent).toBe('Refused: end a: too long (strip-too-long)');
    await user.type(screen.getByLabelText('End a: jacket to strip (mm)'), '{Backspace}');
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toBe('');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await fixture.whenStable();
    expect(dismissed()).toBe(1);
    expect(confirmed).toStrictEqual([]);
  });
});

describe('LabelPromptDialog (F3.2 part 4)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    TestBed.resetTestingModule();
  });

  it('types the text, Enter prints it with the label maker in hand', async () => {
    const { confirmed, user } = await mountLabel();
    expect(within(screen.getByRole('dialog')).getByRole('heading', { name: 'Label' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Label text'));
    expect(value('Label maker')).toBe('tool.penmarrow-lp-12@1');
    await user.keyboard('L1{Enter}');
    expect(confirmed).toStrictEqual([
      { ok: true, id: 'wire.label', args: { id: 1, text: 'L1', tool: ref('tool.penmarrow-lp-12') } },
    ]);
  });

  it('empty text with no label yet is an alert; a refusal shows inside the dialog', async () => {
    const { fixture, confirmed, user } = await mountLabel('text: invalid (bad-args)');
    expect(screen.getByRole('alert').textContent).toBe('Refused: text: invalid (bad-args)');
    await user.click(screen.getByRole('button', { name: 'Print' }));
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toBe('Type the label text.');
    expect(confirmed).toStrictEqual([]);
  });
});
