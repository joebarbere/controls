import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { type Toast, ToastStack } from './toast-stack';

@Component({
  selector: 'ctl-toast-host',
  imports: [ToastStack],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button">Elsewhere</button>
    <ctl-toast-stack [toasts]="toasts()" (dismiss)="remove($event)" (held)="held.push($event)" />
  `,
})
class Host {
  readonly toasts = signal<Toast[]>([
    { id: 1, message: 'Layout reset', level: 'info' },
    { id: 2, message: 'Settings saved', level: 'success' },
    { id: 3, message: 'Settings file was corrupt', level: 'error' },
  ]);
  readonly held: boolean[] = [];
  remove(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}

async function setup() {
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, host: fixture.componentInstance, user: userEvent.setup() };
}

describe('ToastStack', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('announces info/success politely and warnings/errors assertively', async () => {
    await setup();
    const status = screen.getByRole('status');
    const alert = screen.getByRole('alert');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
    expect(within(status).getByText('Layout reset')).toBeTruthy();
    expect(within(status).getByText('Settings saved')).toBeTruthy();
    expect(within(alert).getByText('Settings file was corrupt')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeTruthy();
  });

  it('dismisses with the Dismiss button from the keyboard and focuses the next toast', async () => {
    const { fixture, host, user } = await setup();
    screen.getByRole('button', { name: 'Dismiss notification: Layout reset' }).focus();
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(host.toasts().map((t) => t.id)).toEqual([2, 3]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss notification: Settings saved' }));
  });

  it('dismisses the focused toast with Escape and returns focus once the stack is empty', async () => {
    const { fixture, host, user } = await setup();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    const first = screen.getByRole('button', { name: 'Dismiss notification: Layout reset' });
    first.focus();
    // jsdom leaves focusin.relatedTarget null; Chromium sets it to the element focus came from.
    first.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: elsewhere }));
    for (let i = 0; i < 3; i++) {
      await user.keyboard('{Escape}');
      await fixture.whenStable();
    }
    expect(host.toasts()).toEqual([]);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('reports when focus or the pointer is inside, so auto-dismiss can pause', async () => {
    const { host } = await setup();
    const stack = document.querySelector('ctl-toast-stack') as HTMLElement;
    screen.getByRole('button', { name: 'Dismiss notification: Settings saved' }).focus();
    expect(host.held.at(-1)).toBe(true);
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    expect(host.held.at(-1)).toBe(false);
    // pointerenter/leave don't bubble and user-event doesn't send them to ancestors, so fire them on the host.
    fireEvent.pointerEnter(stack);
    expect(host.held.at(-1)).toBe(true);
    fireEvent.pointerLeave(stack);
    expect(host.held.at(-1)).toBe(false);
  });

  it('does not move focus when a toast is dismissed by pointer from elsewhere', async () => {
    const { fixture, host } = await setup();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    screen.getByRole('button', { name: 'Dismiss notification: Layout reset' }).click();
    await fixture.whenStable();
    expect(host.toasts()).toHaveLength(2);
    expect(document.activeElement).toBe(elsewhere);
  });
});
