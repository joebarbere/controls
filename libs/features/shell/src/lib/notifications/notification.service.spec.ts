import { TestBed } from '@angular/core/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { HELD_RETRY_MS, MAX_TOASTS, NotificationService } from './notification.service';
import { Notifications } from './notifications';

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = TestBed.inject(NotificationService);
  });

  afterEach(() => vi.useRealTimers());

  it('auto-dismisses info and success after 8 s but keeps warnings and errors', () => {
    service.notify('Layout reset');
    service.notify('Saved', { level: 'success' });
    service.notify('Careful', { level: 'warning' });
    service.notify('Broken', { level: 'error' });
    vi.advanceTimersByTime(7999);
    expect(service.toasts()).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(service.toasts().map((t) => t.message)).toEqual(['Careful', 'Broken']);
  });

  it('honours a custom timeout and 0 = never', () => {
    service.notify('quick', { timeoutMs: 100 });
    service.notify('sticky', { timeoutMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(service.toasts().map((t) => t.message)).toEqual(['sticky']);
  });

  it('postpones expiry while held', () => {
    service.notify('Layout reset');
    service.setHeld(true);
    vi.advanceTimersByTime(8000 + 5 * HELD_RETRY_MS);
    expect(service.toasts()).toHaveLength(1);
    service.setHeld(false);
    vi.advanceTimersByTime(HELD_RETRY_MS);
    expect(service.toasts()).toHaveLength(0);
  });

  it('dismisses by id and caps the stack', () => {
    const ids = Array.from({ length: MAX_TOASTS + 2 }, (_, i) => service.notify(`n${i}`, { level: 'error' }));
    expect(service.toasts()).toHaveLength(MAX_TOASTS);
    expect(service.toasts()[0].message).toBe('n2');
    service.dismiss(ids[3]);
    expect(service.toasts().map((t) => t.message)).not.toContain('n3');
  });
});

describe('Notifications', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('renders the service toasts and dismisses them from the keyboard', async () => {
    const fixture = TestBed.createComponent(Notifications);
    document.body.appendChild(fixture.nativeElement);
    const service = TestBed.inject(NotificationService);
    service.notify('Settings file was corrupt; defaults restored', { level: 'warning' });
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain('Settings file was corrupt');
    screen.getByRole('button', { name: /^Dismiss notification/ }).focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(service.toasts()).toEqual([]);
  });
});
