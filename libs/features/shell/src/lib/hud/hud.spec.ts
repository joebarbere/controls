import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { screen, within } from '@testing-library/dom';
import type { InteractionMode } from '../shell-state';
import { Hud } from './hud';

@Component({
  selector: 'ctl-hud-host',
  imports: [Hud],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ctl-hud [mode]="mode()" [selection]="selection()" [assisted]="assisted()" />`,
})
class Host {
  readonly mode = signal<InteractionMode>('work');
  readonly selection = signal<string | null>(null);
  readonly assisted = signal(false);
}

describe('Hud', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('shows the mode, the selection summary and the assisted badge only when assisted', async () => {
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    await fixture.whenStable();
    const hud = screen.getByRole('region', { name: 'Status' });
    expect(within(hud).getByText('Work')).toBeTruthy();
    expect(within(hud).getByText('Nothing selected')).toBeTruthy();
    expect(within(hud).queryByText('Assisted')).toBeNull();

    const host = fixture.componentInstance;
    host.mode.set('walk');
    host.selection.set('Crate #12');
    host.assisted.set(true);
    await fixture.whenStable();
    expect(within(hud).getByText('Walk')).toBeTruthy();
    expect(within(hud).getByText('Crate #12').getAttribute('aria-live')).toBe('polite');
    expect(within(hud).getByText('Assisted')).toBeTruthy();
  });
});
