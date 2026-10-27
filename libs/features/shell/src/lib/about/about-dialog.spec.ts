import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AppInfo } from '@controls/ipc-contract';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { AboutDialog } from './about-dialog';

@Component({
  selector: 'ctl-about-host',
  imports: [AboutDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" (click)="open.set(true)">About</button>
    <ctl-about-dialog [(open)]="open" [info]="info()" backend="webgl2" [isolated]="true" />
  `,
})
class Host {
  readonly open = signal(false);
  readonly info = signal<AppInfo | undefined>(undefined);
}

async function setup() {
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, host: fixture.componentInstance, user: userEvent.setup() };
}

const testId = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent;

describe('AboutDialog', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('keeps the about-* test ids in the DOM while closed (e2e contract)', async () => {
    const { fixture, host } = await setup();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(testId('about-version')).toBe('…');
    expect(testId('about-platform')).toBe('…');
    host.info.set({
      appVersion: '9.8.7',
      platform: 'linux',
      arch: 'x64',
      isPackaged: true,
      versions: { electron: '45.0.0' },
    });
    await fixture.whenStable();
    expect(testId('about-version')).toBe('9.8.7');
    expect(testId('about-platform')).toBe('linux · Electron 45.0.0');
    expect(testId('about-backend')).toBe('webgl2');
    expect(testId('about-isolated')).toBe('yes');
  });

  it('labels the web harness and opens as a named dialog that closes back to its opener', async () => {
    const { fixture, host, user } = await setup();
    host.info.set({ appVersion: '1.0.0', platform: 'web', arch: 'unknown', isPackaged: false, versions: {} });
    const opener = screen.getByRole('button', { name: 'About' });
    await user.click(opener);
    await fixture.whenStable();
    expect(screen.getByRole('dialog', { name: 'About Controls' })).toBeTruthy();
    expect(testId('about-platform')).toBe('web harness');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
