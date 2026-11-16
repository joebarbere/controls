import { BUILTIN_CATALOG } from '@controls/catalog';
import type { World } from '@controls/world-model';
import { cableRunBus } from '@controls/world-model/testing';
import {
  labelCommand,
  labelRequest,
  landingEnd,
  landingTarget,
  nextToLand,
  stripArgs,
  stripDraftProblems,
  stripRequest,
} from './wiring-model';

/*
 * F3.2 part 4: the strip, landing and label models on `cableRunBus` (14/2 NM-B from a box's top clamp
 * to a panel's bottom knockout; 200 mm tail at the box, 300 mm at the panel; Trainee).
 */

const ref = (id: string) => ({ id, version: 1 });
const EMPTY_BELT = Array.from({ length: 9 }, () => null);
const at = (w: World, difficulty: World['difficulty']): World => ({ ...w, difficulty });

describe('the strip model (F3.2 part 4)', () => {
  it('bounds each box end by its tail less 6.35 mm of sheath; Trainee and Apprentice prefill, Journeyman doesn’t', () => {
    const w = cableRunBus().state;
    const built = stripRequest(w, BUILTIN_CATALOG, EMPTY_BELT, 1);
    if (!built.ok) throw new Error(built.message);
    expect(built.request).toMatchObject({
      cableId: 1,
      cableTitle: 'NM-B 14/2 with ground, copper, 600 V',
      ends: [
        {
          end: 'a',
          tailMm: 200,
          strippedMm: 0,
          maxMm: 193,
          place: expect.stringMatching(/^in 2-gang .* #1, entry clamp-top-1$/),
        },
        { end: 'b', tailMm: 300, strippedMm: 0, maxMm: 293 },
      ],
      draft: { tool: 'tool.veltmark-ws-nm12@1', a: '193', b: '293' },
    });
    expect(built.request.strippers.map((t) => t.key)).toStrictEqual(['tool.veltmark-ws-nm12@1']);
    const journeyman = stripRequest(at(w, 'journeyman'), BUILTIN_CATALOG, EMPTY_BELT, 1);
    expect(journeyman.ok && journeyman.request.draft).toStrictEqual({ tool: 'tool.veltmark-ws-nm12@1', a: '', b: '' });
    expect(stripRequest(w, BUILTIN_CATALOG, EMPTY_BELT, 7)).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('a blank end is left alone; one strip per filled-in end; blanks everywhere or text are problems', () => {
    const built = stripRequest(cableRunBus({ strip: { a: 100, b: 0 } }).state, BUILTIN_CATALOG, EMPTY_BELT, 1);
    if (!built.ok) throw new Error(built.message);
    const r = built.request;
    expect(r.ends[0]).toMatchObject({ strippedMm: 100 });
    expect(stripDraftProblems(r, { tool: null, a: '', b: '' }).map((p) => p.field)).toStrictEqual(['tool']);
    const tool = 'tool.veltmark-ws-nm12@1';
    expect(stripDraftProblems(r, { tool, a: '', b: '' })).toStrictEqual([
      { field: 'a', message: 'Enter how much jacket to strip at one end at least.' },
    ]);
    expect(stripDraftProblems(r, { tool, a: '1.5', b: 'x' }).map((p) => p.field)).toStrictEqual(['a', 'b']);
    expect(stripArgs(r, { tool, a: '', b: ' 250 ' })).toStrictEqual([
      { id: 1, end: 'b', jacketMm: 250, tool: ref('tool.veltmark-ws-nm12') },
    ]);
    expect(stripArgs(r, { tool, a: 'x', b: '' })).toBeNull();
  });
});

describe('the landing model (F3.2 part 4)', () => {
  it('a cable conductor with a free end is a target; anything else is refused with a reason', () => {
    const w = cableRunBus({ strip: { a: 150, b: 250 } }).state;
    const built = landingTarget(w, 2);
    expect(built).toMatchObject({
      ok: true,
      target: { freeEnds: ['a', 'b'], title: 'white conductor 2 of cable 1 (wire 2)' },
    });
    expect(landingTarget(w, 99)).toMatchObject({ ok: false, code: 'not-found' });
    const landed = cableRunBus({ strip: { a: 150, b: 250 }, land: true }).state;
    expect(landingTarget(landed, 1)).toMatchObject({ ok: true, target: { freeEnds: ['a'] } });
  });

  it('the end a pick lands is the free end whose stripped tail reaches the terminal', () => {
    const w = cableRunBus({ strip: { a: 150, b: 250 } }).state;
    const built = landingTarget(w, 1);
    if (!built.ok) throw new Error(built.message);
    // Block 3's terminal b sits in the panel, out of the box end's reach.
    expect(landingEnd(w, BUILTIN_CATALOG, built.target, { x: 100, y: 659, z: -8 })).toBe('b');
    // A point by the box's clamp: end a.
    expect(landingEnd(w, BUILTIN_CATALOG, built.target, { x: 28, y: 50, z: 40 })).toBe('a');
    // Out of every reach: the first free end (the command refuses it, tail-too-short).
    expect(landingEnd(w, BUILTIN_CATALOG, built.target, { x: 5000, y: 0, z: 0 })).toBe('a');
  });

  it('landing goes on with the next conductor of the cable free at the same end, wrapping, until none', () => {
    const w = cableRunBus({ strip: { a: 150, b: 250 } }).state;
    expect(nextToLand(w, 1, 1, 'b')).toBe(2);
    expect(nextToLand(w, 1, 3, 'b')).toBe(1);
    const landed = cableRunBus({ strip: { a: 150, b: 250 }, land: true }).state;
    expect(nextToLand(landed, 1, 3, 'b')).toBeNull();
    expect(nextToLand(landed, 1, 3, 'a')).toBe(1);
  });
});

describe('the label model (F3.2 part 4)', () => {
  it('a wire or a cable with the label maker the default-tool rule finds; empty text removes a label', () => {
    const w = cableRunBus({ label: 'L1' }).state;
    const wire = labelRequest(w, BUILTIN_CATALOG, EMPTY_BELT, { kind: 'connection', id: 1 });
    if (!wire.ok) throw new Error(wire.message);
    expect(wire.request).toMatchObject({
      title: 'Wire 1, the black conductor of cable 1',
      current: 'L1',
      draft: { tool: 'tool.penmarrow-lp-12@1', text: 'L1' },
    });
    expect(labelCommand(wire.request, { tool: 'tool.penmarrow-lp-12@1', text: '' })).toStrictEqual({
      ok: true,
      id: 'wire.label',
      args: { id: 1, text: null, tool: ref('tool.penmarrow-lp-12') },
    });
    const cable = labelRequest(w, BUILTIN_CATALOG, EMPTY_BELT, { kind: 'cable', id: 1 });
    if (!cable.ok) throw new Error(cable.message);
    expect(cable.request).toMatchObject({ title: 'Cable 1, NM-B 14/2 with ground, copper, 600 V', current: null });
    expect(labelCommand(cable.request, { tool: 'tool.penmarrow-lp-12@1', text: 'K1' })).toMatchObject({
      ok: true,
      id: 'cable.label',
      args: { id: 1, text: 'K1' },
    });
    expect(labelCommand(cable.request, { tool: 'tool.penmarrow-lp-12@1', text: '' })).toMatchObject({
      ok: false,
      problem: { field: 'text' },
    });
    expect(labelCommand(cable.request, { tool: null, text: 'K1' })).toMatchObject({
      ok: false,
      problem: { field: 'tool' },
    });
    expect(labelRequest(w, BUILTIN_CATALOG, EMPTY_BELT, { kind: 'cable', id: 4 })).toMatchObject({ ok: false });
  });
});
