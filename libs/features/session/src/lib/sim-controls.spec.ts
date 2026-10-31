import { TestBed } from '@angular/core/testing';
import { screen, waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { FakeSimWorker } from '../testing/fake-sim-worker';
import { Session } from './session';
import { formatLastSolve, formatSimTime, formatSpeed, lastSolveOf, SimControls } from './sim-controls';
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

  it('shows the last solve only when the snapshot holds islands: no islands is no solve, never one at tick 0 (F2.6)', async () => {
    const { fixture, session } = await setup();
    const lastSolve = () => screen.getByTestId('sim-last-solve').textContent;
    // The workshop has no circuit: the snapshot holds no islands, and writes lastSolveTick 0.
    session.exec('sim.step', { ticks: 25 });
    await waitFor(async () => {
      await fixture.whenStable();
      expect(screen.getByTestId('sim-time').textContent).toBe('0:00:00.025');
    });
    expect(lastSolve()).toBe('None');
    // A battery shorted by a lead: one island, solved at the command (tick 25), then at each cadence tick.
    session.exec('entity.place', {
      ref: { id: 'battery.ferrovane-12v-7ah', version: 1 },
      positionMm: { x: 0, y: 0, z: 0 },
    });
    const lead = { id: 'lead.quillfern-test-1m', version: 1 };
    const a = { entity: 1, terminal: 'pos' };
    const b = { entity: 1, terminal: 'neg' };
    session.exec('lead.connect', { ref: lead, a, b });
    await waitFor(async () => {
      await fixture.whenStable();
      expect(lastSolve()).toBe('0:00:00.025');
    });
    session.exec('sim.step', { ticks: 20 });
    await waitFor(async () => {
      await fixture.whenStable();
      expect(lastSolve()).toBe('0:00:00.040');
    });
    // Deleting the circuit leaves no islands again: back to none, not 0:00:00.000.
    session.exec('entity.delete', { id: 1 });
    await waitFor(async () => {
      await fixture.whenStable();
      expect(lastSolve()).toBe('None');
    });
  });

  it('keys the last solve off islandCount', () => {
    expect(lastSolveOf({ islandCount: 0, lastSolveTick: 0 })).toBeNull();
    expect(lastSolveOf({ islandCount: 2, lastSolveTick: 0 })).toBe(0);
    expect(lastSolveOf({ islandCount: 1, lastSolveTick: 1230 })).toBe(1230);
    expect(formatLastSolve(null)).toBe('None');
    expect(formatLastSolve(0)).toBe('0:00:00.000');
    expect(formatLastSolve(1230)).toBe('0:00:01.230');
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

  it('says "Catching up" while the worker is far behind what was commanded, and announces it', async () => {
    const { fixture, session, fakes } = await setup();
    fakes.workers[0].hold(); // the worker stops answering: progress stays put
    session.exec('sim.step', { ticks: 600_000 });
    await waitFor(async () => {
      await fixture.whenStable();
      expect(screen.getByTestId('sim-catching-up').textContent).toContain('Catching up: 0:00:00.000 of 0:10:00.000');
    });
    expect(TestBed.inject(SimHost).catchingUp()).toBe(true);
    expect(screen.getByTestId('sim-announcement').textContent).toBe('The simulation is catching up.');
    fakes.workers[0].release();
    await waitFor(async () => {
      await fixture.whenStable();
      expect(screen.queryByTestId('sim-catching-up')).toBeNull();
    });
    expect(TestBed.inject(SimHost).catchingUp()).toBe(false);
  });
});
