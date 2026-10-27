import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { Button } from '../button/button';
import { Dialog } from './dialog';

@Component({
  selector: 'ctl-dialog-host',
  imports: [Dialog, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button ctlButton type="button" (click)="open.set(true)">Open settings</button>
    <ctl-dialog
      heading="Settings"
      description="Stored on this device."
      [(open)]="open"
      (closed)="closedCount = closedCount + 1"
    >
      <label>Name <input /></label>
      <button ctlButton type="button" ctlDialogActions (click)="open.set(false)">Back</button>
    </ctl-dialog>
  `,
})
class Host {
  readonly open = signal(false);
  closedCount = 0;
}

async function setup() {
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, user: userEvent.setup() };
}

describe('Dialog', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('is named by its heading and described, and starts closed', async () => {
    await setup();
    expect(screen.queryByRole('dialog')).toBeNull();
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog.hasAttribute('open')).toBe(false);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings', description: 'Stored on this device.' })).toBe(dialog);
  });

  it('moves focus inside when it opens and restores it to the opener on close', async () => {
    const { fixture, user } = await setup();
    const opener = screen.getByRole('button', { name: 'Open settings' });
    await user.click(opener);
    await fixture.whenStable();

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Name' }));

    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(fixture.componentInstance.closedCount).toBe(1);
  });

  it('closes on Escape, writes open=false back and restores focus', async () => {
    const { fixture, user } = await setup();
    const opener = screen.getByRole('button', { name: 'Open settings' });
    opener.focus();
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(fixture.componentInstance.open()).toBe(true);

    await user.keyboard('{Escape}');
    await fixture.whenStable();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('traps Tab inside while open, wrapping in both directions', async () => {
    const { fixture, user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    await fixture.whenStable();
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const input = within(dialog).getByRole('textbox', { name: 'Name' });
    const back = within(dialog).getByRole('button', { name: 'Back' });

    await user.tab();
    expect(document.activeElement).toBe(back);
    await user.tab();
    expect(document.activeElement).toBe(input);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(back);
  });

  it('closes when the native cancel event fires (browser Escape path)', async () => {
    const { fixture, user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    await fixture.whenStable();
    const cancel = new Event('cancel', { cancelable: true });
    screen.getByRole('dialog').dispatchEvent(cancel);
    await fixture.whenStable();
    expect(cancel.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.open()).toBe(false);
  });
});
