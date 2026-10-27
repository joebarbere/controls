import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { MainMenu } from './main-menu';

@Component({
  selector: 'ctl-menu-host',
  imports: [MainMenu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ctl-main-menu
    [sessionActive]="session()"
    [canQuit]="canQuit()"
    (resumeGame)="log.push('resume')"
    (newSandbox)="log.push('new')"
    (openSettings)="log.push('settings')"
    (openAbout)="log.push('about')"
    (quitGame)="log.push('quit')"
  />`,
})
class Host {
  readonly session = signal(false);
  readonly canQuit = signal(true);
  readonly log: string[] = [];
}

async function setup(init: (host: Host) => void = () => undefined) {
  const fixture = TestBed.createComponent(Host);
  init(fixture.componentInstance);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, host: fixture.componentInstance, user: userEvent.setup() };
}

const names = () =>
  within(screen.getByRole('navigation', { name: 'Controls' }))
    .getAllByRole('button')
    .map((b) => b.textContent?.trim());

describe('MainMenu', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('lists New sandbox, Continue, Load, Settings, About and Quit under the Controls heading', async () => {
    await setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Controls' })).toBeTruthy();
    expect(names()).toEqual(['New sandbox', 'Continue', 'Load', 'Settings', 'About', 'Quit']);
  });

  it('focuses the first item when it appears', async () => {
    await setup();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New sandbox' }));
  });

  it('keeps Continue and Load discoverable but disabled, with the reason', async () => {
    const { host, user } = await setup();
    for (const name of ['Continue', 'Load']) {
      const button = screen.getByRole('button', { name, description: 'Saving and loading arrive in a later build.' });
      expect(button.getAttribute('aria-disabled')).toBe('true');
      await user.click(button);
    }
    expect(host.log).toEqual([]);
  });

  it('emits each action from the keyboard', async () => {
    const { host, user } = await setup();
    await user.keyboard('{Enter}'); // New sandbox has focus
    for (const name of ['Settings', 'About', 'Quit']) {
      screen.getByRole('button', { name }).focus();
      await user.keyboard(' ');
    }
    expect(host.log).toEqual(['new', 'settings', 'about', 'quit']);
  });

  it('moves between items with Up/Down (wrapping), Home and End', async () => {
    const { user } = await setup();
    const focused = () => document.activeElement?.textContent?.trim();
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe('Continue');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(focused()).toBe('Quit');
    await user.keyboard('{Home}');
    expect(focused()).toBe('New sandbox');
    await user.keyboard('{End}');
    expect(focused()).toBe('Quit');
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe('New sandbox');
    await user.keyboard('x');
    expect(focused()).toBe('New sandbox');
  });

  it('offers Resume first during a session, and hides Quit where the platform cannot quit', async () => {
    const { host, user } = await setup((h) => {
      h.session.set(true);
      h.canQuit.set(false);
    });
    expect(names()).toEqual(['Resume', 'New sandbox', 'Continue', 'Load', 'Settings', 'About']);
    expect(document.activeElement?.textContent?.trim()).toBe('Resume');
    await user.keyboard('{Enter}');
    expect(host.log).toEqual(['resume']);
  });
});
