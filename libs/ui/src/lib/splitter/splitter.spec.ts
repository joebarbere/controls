import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { clampSize, Splitter } from './splitter';

@Component({
  selector: 'ctl-splitter-host',
  imports: [Splitter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-splitter
      orientation="vertical"
      label="Resize inspector"
      controls="inspector"
      [reverse]="reverse()"
      [min]="200"
      [max]="600"
      [collapsed]="collapsed()"
      [(value)]="size"
      (collapseToggle)="collapsed.set(!collapsed())"
    />
    <ctl-splitter orientation="horizontal" label="Resize console" [min]="100" [max]="400" [(value)]="bottom" />
  `,
})
class Host {
  readonly size = signal(300);
  readonly bottom = signal(200);
  readonly reverse = signal(true);
  readonly collapsed = signal(false);
}

async function setup() {
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const splitter = screen.getByRole('separator', { name: 'Resize inspector' });
  return { fixture, host: fixture.componentInstance, splitter, user: userEvent.setup() };
}

describe('Splitter', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('exposes the window-splitter ARIA pattern', async () => {
    const { splitter } = await setup();
    expect(splitter.getAttribute('tabindex')).toBe('0');
    expect(splitter.getAttribute('aria-orientation')).toBe('vertical');
    expect(splitter.getAttribute('aria-controls')).toBe('inspector');
    expect(splitter.getAttribute('aria-valuenow')).toBe('300');
    expect(splitter.getAttribute('aria-valuemin')).toBe('200');
    expect(splitter.getAttribute('aria-valuemax')).toBe('600');
    expect(splitter.getAttribute('aria-valuetext')).toBe('300 pixels');
  });

  it('resizes a pane after the bar with Left/Right (Left grows it), Shift for large steps', async () => {
    const { fixture, host, splitter, user } = await setup();
    splitter.focus();
    await user.keyboard('{ArrowLeft}');
    expect(host.size()).toBe(316);
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(host.size()).toBe(284);
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(host.size()).toBe(348);
    await fixture.whenStable();
    expect(splitter.getAttribute('aria-valuenow')).toBe('348');
  });

  it('grows a pane before the bar with Right when not reversed', async () => {
    const { host, splitter, user } = await setup();
    host.reverse.set(false);
    splitter.focus();
    await user.keyboard('{ArrowRight}');
    expect(host.size()).toBe(316);
  });

  it('jumps to min and max with Home and End, and clamps', async () => {
    const { host, splitter, user } = await setup();
    splitter.focus();
    await user.keyboard('{End}');
    expect(host.size()).toBe(600);
    await user.keyboard('{ArrowLeft}');
    expect(host.size()).toBe(600);
    await user.keyboard('{Home}');
    expect(host.size()).toBe(200);
  });

  it('uses Up/Down for a horizontal bar and ignores other keys', async () => {
    const { host, user } = await setup();
    screen.getByRole('separator', { name: 'Resize console' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(host.bottom()).toBe(216);
    await user.keyboard('{ArrowLeft}a');
    expect(host.bottom()).toBe(216);
  });

  it('toggles collapse with Enter; a resize key while collapsed restores instead of resizing', async () => {
    const { fixture, host, splitter, user } = await setup();
    splitter.focus();
    await user.keyboard('{Enter}');
    expect(host.collapsed()).toBe(true);
    await fixture.whenStable();
    expect(splitter.getAttribute('aria-valuetext')).toBe('collapsed');
    await user.keyboard('{ArrowLeft}');
    expect(host.collapsed()).toBe(false);
    expect(host.size()).toBe(300);
  });

  it('resizes by pointer drag', async () => {
    const { host, splitter } = await setup();
    fireEvent.pointerDown(splitter, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(splitter, { clientX: 450, pointerId: 1 });
    expect(host.size()).toBe(350); // dragged 50 px towards the start: a reversed pane grows
    fireEvent.pointerUp(splitter, { clientX: 450, pointerId: 1 });
    fireEvent.pointerMove(splitter, { clientX: 300, pointerId: 1 });
    expect(host.size()).toBe(350); // no longer dragging
  });

  it('ignores secondary-button drags', async () => {
    const { host, splitter } = await setup();
    fireEvent.pointerDown(splitter, { button: 2, clientX: 500 });
    fireEvent.pointerMove(splitter, { clientX: 400 });
    expect(host.size()).toBe(300);
  });

  it('clampSize rounds to whole pixels within bounds', () => {
    expect(clampSize(10.6, 0, 100)).toBe(11);
    expect(clampSize(-5, 0, 100)).toBe(0);
    expect(clampSize(500, 0, 100)).toBe(100);
  });
});
