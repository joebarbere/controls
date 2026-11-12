import { autoWireArgs, freeAt, WIRING_TEST_CATALOG, wiringBench } from '../../testing';
import { suggestTermination } from './suggest';

/*
 * suggestTermination (D9, Apprentice preselection): the right hole, die and torque from the tools at
 * hand, so no surface encodes them. Every suggestion lands as the ideal termination the command
 * accepts at Apprentice.
 */

const catalog = WIRING_TEST_CATALOG;
const tools = catalog.tools;
const accessories = catalog.accessories;
const terminal = (device: string, id: string) => {
  const found = catalog.device({ id: device, version: 1 })?.terminals.find((t) => t.id === id);
  if (!found) throw new Error(`${device} ${id}`);
  return found;
};

describe('suggestTermination', () => {
  it('a screw terminal: the matching hole, the nominal strip and the torque driver at the marked torque', () => {
    const suggestion = suggestTermination(
      terminal('breaker.saltmere-1p-15a', 'line').methods,
      { awg: 14, stranding: 'solid' },
      tools,
    );
    expect(suggestion).toStrictEqual({
      method: 'screw',
      strip: { tool: { id: 'tool.test-stripper', version: 1 }, hole: 'h14s', lengthMm: 13 },
      accessory: null,
      clamp: { tool: { id: 'tool.test-torque', version: 1 }, torqueNm: 4 },
    });
  });

  it('falls back to a plain screwdriver, and to null without a stripper', () => {
    const noTorque = tools.filter((t) => t.id !== 'tool.test-torque');
    expect(
      suggestTermination(terminal('breaker.saltmere-1p-15a', 'line').methods, { awg: 14, stranding: 'solid' }, noTorque)
        ?.clamp,
    ).toStrictEqual({
      tool: { id: 'tool.test-screwdriver', version: 1 },
      torqueNm: null,
    });
    const noStripper = tools.filter((t) => t.id !== 'tool.test-stripper');
    expect(
      suggestTermination(
        terminal('breaker.saltmere-1p-15a', 'line').methods,
        { awg: 14, stranding: 'solid' },
        noStripper,
      ),
    ).toBeNull();
  });

  it('a stranded conductor on a ferrule-only spring cage gets a ferrule and the die that crimps it', () => {
    const suggestion = suggestTermination(
      terminal('tb.test-2', '1').methods,
      { awg: 14, stranding: 'stranded' },
      tools,
      accessories,
    );
    expect(suggestion).toStrictEqual({
      method: 'springCage',
      strip: { tool: { id: 'tool.test-stripper', version: 1 }, hole: 'h14st', lengthMm: 10 },
      accessory: {
        ref: { id: 'ferrule.test-14', version: 1 },
        tool: { id: 'tool.test-crimper', version: 1 },
        die: 'sq-14',
      },
      clamp: { tool: null, torqueNm: null },
    });
    expect(
      suggestTermination(terminal('tb.test-2', '1').methods, { awg: 14, stranding: 'stranded' }, tools, []),
    ).toBeNull();
  });

  it('takes the first method that can be completed, and nothing for a clip-only terminal or a gauge out of range', () => {
    expect(suggestTermination(terminal('tb.test-2', '2').methods, { awg: 14, stranding: 'solid' }, tools)?.method).toBe(
      'screw',
    );
    expect(
      suggestTermination(terminal('lamp.lumivane-12v-5w', 'a').methods, { awg: 14, stranding: 'solid' }, tools),
    ).toBeNull();
    expect(suggestTermination(terminal('tb.test-2', '1').methods, { awg: 10, stranding: 'solid' }, tools)).toBeNull();
  });

  it('every suggestion lands at Apprentice with no nicks and a full crimp', () => {
    const bus = wiringBench('apprentice');
    const cases: [string, number, string, { id: string; version: number }][] = [
      ['line', 3, 'breaker.saltmere-1p-15a', { id: 'conductor.test-14', version: 1 }],
      ['1', 4, 'tb.test-2', { id: 'conductor.test-14-str', version: 1 }],
      ['2', 4, 'tb.test-2', { id: 'conductor.test-14', version: 1 }],
    ];
    for (const [id, entity, device, ref] of cases) {
      const spec = catalog.device(ref)?.conductor;
      if (!spec) throw new Error(ref.id);
      const termination = suggestTermination(terminal(device, id).methods, spec, tools, accessories);
      const result = bus.exec(
        'wire.add',
        autoWireArgs({
          ref,
          a: null,
          b: { entity, terminal: id, termination },
          route: [freeAt(1100, 900, 400)],
          lengthMm: 900,
        }),
      );
      expect([id, result.ok]).toStrictEqual([id, true]);
      const landed = bus.state.connections.at(-1)?.b?.termination;
      expect(landed).toMatchObject({ auto: false, nickedStrandFraction: 0 });
      if (landed?.accessory) expect(landed.accessory.crimpQuality).toBe(1);
    }
  });
});
