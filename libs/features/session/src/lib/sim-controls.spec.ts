import { TestBed } from '@angular/core/testing';
import { screen, waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { FakeSimWorker } from '../testing/fake-sim-worker';
import { Session } from './session';
import { formatSimTime, formatSpeed, SimControls } from './sim-controls';
import { SIM_TRANSPORT, SIM_WORKER_FACTORY, SimHost } from './sim-host';

/*
 * The HUD's time controls (ADR 0011 §13): sim time from snapshots, one native radio group for the
 * speed (through sim.setSpeed), and a polite live region for transitions only.
 */

async function setup() {
  const fakes = FakeSimWorker.factory();
  TestBed.configureTestingModule({
    providers: [
      { provide: SIM_WORKER_FACTORY, useValue: fakes.factory },
      { provide: SIM_TRANSPORT, useValue: 'message' },
    ],
  });
  const session = TestBed.inject(Session);
  session.newSandbox({ seed: 0 });
  const fixture = TestBed.createComponent(SimControls);
  document.body.appendChild(fixture.nativeElement);
  await waitFor(() => expect(session.sim.status()).toBe('paused'));
  await fixture.whenStable();
  return { fixture, session, fakes, user: userEvent.setup() };
}

describe('SimControls', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    TestBed.resetTestingModule();
  });

  it('shows the sim time from snapshots and the speed as one radio group', async () => {
    const { fixture, session } = await setup();
    const region = screen.getByRole('region', { name: 'Sim time' });
    expect(within(region).getByTestId('sim-time').textContent).toBe('0:00:00.000');
    const group = within(region).getByRole('group', { name: 'Speed' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('value'))).toEqual(['0', '1', '10', '60']);
    expect(within(group).getByRole('radio', { name: 'Pause' })).toHaveProperty('checked', true);
    session.exec('sim.step', { ticks: 1234 });
    await waitFor(async () => {
      await fixture.whenStable();
      expect(within(region).getByTestId('sim-time').textContent).toBe('0:00:01.234');
    });
    expect(within(region).getByTestId('sim-time').getAttribute('aria-live')).toBeNull();
  });

  it('runs sim.setSpeed when a speed is chosen, and announces transitions only', async () => {
    const { fixture, session, user } = await setup();
    const region = screen.getByRole('region', { name: 'Sim time' });
    const announcement = within(region).getByTestId('sim-announcement');
    expect(announcement.getAttribute('aria-live')).toBe('polite');
    expect(announcement.textContent).toBe('The simulation is paused.');
    await user.click(within(region).getByRole('radio', { name: '10×' }));
    await fixture.whenStable();
    expect(session.entries().map((e) => [e.id, e.args])).toEqual([['sim.setSpeed', { speed: 10 }]]);
    expect(TestBed.inject(SimHost).speed()).toBe(10);
    expect(announcement.textContent).toBe(''); // running: nothing to announce
    expect(within(region).getByTestId('sim-effective').textContent).toContain('Running at');
  });

  it('says the sim stopped when it crashes', async () => {
    const { fixture, fakes } = await setup();
    fakes.workers[0].crash();
    await waitFor(async () => {
      await fixture.whenStable();
      expect(screen.getByTestId('sim-announcement').textContent).toBe('The simulation stopped.');
    });
    expect(screen.getByTestId('sim-effective').textContent).toContain('restart the simulation');
  });

  it('formats sim time and speeds', () => {
    expect(formatSimTime(0)).toBe('0:00:00.000');
    expect(formatSimTime(3_723_004)).toBe('1:02:03.004');
    expect(formatSimTime(-5)).toBe('0:00:00.000');
    expect(formatSpeed(9.26)).toBe('9.3×');
    expect(formatSpeed(42.4)).toBe('42×');
  });
});
