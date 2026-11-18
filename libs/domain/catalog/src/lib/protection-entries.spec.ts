import { realMakerIn } from '../testing/real-makers';
import { BUILTIN_CATALOG } from './builtin';
import type { DeviceDefinition } from './device';

/*
 * P4 F4.2 part 2's service and plug-on breaker entries (content PR 14): their layout, terminals and
 * mounts. Their electrical behaviour is `sim-core`'s `plug-on-entries.spec.ts` and `service-entry.spec.ts`.
 *
 * - The bus pitch is 25 mm (game-design, ADR 0019), so a one-pole breaker is 25 mm along the column and
 *   a two-pole one 50 mm: it fills both its stabs' spaces, so no breaker can share its second stab
 *   (`checkMount` compares widths along the column).
 * - The load terminals follow the read terminations page: 15 and 20 A two copper 14–10 AWG; 30 A and
 *   the GFCI and AFCI one 14–8 AWG CU/AL; 40 and 50 A a box lug for one 8–2 AWG CU/AL.
 * - The meter base's lugs take one 2 AWG–4/0 conductor, CU/AL, stranded; `x0` is out of reach.
 */

const KINDS = ['breaker.plugOn1p', 'breaker.plugOn2p', 'breaker.gfci1p', 'breaker.afci1p'];
const breakers = BUILTIN_CATALOG.devices.filter((d) => KINDS.includes(d.model.kind));
const service = BUILTIN_CATALOG.device({ id: 'service.larkmoor-sp25-overhead', version: 1 }) as DeviceDefinition;
const rated = (d: DeviceDefinition) => d.model.params['ratedCurrentA'] as number;
const screw = (d: DeviceDefinition, terminal: string) => {
  const t = d.terminals.find((x) => x.id === terminal);
  if (t === undefined) throw new Error(`${d.id} has no ${terminal}`);
  return t.methods[0];
};

/** No URL in a P4 content source string (makers and URLs go in ADR reference notes). */
const URL = /http|www\./i;

describe('the P4 plug-on breaker entries', () => {
  it('plug onto a bus column: 25 mm per pole, one stab contact per pole, the second one stab on', () => {
    for (const d of breakers) {
      const twoPole = d.model.kind === 'breaker.plugOn2p';
      expect(d.mounts).toHaveLength(1);
      const fit = d.mounts[0];
      expect([d.id, fit.type, fit.widthMm, d.sizeMm?.widthMm]).toStrictEqual([
        d.id,
        'busStab',
        twoPole ? 50 : 25,
        twoPole ? 50 : 25,
      ]);
      expect(fit.contacts.map((c) => [c.id, c.terminal, c.host, c.positionOffset])).toStrictEqual(
        twoPole
          ? [
              ['line1', 'line1', 'stab', 0],
              ['line2', 'line2', 'stab', 1],
            ]
          : [['line1', 'line', 'stab', 0]],
      );
      // The stab jaws are probe-reachable, never wire terminals.
      for (const c of fit.contacts) {
        expect(d.terminals.find((t) => t.id === c.terminal)).toMatchObject({ methods: [], access: 'clip' });
      }
    }
  });

  it('take the read terminations: 15/20 A two Cu 14–10, 30 A and GFCI/AFCI one 14–8 CU/AL, 40/50 A a lug for 8–2', () => {
    for (const d of breakers) {
      const loads = d.terminals.filter((t) => t.methods.length > 0 && t.id !== 'pigtail').map((t) => t.id);
      for (const id of loads) {
        const m = screw(d, id);
        const sensing = d.model.kind === 'breaker.gfci1p' || d.model.kind === 'breaker.afci1p';
        const want = sensing
          ? [14, 8, 1, true, 'pressurePlate', 4]
          : rated(d) <= 20
            ? [14, 10, 2, false, 'pressurePlate', 4]
            : rated(d) === 30
              ? [14, 8, 1, true, 'pressurePlate', 4]
              : [8, 2, 1, true, 'boxLug', 5];
        expect([
          d.id,
          id,
          m.awgRange.smallest,
          m.awgRange.largest,
          m.ratedConductors,
          m.alRated,
          m.clampType,
          m.torqueNm,
        ]).toStrictEqual([d.id, id, ...want]);
      }
    }
  });

  it('GFCI and AFCI breakers have a load neutral and a pigtail terminal and a momentary test button', () => {
    for (const d of breakers.filter((x) => x.model.kind === 'breaker.gfci1p' || x.model.kind === 'breaker.afci1p')) {
      expect(d.terminals.map((t) => t.id)).toStrictEqual(['line', 'load', 'loadNeutral', 'pigtail']);
      expect(d.controls).toStrictEqual([
        { id: 'on', label: 'Handle on', type: 'toggle' },
        { id: 'test', label: 'Test', type: 'momentary' },
      ]);
    }
  });
});

describe('the P4 service entry', () => {
  it('lands 2 AWG–4/0 CU/AL stranded on each of its three meter-base lugs; x0 is out of reach', () => {
    for (const id of ['l1', 'n', 'l2']) {
      expect(screw(service, id)).toMatchObject({
        awgRange: { smallest: 2, largest: -3 },
        stranding: ['stranded'],
        alRated: true,
        ratedConductors: 1,
        maxConductors: 1,
        clampType: 'boxLug',
        drives: ['hexSocket'],
        torqueNm: 31,
      });
    }
    expect(service.terminals.find((t) => t.id === 'x0')).toMatchObject({ methods: [], access: 'none' });
    // The catalogue's aluminium service-entrance conductors both fit: 2 AWG and 4/0 (= −3).
    for (const awg of [2, -3]) {
      const conductor = BUILTIN_CATALOG.devices.find(
        (d) => d.conductor?.awg === awg && d.conductor.material.key === 'aluminiumAa8000',
      );
      expect(conductor, `${awg}`).toBeDefined();
    }
  });
});

describe('the P4 F4.2 part 2 entries’ sources', () => {
  it('name no real maker and carry no URL, and every game-design source says so', () => {
    const conductor = BUILTIN_CATALOG.device({ id: 'conductor.quorvale-xhhw2-al-2-compact', version: 1 });
    for (const d of [...breakers, service, conductor as DeviceDefinition]) {
      expect(realMakerIn([d.brand, d.modelName].join(' '))).toBeNull();
      for (const s of d.sources) {
        expect([d.id, s.id, realMakerIn(s.citation)]).toStrictEqual([d.id, s.id, null]);
        expect(`${d.id} ${s.id}: ${s.citation}`).not.toMatch(URL);
        if (s.kind === 'game-design') expect(s.citation, `${d.id} ${s.id}`).toMatch(/game-design/);
      }
    }
  });
});
