import { TestBed } from '@angular/core/testing';
import { BUILTIN_CATALOG } from '@controls/catalog';
import { KEY_PLATFORM, Session } from '@controls/feature-session';
import type { Difficulty } from '@controls/save-format';
import type { World } from '@controls/world-model';
import {
  accessoryChoices,
  argsOf,
  draftOf,
  landingRefusal,
  promptMode,
  stripProblems,
  type TerminationRequest,
  terminationRequest,
  toolsAtHand,
  torqueProblems,
} from './termination-model';

const THHN = { id: 'conductor.tallowmere-thhn-14-solid', version: 1 };
const BLOCK = { id: 'tb.quennick-st4', version: 1 };
const LAMP = { id: 'lamp.lumivane-12v-5w', version: 1 };
const EMPTY_BELT = Array.from({ length: 9 }, () => null);
const ref = (id: string) => ({ id, version: 1 });
const TERMINAL = { entity: 1, terminal: 'a' };

/** The ideal landing of 14 AWG solid THHN on the block's screw clamp with the built-in tools. */
const IDEAL = {
  method: 'screw',
  strip: { tool: ref('tool.veltmark-ws-1018'), hole: 'sol14', lengthMm: 9 },
  accessory: null,
  clamp: { tool: ref('tool.calderyn-ts-03'), torqueNm: 0.6 },
};

/** A sandbox at `difficulty` holding one block (entity 1) and one lamp (entity 2). */
function world(difficulty: Difficulty): World {
  TestBed.configureTestingModule({ providers: [{ provide: KEY_PLATFORM, useValue: 'other' }] });
  const session = TestBed.inject(Session);
  session.newSandbox({ seed: 0, difficulty });
  for (const [r, x] of [
    [BLOCK, -100],
    [LAMP, 0],
  ] as const) {
    const placed = session.exec('entity.place', {
      ref: r,
      positionMm: { x, y: 0, z: 40 },
      orientationMdeg: { yaw: 0, pitch: 0, roll: 0 },
      mountedOn: null,
    });
    expect(placed.ok).toBe(true);
  }
  return session.world();
}

function request(difficulty: Difficulty, belt: readonly ({ id: string; version: number } | null)[] = EMPTY_BELT) {
  const w = world(difficulty);
  const built = terminationRequest(w, BUILTIN_CATALOG, belt, THHN, 'a', TERMINAL, 'block #1, terminal 1');
  if (!built.ok || built.request === null) throw new Error('no request');
  return { w, request: built.request as TerminationRequest };
}

describe('promptMode (D9)', () => {
  it('Trainee lands automatically; Apprentice preselects; Journeyman and Realistic start blank', () => {
    expect(promptMode('trainee')).toBe('automatic');
    expect(promptMode('apprentice')).toBe('preselected');
    expect(promptMode('journeyman')).toBe('blank');
    expect(promptMode('realistic')).toBe('blank');
  });
});

describe('toolsAtHand', () => {
  it('lists the belt’s tools first, in slot order, then every other catalogue tool once', () => {
    const belt = [ref('prop.box'), ref('tool.veltmark-sd-2'), null, ref('tool.veltmark-ws-1018'), ...EMPTY_BELT];
    const tools = toolsAtHand(BUILTIN_CATALOG, belt.slice(0, 9));
    expect(tools.slice(0, 2).map((t) => t.label)).toStrictEqual([
      'Screwdriver, #2 Phillips / 1/4 in slotted (belt slot 2)',
      'Wire strippers, 10–18 AWG solid / 12–20 AWG stranded (belt slot 4)',
    ]);
    expect(new Set(tools.map((t) => t.ref.id)).size).toBe(tools.length);
    expect(tools).toHaveLength(BUILTIN_CATALOG.tools.length);
    expect(tools.at(-1)?.label).toMatch(/\(not on the belt\)$/);
  });
});

describe('terminationRequest', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('Trainee: no prompt, the end lands auto', () => {
    const w = world('trainee');
    expect(terminationRequest(w, BUILTIN_CATALOG, EMPTY_BELT, THHN, 'a', TERMINAL, 't')).toStrictEqual({
      ok: true,
      request: null,
    });
  });

  it('Apprentice: every field preselected from suggestTermination, and it lands as the ideal termination', () => {
    const { w, request: r } = request('apprentice');
    expect(r.mode).toBe('preselected');
    expect(r.conductorSize).toBe('14 AWG solid');
    expect(r.methods.map((m) => m.method)).toStrictEqual(['screw']);
    expect(r.draft).toStrictEqual({
      method: 'screw',
      stripTool: 'tool.veltmark-ws-1018@1',
      hole: 'sol14',
      stripLengthMm: '9',
      accessory: 'none',
      crimpTool: 'tool.veltmark-cr-2210@1',
      die: null,
      driver: 'tool.calderyn-ts-03@1',
      torqueNm: '0.6',
    });
    expect(r.note).toBeNull();
    expect(argsOf(r, r.draft)).toStrictEqual(IDEAL);
    expect(landingRefusal(w, BUILTIN_CATALOG, THHN, 'a', TERMINAL, IDEAL)).toBeNull();
  });

  it('Journeyman: only the tools in hand (and the one method); hole, length and torque are blank', () => {
    const { request: r } = request('journeyman');
    expect(r.mode).toBe('blank');
    expect(r.draft).toStrictEqual({
      method: 'screw',
      stripTool: 'tool.veltmark-ws-1018@1',
      hole: null,
      stripLengthMm: '',
      accessory: 'none',
      crimpTool: 'tool.veltmark-cr-2210@1',
      die: null,
      driver: 'tool.calderyn-ts-03@1',
      torqueNm: '',
    });
    expect(argsOf(r, r.draft)).toBeNull();
    expect(stripProblems(r, r.draft).map((p) => p.field)).toStrictEqual(['hole', 'stripLengthMm']);
    expect(torqueProblems(r, r.draft).map((p) => p.field)).toStrictEqual(['torqueNm']);
  });

  it('Realistic prompts as Journeyman', () => {
    const { request: r } = request('realistic');
    expect(r.mode).toBe('blank');
    expect(r.draft).toMatchObject({ hole: null, stripLengthMm: '', die: null, torqueNm: '' });
  });

  it('the belt’s tools come first: a plain screwdriver on the belt is the driver in hand', () => {
    const belt = [ref('tool.veltmark-sd-2'), ...EMPTY_BELT.slice(1)];
    const { request: r } = request('journeyman', belt);
    expect(r.draft.driver).toBe('tool.veltmark-sd-2@1');
    const draft = { ...r.draft, hole: 'sol14', stripLengthMm: '9' };
    expect(torqueProblems(r, draft)).toStrictEqual([]); // no setting on a plain screwdriver
    expect(argsOf(r, draft)?.clamp).toStrictEqual({ tool: ref('tool.veltmark-sd-2'), torqueNm: null });
  });

  it('a clip-only terminal is refused before any prompt (wrong-method)', () => {
    const w = world('journeyman');
    const built = terminationRequest(w, BUILTIN_CATALOG, EMPTY_BELT, THHN, 'b', { entity: 2, terminal: 'a' }, 'lamp');
    expect(built).toMatchObject({ ok: false, code: 'wrong-method' });
  });

  it('a ferrule or lug needs a crimper and a die; the accessories offered are the method’s kinds', () => {
    const { request: r } = request('journeyman');
    expect(accessoryChoices(r, r.draft).map((a) => a.kind)).toContain('ferrule');
    const ferrule = accessoryChoices(r, r.draft).find((a) => a.id === 'ferrule.thimbleby-14');
    const draft = { ...r.draft, hole: 'sol14', stripLengthMm: '9', accessory: `${ferrule?.id}@1` };
    expect(stripProblems(r, draft).map((p) => p.field)).toStrictEqual(['die']);
  });
});

describe('landingRefusal (the command’s own check, shown in the prompt)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('refuses a setting outside the driver’s range, a driver that can’t turn the screw and a wrong accessory', () => {
    const { w, request: r } = request('journeyman');
    const draft = { ...draftOf(IDEAL, r.draft) };
    const at = (args: ReturnType<typeof argsOf>) =>
      args && landingRefusal(w, BUILTIN_CATALOG, THHN, 'a', TERMINAL, args)?.code;
    expect(at(argsOf(r, { ...draft, torqueNm: '3' }))).toBe('beyond-tool-capacity');
    expect(at(argsOf(r, { ...draft, driver: 'tool.veltmark-nd-516@1' }))).toMatch(/^wrong-(tool|drive)$/);
    expect(
      at(
        argsOf(r, {
          ...draft,
          accessory: 'lug.thimbleby-ring-red-8@1',
          crimpTool: 'tool.veltmark-cr-2210@1',
          die: 'red',
        }),
      ),
    ).toBe('wrong-accessory');
    expect(landingRefusal(w, BUILTIN_CATALOG, THHN, 'a', TERMINAL, 'auto')?.code).toBe('termination-required');
  });
});
