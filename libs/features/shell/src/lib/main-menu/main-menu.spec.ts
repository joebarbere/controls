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
    [canContinue]="canContinue()"
    (resumeGame)="log.push('resume')"
    (saveGame)="log.push('save')"
    (newSandbox)="log.push('new')"
    (continueGame)="log.push('continue')"
    (loadGame)="log.push('load')"
    (openSettings)="log.push('settings')"
    (openAbout)="log.push('about')"
    (quitGame)="log.push('quit')"
  />`,
})
class Host {
  readonly session = signal(false);
  readonly canQuit = signal(true);
  readonly canContinue = signal(false);
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

  it('keeps Continue discoverable but disabled, with the reason, while there are no saves (F1.8b)', async () => {
    const { fixture, host, user } = await setup();
    const button = screen.getByRole('button', { name: 'Continue', description: 'No saved games yet.' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await user.click(button);
    expect(host.log).toEqual([]);

    // The save list arrives: the same element (focus survives) becomes a working Continue.
    button.focus();
    host.canContinue.set(true);
    await fixture.whenStable();
    expect(screen.getByRole('button', { name: 'Continue' })).toBe(button);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(button.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText('No saved games yet.')).toBeNull();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    expect(host.log).toEqual(['continue']);
  });

  it('emits each action from the keyboard', async () => {
    const { host, user } = await setup((h) => h.canContinue.set(true));
    await user.keyboard('{Enter}'); // New sandbox has focus
    for (const name of ['Continue', 'Load', 'Settings', 'About', 'Quit']) {
      screen.getByRole('button', { name }).focus();
      await user.keyboard(' ');
    }
    expect(host.log).toEqual(['new', 'continue', 'load', 'settings', 'about', 'quit']);
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

  it('offers Resume and Save game first during a session, and hides Quit where the platform cannot quit', async () => {
    const { host, user } = await setup((h) => {
      h.session.set(true);
      h.canQuit.set(false);
    });
    expect(names()).toEqual(['Resume', 'Save game', 'New sandbox', 'Continue', 'Load', 'Settings', 'About']);
    expect(document.activeElement?.textContent?.trim()).toBe('Resume');
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(host.log).toEqual(['resume', 'save']);
  });
});
