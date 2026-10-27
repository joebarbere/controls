import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { createWorld } from '@controls/save-format';
import { worldHash } from '@controls/world-model';
import { Session } from './session';

const crate = { id: 'prop.crate', version: 1 };
const place = { ref: crate, positionMm: { x: 10, y: 0, z: -20 } };

describe('Session', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('starts from an empty seed-0 world and exposes it as a signal with its hash', () => {
    const session = TestBed.inject(Session);
    expect(session.world()).toEqual(createWorld({ seed: 0 }));
    expect(session.hash()).toBe(worldHash(createWorld({ seed: 0 })));
    expect(session.entries()).toEqual([]);
  });

  it('changes the world only through exec, and updates the signals', () => {
    const session = TestBed.inject(Session);
    const before = session.hash();
    expect(session.exec('entity.place', place)).toMatchObject({ ok: true, entry: { seq: 0, id: 'entity.place' } });
    expect(session.world().entities.map((e) => e.id)).toEqual([1]);
    expect(session.hash()).not.toBe(before);
    expect(session.canUndo()).toBe(true);
    expect(session.entries().map((e) => e.id)).toEqual(['entity.place']);

    expect(session.exec('edit.undo').ok).toBe(true);
    expect(session.hash()).toBe(before);
    expect(session.canRedo()).toBe(true);
  });

  it('returns typed errors for bad commands and changes nothing', () => {
    const session = TestBed.inject(Session);
    const world = session.world();
    expect(session.exec('entity.place', { ref: crate })).toMatchObject({ ok: false, error: { kind: 'invalid-args' } });
    expect(session.exec('no.such')).toMatchObject({ ok: false, error: { kind: 'unknown-command' } });
    expect(session.world()).toBe(world);
    expect(session.entries()).toEqual([]);
  });

  it('runs view commands through onCommand handlers without touching the world hash', () => {
    const session = TestBed.inject(Session);
    session.exec('entity.place', place);
    const hash = session.hash();
    const seen: string[] = [];
    const off = session.onCommand('view.resetLayout', (e) => seen.push(`${e.entry.seq}`));
    session.exec('view.resetLayout');
    expect(seen).toEqual(['1']);
    expect(session.hash()).toBe(hash);
    expect(session.entries().map((e) => e.id)).toEqual(['entity.place', 'view.resetLayout']);
    off();
    session.exec('view.resetLayout');
    expect(seen).toEqual(['1']);
  });

  it('evaluates when against history and UI context keys', () => {
    const session = TestBed.inject(Session);
    expect(session.isEnabled('edit.undo')).toBe(false);
    session.exec('entity.place', place);
    expect(session.isEnabled('edit.undo')).toBe(true);
    expect(session.isEnabled('edit.redo')).toBe(false);
    session.setContext('mode', 'work');
    expect(session.contextKeys()).toEqual({ mode: 'work', 'history.canUndo': true, 'history.canRedo': false });
    session.setContext('mode', null);
    expect(session.contextKeys()).toEqual({ 'history.canUndo': true, 'history.canRedo': false });
  });

  it('starts a new session with a fresh history and log, and writes a replay log', () => {
    const session = TestBed.inject(Session);
    session.exec('entity.place', place);
    const world = createWorld({ seed: 77 });
    session.start(world);
    expect(session.world()).toBe(world);
    expect(session.canUndo()).toBe(false);
    expect(session.entries()).toEqual([]);
    session.exec('entity.place', place);
    expect(session.replayLog()).toMatchObject({ schemaVersion: 1, initialWorld: world, entries: [{ seq: 0 }] });
  });

  it('exposes the test hook only with ?e2e=1', () => {
    const fakeWindow: Record<string, unknown> = { location: { search: '?e2e=1' } };
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: { defaultView: fakeWindow } }],
    });
    TestBed.inject(Session);
    const hook = fakeWindow['__controlsSession'] as {
      exec(id: string, args?: unknown): { ok: boolean };
      hash(): string;
      world(): unknown;
      entries(): unknown[];
      hashWorld(json: unknown): string | null;
    };
    expect(hook.exec('entity.place', place).ok).toBe(true);
    expect(hook.entries()).toHaveLength(1);
    expect(hook.hash()).toBe(worldHash(hook.world() as ReturnType<typeof createWorld>));
    expect(hook.hashWorld(createWorld({ seed: 0 }))).toBe(worldHash(createWorld({ seed: 0 })));
    expect(hook.hashWorld({ schemaVersion: 1 })).toBeNull();
    TestBed.resetTestingModule();
    expect(fakeWindow['__controlsSession']).toBeUndefined();

    TestBed.inject(Session);
    expect((window as unknown as Record<string, unknown>)['__controlsSession']).toBeUndefined();
  });
});
