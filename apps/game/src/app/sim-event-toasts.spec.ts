import { TestBed } from '@angular/core/testing';
import { SIM_CLOCK, SimHost } from '@controls/feature-session';
import { NotificationService } from '@controls/feature-shell';
import { createWorld } from '@controls/save-format';
import { EVENT_TOAST_COALESCE_MS, type SimEvent } from '@controls/sim-protocol';
import { SimEventToasts } from './sim-event-toasts';

const event = (kind: SimEvent['kind'], entity: number | null, tick = 0): SimEvent => ({
  tick,
  kind,
  entity,
  entities: [],
  detail: {},
});

function setup() {
  let now = 0;
  TestBed.configureTestingModule({
    providers: [
      {
        provide: SIM_CLOCK,
        useValue: { now: () => now, setTimeout: () => 0, clearTimeout: () => undefined },
      },
    ],
  });
  const toasts = TestBed.inject(SimEventToasts);
  const shown = () =>
    TestBed.inject(NotificationService)
      .toasts()
      .map((t) => `${t.level}: ${t.message}`);
  return { toasts, shown, advance: (ms: number) => (now += ms) };
}

describe('SimEventToasts', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('one warning per device per window; another device gets its own', () => {
    const { toasts, shown, advance } = setup();
    toasts.events([event('blown', 4), event('blown', 4, 3), event('tripped', 7)]);
    advance(EVENT_TOAST_COALESCE_MS - 1);
    toasts.events([event('blown', 4, 900)]);
    expect(shown()).toEqual(['warning: Device #4 blew.', 'warning: Device #7 tripped.']);
    advance(1); // the window has passed
    toasts.events([event('blown', 4, 1_000)]);
    expect(shown()).toHaveLength(3);
  });

  it('ignores other kinds and island events', () => {
    const { toasts, shown } = setup();
    toasts.events([event('hiccup', 2), event('overRated', 2), event('singular', null), event('blown', null)]);
    expect(shown()).toEqual([]);
  });

  it('forgets the window on a source reset (a new game reuses device ids)', () => {
    const { toasts, shown } = setup();
    toasts.events([event('blown', 3)]);
    const host = TestBed.inject(SimHost);
    host.bind({ tick: () => 0, advanceTo: () => undefined, world: () => createWorld({ seed: 1 }) });
    host.startWorld(createWorld({ seed: 1 }), 0); // no factory here: unavailable, but readers still reset
    toasts.events([event('blown', 3)]);
    expect(shown()).toEqual(['warning: Device #3 blew.', 'warning: Device #3 blew.']);
  });
});
