import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { ToolBeltBar, type ToolBeltBarSlot } from './tool-belt-bar';

const SLOTS: ToolBeltBarSlot[] = [
  { slot: 1, title: 'Box', kind: 'placeable' },
  { slot: 2, title: 'Crate', kind: 'placeable' },
  { slot: 3, title: 'Spool', kind: 'placeable' },
  { slot: 4, title: 'Wire strippers', kind: 'tool' },
  ...[5, 6, 7, 8, 9].map((slot) => ({ slot, title: 'Empty', kind: 'empty' })),
];

@Component({
  selector: 'ctl-belt-host',
  imports: [ToolBeltBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ctl-tool-belt-bar
    [slots]="slots"
    [active]="active()"
    (selectSlot)="chosen.push($event); active.set($event)"
  />`,
})
class Host {
  readonly slots = SLOTS;
  readonly active = signal<number | null>(null);
  readonly chosen: number[] = [];
}

async function mount() {
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, host: fixture.componentInstance, toolbar: screen.getByRole('toolbar', { name: 'Tool belt' }) };
}

describe('ToolBeltBar', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('is a toolbar of nine slot buttons named by number and contents, none pressed until one is chosen', async () => {
    const { toolbar } = await mount();
    const buttons = within(toolbar).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toStrictEqual([
      '1: Box (to place)',
      '2: Crate (to place)',
      '3: Spool (to place)',
      '4: Wire strippers (tool)',
      '5: Empty',
      '6: Empty',
      '7: Empty',
      '8: Empty',
      '9: Empty',
    ]);
    // Label in name: the visible number starts the accessible name.
    for (const b of buttons) expect(b.getAttribute('aria-label')?.startsWith(b.textContent?.trim() ?? '?')).toBe(true);
    expect(buttons.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(buttons.map((b) => b.tabIndex)).toStrictEqual([0, -1, -1, -1, -1, -1, -1, -1, -1]);
  });

  it('a click emits the slot; the chosen slot is pressed and is the tab stop', async () => {
    const { fixture, host, toolbar } = await mount();
    const user = userEvent.setup();
    await user.click(within(toolbar).getByRole('button', { name: '4: Wire strippers (tool)' }));
    await fixture.whenStable();
    expect(host.chosen).toStrictEqual([4]);
    const strippers = within(toolbar).getByRole('button', { name: '4: Wire strippers (tool)', pressed: true });
    expect(strippers.tabIndex).toBe(0);
  });

  it('is one tab stop; arrows, Home and End move focus without choosing; Enter and Space choose', async () => {
    const { fixture, host, toolbar } = await mount();
    const user = userEvent.setup();
    const buttons = within(toolbar).getAllByRole('button');
    await user.tab();
    expect(document.activeElement).toBe(buttons[0]);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(buttons[8]);
    await user.keyboard('{Home}{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(buttons[3]);
    expect(host.chosen).toStrictEqual([]);
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(host.chosen).toStrictEqual([4]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(buttons[8]);
    await user.keyboard(' ');
    await fixture.whenStable();
    expect(host.chosen).toStrictEqual([4, 9]);
    // Leaving and re-entering lands on the active slot.
    await user.tab({ shift: true });
    await user.tab();
    expect(document.activeElement).toBe(buttons[8]);
  });

  it('marks its arrow keys handled, so no viewport binding runs too', async () => {
    const { toolbar } = await mount();
    const first = within(toolbar).getAllByRole('button')[0];
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    first.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const other = new KeyboardEvent('keydown', { key: '4', bubbles: true, cancelable: true });
    first.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });
});
