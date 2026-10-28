import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { MAX_SEED, NewGameDialog, parseSeed, SEED_SOURCE } from './new-game-dialog';

@Component({
  selector: 'ctl-new-game-host',
  imports: [NewGameDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" (click)="open.set(true)">New sandbox</button>
    <ctl-new-game-dialog [(open)]="open" (start)="started.push($event)" />
  `,
})
class Host {
  readonly open = signal(false);
  readonly started: number[] = [];
}

async function setup(seeds: number[] = [1234, 99]) {
  const queue = [...seeds];
  TestBed.configureTestingModule({ providers: [{ provide: SEED_SOURCE, useValue: () => queue.shift() ?? 7 }] });
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const user = userEvent.setup();
  const opener = screen.getByRole('button', { name: 'New sandbox' });
  opener.focus();
  await user.keyboard('{Enter}');
  await fixture.whenStable();
  const seed = () => screen.getByRole('textbox', { name: 'Seed' }) as HTMLInputElement;
  return { fixture, host: fixture.componentInstance, user, opener, seed };
}

describe('parseSeed', () => {
  it('accepts unsigned 32-bit decimal integers only', () => {
    expect(parseSeed('0')).toBe(0);
    expect(parseSeed(' 42 ')).toBe(42);
    expect(parseSeed(String(MAX_SEED))).toBe(MAX_SEED);
    expect(parseSeed('007')).toBe(7);
    for (const bad of ['', ' ', '-1', '1.5', '1e3', '0x10', '4294967296', '12345678901', 'seed', '+1']) {
      expect(parseSeed(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('NewGameDialog', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('opens with a fresh seed in the focused field; Enter starts with it after the dialog closes', async () => {
    const { fixture, host, user, opener, seed } = await setup();
    expect(screen.getByRole('dialog', { name: 'New sandbox' })).toBeTruthy();
    expect(screen.getByText('Workshop')).toBeTruthy();
    expect(document.activeElement).toBe(seed());
    expect(seed().value).toBe('1234');
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(host.started).toEqual([1234]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener); // focus restored before start is emitted
  });

  it('a typed seed is used as typed; New seed draws another', async () => {
    const { fixture, host, user, seed } = await setup();
    await user.click(screen.getByRole('button', { name: 'New seed' }));
    await fixture.whenStable();
    expect(seed().value).toBe('99');
    await user.clear(seed());
    await user.type(seed(), '4294967295');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await fixture.whenStable();
    expect(host.started).toEqual([MAX_SEED]);
  });

  it('refuses an invalid seed inline, from the same rule, and keeps the dialog open', async () => {
    const { fixture, host, user, seed } = await setup();
    await user.clear(seed());
    await user.type(seed(), '-5{Enter}');
    await fixture.whenStable();
    expect(host.started).toEqual([]);
    expect(seed().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain(`from 0 to ${MAX_SEED}`);
    expect(seed().getAttribute('aria-describedby')).toContain('ctl-new-game-seed-error');
    await user.clear(seed());
    await user.type(seed(), '5{Enter}');
    await fixture.whenStable();
    expect(host.started).toEqual([5]);
  });

  it('Escape and Cancel start nothing; reopening offers a fresh seed', async () => {
    const { fixture, host, user, opener, seed } = await setup([1, 2, 3]);
    await user.keyboard('{Escape}');
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(seed().value).toBe('2');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await fixture.whenStable();
    expect(host.started).toEqual([]);
  });

  it('the default seed source is the platform CSPRNG, as an unsigned 32-bit integer', () => {
    const source = TestBed.inject(SEED_SOURCE);
    const s = source();
    expect(Number.isInteger(s) && s >= 0 && s <= MAX_SEED).toBe(true);
  });
});
