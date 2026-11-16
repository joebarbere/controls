import { BUILTIN_CATALOG } from '@controls/catalog';
import { createWorld, type Difficulty } from '@controls/save-format';
import { createWorldBus, createWorldRegistry, defaultTool, pullRun, type World } from '@controls/world-model';
import { precheck } from './cable-gesture';
import {
  conduitRun,
  feedTape,
  pullArgs,
  pullRequest,
  pullRules,
  pullTrack,
  retractTape,
  startTape,
  type TapeState,
  twistTape,
} from './pull-model';
import { FISH_TAPE, PULL_RUN_STEPS, THHN_12 } from './pull-world.fakes';

/*
 * F3.4 part 2: the fish tape's pure half. The run through the `pull-world.fakes` conduit (connector 2
 * in the panel's drill site, stick 3, elbow 4, stick 5), its route and `wire.pull` arguments (checked
 * by the command's own `run`), and the minigame's state machine at each difficulty.
 */

const registry = createWorldRegistry();
function runWorld(difficulty: Difficulty = 'journeyman', steps = PULL_RUN_STEPS): World {
  const bus = createWorldBus(createWorld({ seed: 0, difficulty }), registry);
  for (const [id, args] of steps) {
    const result = bus.exec(id, args);
    if (!result.ok) throw new Error(`${id}: ${JSON.stringify(result.error)}`);
  }
  return bus.state;
}
const tape = () => defaultTool(BUILTIN_CATALOG, [], 'pull');
const at = (x: number, y: number, z: number) => ({ x, y, z });
const conduitWp = (p: { x: number; y: number; z: number }, entity: number) => ({
  kind: 'conduit',
  positionMm: p,
  entity,
  fixture: null,
  tool: null,
});
const freeWp = (p: { x: number; y: number; z: number }) => ({
  kind: 'free',
  positionMm: p,
  entity: null,
  fixture: null,
  tool: null,
});

describe('conduitRun (F3.4 part 2)', () => {
  it('walks the joints from any part; end a is the connector in the panel; elbow joints are hosted by the elbow', () => {
    const world = runWorld();
    for (const picked of [2, 3, 4, 5, 1]) {
      const run = conduitRun(world, BUILTIN_CATALOG, picked);
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.parts).toStrictEqual([2, 3, 4, 5]);
      expect(run.ends).toStrictEqual({ a: { enclosure: 1, entry: 'drill-top-1' }, b: null });
      expect(run.elbows).toStrictEqual([4]);
      expect(run.stretchesMm).toStrictEqual([625, 400]);
      expect(run.title).toBe('3/4 in conduit run of 4 parts (connector #2 to stick #5)');
      expect(run.route).toStrictEqual([
        freeWp(at(-880, 1100, 79)), // 200 mm into the panel
        conduitWp(at(-880, 1300, 79), 2),
        conduitWp(at(-880, 1325, 79), 2),
        conduitWp(at(-880, 1925, 79), 4), // into the elbow: hosted by it
        conduitWp(at(-702, 2103, 79), 4),
        conduitWp(at(-302, 2103, 79), 5),
        freeWp(at(-102, 2103, 79)), // 200 mm past the open end
      ]);
    }
  });

  it('pullRun measures the elbow along its centreline (+55.34 mm for 3/4 in) and counts its 90°', () => {
    const world = runWorld();
    const run = conduitRun(world, BUILTIN_CATALOG, 3);
    if (!run.ok) throw new Error(run.message);
    const reach = pullRun(world, BUILTIN_CATALOG, run.route);
    const chord = Math.hypot(178, 178);
    expect(reach.lengthMm).toBeCloseTo(25 + 600 + chord + 55.34 + 400, 1);
    expect(reach).toMatchObject({ bendDeg: 90, elbows: [4] });
  });

  it('a lone stick is a run of one part, end a at its first port; anything else is refused', () => {
    const world = runWorld('journeyman', PULL_RUN_STEPS.slice(0, 5));
    const stick = conduitRun(world, BUILTIN_CATALOG, 3);
    expect(stick).toMatchObject({ ok: true, parts: [2, 3] });
    expect(conduitRun(world, BUILTIN_CATALOG, 99)).toMatchObject({ ok: false, code: 'not-found' });
    const bare = runWorld('journeyman', [PULL_RUN_STEPS[0]]);
    expect(conduitRun(bare, BUILTIN_CATALOG, 1)).toMatchObject({ ok: false, code: 'not-a-conduit' });
  });
});

describe('pullRequest and pullArgs (F3.4 part 2)', () => {
  it('build the wire.pull the command accepts: the run route, the default cut, the rows in order, the tape', () => {
    const world = runWorld();
    const built = pullRequest(world, BUILTIN_CATALOG, [], 4, tape());
    if (!built.ok) throw new Error(built.message);
    const r = built.request;
    expect(r.toolRef).toStrictEqual(FISH_TAPE);
    expect(r.toolSource).toBe('Steel fish tape, 1/8 in x 50 ft (not on the belt)');
    expect(r.refusal).toBeNull();
    expect(r.rows).toHaveLength(1); // no spool on the belt: one row of the first conductor
    const key = `${THHN_12.id}@1`;
    expect(r.conductors.find((c) => c.key === key)?.title).toMatch(/^12 AWG/);
    const result = pullArgs(r, [
      { conductor: key, colour: 'black' },
      { conductor: key, colour: 'white' },
    ]);
    if (!result.ok) throw new Error(result.message);
    expect(result.args.conductors).toStrictEqual([
      { ref: THHN_12, colour: { base: 'black', stripe: null } },
      { ref: THHN_12, colour: { base: 'white', stripe: null } },
    ]);
    expect(result.args.route).toStrictEqual(r.run.route);
    expect(result.args.tool).toStrictEqual(FISH_TAPE);
    expect(precheck(registry.get('wire.pull'), world, result.args)).toBeNull();
  });

  it('the belt’s conductor spools are the first rows; unfilled rows and missing colours are named', () => {
    const world = runWorld();
    const built = pullRequest(world, BUILTIN_CATALOG, [null, THHN_12, null], 2, tape());
    if (!built.ok) throw new Error(built.message);
    expect(built.request.rows).toStrictEqual([{ conductor: `${THHN_12.id}@1`, colour: 'black' }]);
    expect(pullArgs(built.request, [])).toStrictEqual({ ok: false, message: 'Add at least one conductor.' });
    expect(pullArgs(built.request, [{ conductor: null, colour: null }])).toMatchObject({
      message: 'Conductor 1: choose a conductor.',
    });
    expect(pullArgs(built.request, [{ conductor: `${THHN_12.id}@1`, colour: 'bare' }])).toMatchObject({
      message: 'Conductor 1: choose a colour.',
    });
  });

  it('a run beyond the tape is refused before the game, in the command’s words', () => {
    const world = runWorld();
    const real = BUILTIN_CATALOG.tool(FISH_TAPE);
    if (!real) throw new Error('no fish tape');
    const short = { ...real, pull: { lengthMm: 1000, maxBendDeg: 360 } };
    const built = pullRequest(world, BUILTIN_CATALOG, [], 3, { tool: short, ref: FISH_TAPE, slot: null });
    if (!built.ok) throw new Error(built.message);
    expect(built.request.refusal).toBe(
      'Steel fish tape, 1/8 in x 50 ft reaches 1000 mm; this conduit run is 1333 mm (beyond-tool-capacity)',
    );
    const stiff = { ...short, pull: { lengthMm: 15240, maxBendDeg: 0 } };
    const bent = pullRequest(world, BUILTIN_CATALOG, [], 3, { tool: stiff, ref: FISH_TAPE, slot: null });
    expect(bent.ok && bent.request.refusal).toMatch(/90° \(1 elbows\) \(beyond-tool-capacity\)$/);
  });
});

describe('the minigame (F3.4 part 2)', () => {
  const world = runWorld();
  const run = conduitRun(world, BUILTIN_CATALOG, 2);
  if (!run.ok) throw new Error(run.message);
  const track = pullTrack(run);

  it('the track is a feed per started metre of each stretch, and one station per elbow', () => {
    expect(track).toStrictEqual([
      { kind: 'feed', stretch: 0 },
      { kind: 'elbow', elbow: 4, index: 0 },
      { kind: 'feed', stretch: 1 },
    ]);
    expect(pullTrack({ elbows: [], stretchesMm: [2500] })).toHaveLength(3);
    expect(pullTrack({ elbows: [7], stretchesMm: [0, 0] })).toStrictEqual([{ kind: 'elbow', elbow: 7, index: 0 }]);
  });

  it('feed, twist at the elbow, feed: through; the same keys always do the same', () => {
    const rules = pullRules('journeyman');
    let s: TapeState = startTape(track);
    const events: string[] = [];
    for (const key of ['feed', 'twist', 'feed'] as const) {
      const step = key === 'feed' ? feedTape(s, rules) : twistTape(s);
      s = step.state;
      events.push(step.event);
    }
    expect(events).toStrictEqual(['reachedElbow', 'twisted', 'through']);
    expect(s).toMatchObject({ at: 3, jams: 0, phase: 'through' });
  });

  it('pushing into an elbow jams; at the difficulty’s limit the tape kinks', () => {
    const limits: [Difficulty, number | null][] = [
      ['trainee', null],
      ['apprentice', 3],
      ['journeyman', 2],
      ['realistic', 1],
    ];
    for (const [difficulty, limit] of limits) {
      const rules = pullRules(difficulty);
      expect(rules.jamLimit).toBe(limit);
      expect(rules.skip).toBe(difficulty === 'trainee');
      let s = feedTape(startTape(track), rules).state;
      const events: string[] = [];
      for (let i = 0; i < 4; i++) {
        const step = feedTape(s, rules);
        s = step.state;
        events.push(step.event);
      }
      const kinkAt = limit === null ? -1 : limit - 1;
      expect(events.indexOf('kinked')).toBe(kinkAt);
      expect(s.phase).toBe(limit === null ? 'feeding' : 'kinked');
    }
  });

  it('twisting off an elbow only spins; pulling back steps back but keeps the jams', () => {
    const rules = pullRules('apprentice');
    let s = startTape(track);
    expect(twistTape(s).event).toBe('twistedFree');
    expect(retractTape(s).event).toBe('atStart');
    s = feedTape(s, rules).state;
    s = feedTape(s, rules).state; // a jam
    const back = retractTape(s);
    expect(back.event).toBe('retracted');
    expect(back.state).toMatchObject({ at: 0, jams: 1 });
    expect(feedTape({ ...s, phase: 'kinked' }, rules).event).toBe('idle');
  });
});
