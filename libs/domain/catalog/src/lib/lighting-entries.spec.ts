import { BUILTIN_CATALOG } from './builtin';
import type { DeviceDefinition, TerminalMethodSpec } from './device';
import { LedDriverParams, LIGHTING_MODEL_KINDS } from './model-kinds-lighting';

/*
 * P4 F4.1 part 1's shipped lighting entries (plan D10, D11; ADR 0021 part 3): the Castellby wall
 * switches, dimmer and lampholders, the Lumivane A19 bulbs (incandescent and LED) and the Fennisby LED
 * wall light. `builtin.spec.ts` checks the entries before them; the sim-core golden
 * `devices/lighting/shipped.spec.ts` checks these behave as the test-only ones the models were built on.
 *
 * Every derived value is recomputed here with its hand calculation (content-designer rule: at most
 * 0.5 % tolerance for a derived value; a game-design rounding of an estimate says how far it rounds).
 */

const device = (id: string): DeviceDefinition => {
  const d = BUILTIN_CATALOG.device({ id, version: 1 });
  if (d === undefined) throw new Error(`missing ${id}`);
  return d;
};
const rel = (a: number, b: number) => Math.abs(a / b - 1);
const IN = 25.4;
const LBF_IN_NM = 0.112984829; // 1 lbf·in = 4.4482216152605 N × 0.0254 m

const SWITCHES = ['switch.castellby-1p-15a', 'switch.castellby-3way-15a', 'switch.castellby-4way-15a'];
const DIMMER = 'dimmer.castellby-600w';
const KEYLESS = 'lampholder.castellby-keyless';
const PULL_CHAIN = 'lampholder.castellby-pull-chain';
const A19_60 = 'lamp.lumivane-a19-60w';
const A19_100 = 'lamp.lumivane-a19-100w';
const LED_A19 = 'light.lumivane-led-a19-9w';
const LED_WALL = 'light.fennisby-led-wall-15w';

const methods = (d: DeviceDefinition) =>
  Object.fromEntries(d.terminals.map((t) => [t.id, t.methods.map((m) => m.method).join(',')]));
const method = (d: DeviceDefinition, terminal: string, id: string): TerminalMethodSpec => {
  const m = d.terminals.find((t) => t.id === terminal)?.methods.find((x) => x.method === id);
  if (m === undefined) throw new Error(`${d.id}:${terminal} has no ${id}`);
  return m;
};

describe('the F4.1 part 1 lighting entries (content/devices)', () => {
  it('ten entries, each of its lighting kind (or the P3 lamp kind on an E26 fit), version 1, fictional brands', () => {
    const lighting = BUILTIN_CATALOG.devices.filter(
      (d) => Object.hasOwn(LIGHTING_MODEL_KINDS, d.model.kind) || d.mounts.some((m) => m.type === 'e26'),
    );
    expect(lighting.map((d) => [`${d.id}@${d.version}`, d.model.kind, d.brand])).toStrictEqual([
      ['dimmer.castellby-600w@1', 'dimmer.wall', 'Castellby'],
      ['lamp.lumivane-a19-100w@1', 'lamp.incandescent', 'Lumivane'],
      ['lamp.lumivane-a19-60w@1', 'lamp.incandescent', 'Lumivane'],
      ['lampholder.castellby-keyless@1', 'lampholder.e26', 'Castellby'],
      ['lampholder.castellby-pull-chain@1', 'lampholder.e26PullChain', 'Castellby'],
      ['light.fennisby-led-wall-15w@1', 'light.ledFixture', 'Fennisby'],
      ['light.lumivane-led-a19-9w@1', 'light.led', 'Lumivane'],
      ['switch.castellby-1p-15a@1', 'switch.wall1p', 'Castellby'],
      ['switch.castellby-3way-15a@1', 'switch.wall3way', 'Castellby'],
      ['switch.castellby-4way-15a@1', 'switch.wall4way', 'Castellby'],
    ]);
    // Every lighting kind has a shipped entry.
    expect([...new Set(lighting.map((d) => d.model.kind))].sort()).toStrictEqual(
      [...Object.keys(LIGHTING_MODEL_KINDS), 'lamp.incandescent'].sort(),
    );
    for (const d of lighting) {
      expect([d.id, d.supersededBy, d.outlets, d.plug, d.enclosure, d.conductor]).toStrictEqual([
        d.id,
        null,
        [],
        null,
        null,
        null,
      ]);
      for (const t of d.terminals) expect([d.id, t.id, t.role, t.side]).toStrictEqual([d.id, t.id, null, null]);
    }
  });

  it('the switches: 15 A 120 V, brass screws with a 14 AWG solid push-in hole behind each, a green screw only', () => {
    expect(SWITCHES.map((id) => methods(device(id)))).toStrictEqual([
      { a: 'screw,backStab', b: 'screw,backStab', ground: 'screw' },
      { common: 'screw,backStab', ground: 'screw', t1: 'screw,backStab', t2: 'screw,backStab' },
      { a1: 'screw,backStab', a2: 'screw,backStab', b1: 'screw,backStab', b2: 'screw,backStab', ground: 'screw' },
    ]);
    expect(SWITCHES.map((id) => device(id).controls)).toStrictEqual([
      [{ id: 'closed', label: 'Switch', type: 'toggle' }],
      [{ id: 'position', label: 'Switch', type: 'selector', options: ['t1', 't2'] }],
      [{ id: 'position', label: 'Switch', type: 'selector', options: ['straight', 'crossed'] }],
    ]);
    for (const id of SWITCHES) {
      const d = device(id);
      expect(d.model.params).toStrictEqual({ ratedCurrentA: 15, ratedVoltageV: 120 });
      for (const t of d.terminals) {
        expect(t.access).toBe('land');
        // The screw first: `'auto'` lands on the screw.
        expect(t.methods[0].method).toBe('screw');
        const push = t.methods.find((m) => m.method === 'backStab');
        if (push === undefined) continue;
        expect(push).toMatchObject({
          ratedConductors: 1,
          maxConductors: 1,
          awgRange: { smallest: 14, largest: 14 },
          stranding: ['solid'],
          alRated: false,
          clampType: 'pushIn',
          torqueNm: null,
          drives: [],
          contactOhm: 0.001,
        });
        // Every in-tolerance strip seats fully: the grip is at most the shortest strip.
        expect(push.clampDepthMm).toBeLessThanOrEqual(push.stripLengthMm.nominal - push.stripLengthMm.tolerance);
      }
    }
  });

  it('push-in holes only on 15 A devices (the pre-audit, UL 20 and UL 498 by number): every built-in entry', () => {
    const pushIn = BUILTIN_CATALOG.devices.filter((d) =>
      d.terminals.some((t) => t.methods.some((m) => m.method === 'backStab')),
    );
    expect(pushIn.map((d) => d.id)).toStrictEqual(SWITCHES);
    for (const d of pushIn) expect(d.model.params['ratedCurrentA']).toBeLessThanOrEqual(15);
    // Hand: the strip gauge read is about 1/2 in = 12.7 mm, taken as 13 mm.
    expect(0.5 * IN).toBeCloseTo(12.7, 6);
    expect(method(device(SWITCHES[0]), 'a', 'backStab').stripLengthMm.nominal).toBe(Math.round(0.5 * IN));
  });

  it('the binding screws are marked 1.8 N·m, 16 lb·in to 0.5 %, inside the read 14–18 lb·in', () => {
    // Hand: 16 × 0.112985 = 1.80776 N·m (1.8 is 0.43 % under); 14 → 1.58179, 18 → 2.03373 N·m.
    expect(rel(1.8, 16 * LBF_IN_NM)).toBeLessThan(0.005);
    expect(14 * LBF_IN_NM).toBeCloseTo(1.58179, 4);
    expect(18 * LBF_IN_NM).toBeCloseTo(2.03373, 4);
    for (const id of [...SWITCHES, DIMMER, KEYLESS, PULL_CHAIN]) {
      for (const t of device(id).terminals.filter((x) => x.methods.length > 0)) {
        const screw = method(device(id), t.id, 'screw');
        expect([id, t.id, screw.torqueNm, screw.clampType, screw.contactOhm]).toStrictEqual([
          id,
          t.id,
          1.8,
          'bindingScrew',
          0.0003,
        ]);
        expect(screw.torqueNm ?? 0).toBeGreaterThanOrEqual(14 * LBF_IN_NM);
        expect(screw.torqueNm ?? 0).toBeLessThanOrEqual(18 * LBF_IN_NM);
      }
    }
  });

  it('every yoke device fits a gang by its strap and bonds its ground terminal to the chassis through 5 mΩ', () => {
    // A single-gang steel box is 47 × 72 × 60 mm inside; a 2-gang box's gang is 46 mm wide and 86 mm tall.
    const GANG_W = 46;
    const GANG_H = 72;
    for (const id of [...SWITCHES, DIMMER]) {
      const d = device(id);
      const size = d.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
      const [fit] = d.mounts;
      expect(d.mounts).toHaveLength(1);
      expect(fit.contacts).toStrictEqual([
        { id: 'strap', terminal: 'ground', host: 'chassis', positionOffset: 0, contactOhm: 0.005 },
      ]);
      expect(fit.widthMm).toBe(size.widthMm);
      // Inside the gang (body from the anchor), and its depth no more than a single-gang box's.
      expect(fit.alongMm).toBeGreaterThanOrEqual(0);
      expect(fit.alongMm + size.widthMm).toBeLessThanOrEqual(GANG_W);
      expect(fit.crossMm).toBeGreaterThanOrEqual(0);
      expect(fit.crossMm + size.heightMm).toBeLessThanOrEqual(GANG_H);
      expect(size.depthMm).toBeLessThanOrEqual(60);
    }
    // The wall light is centred on a 46 × 72 gang: (46 − 120) / 2 = −37, (72 − 120) / 2 = −24.
    const wall = device(LED_WALL);
    expect(wall.mounts.map((m) => [m.type, m.alongMm, m.crossMm, m.contacts.map((c) => c.contactOhm)])).toStrictEqual([
      ['deviceYoke', (GANG_W - 120) / 2, (GANG_H - 120) / 2, [0.005]],
    ]);
  });

  it('the dimmer: 600 W at 120 V, side-wired screws only, on and a level from 0 to 1', () => {
    const d = device(DIMMER);
    expect(d.model.params).toStrictEqual({ ratedVoltageV: 120, ratedPowerW: 600 });
    expect(methods(d)).toStrictEqual({ ground: 'screw', line: 'screw', load: 'screw' });
    expect(d.controls).toStrictEqual([
      { id: 'on', label: 'Switch', type: 'toggle' },
      { id: 'level', label: 'Level', type: 'setpoint', unit: 'level', min: 0, max: 1, step: 0.05 },
    ]);
    // Hand: 600 W / 120 V = 5 A, the class's marked current.
    expect(600 / 120).toBe(5);
  });

  it('the lampholders: 660 W 250 V; the socket’s shell on the silver screw, its centre on brass (keyless) or behind the chain', () => {
    const keyless = device(KEYLESS);
    const chain = device(PULL_CHAIN);
    for (const d of [keyless, chain]) {
      expect(d.model.params).toStrictEqual({ ratedPowerW: 660, ratedVoltageV: 250 });
      expect(d.mounts).toStrictEqual([]);
      expect(d.hostMounts.map((m) => [m.id, m.type, m.axis, m.facing, m.extentMm, m.bus])).toStrictEqual([
        ['socket', 'e26', '+x', '+z', 0, null],
      ]);
    }
    expect(keyless.hostMounts[0].contacts).toStrictEqual([
      { id: 'centre', terminal: 'hot' },
      { id: 'shell', terminal: 'neutral' },
    ]);
    expect(chain.hostMounts[0].contacts).toStrictEqual([
      { id: 'centre', terminal: 'centre' },
      { id: 'shell', terminal: 'neutral' },
    ]);
    expect(methods(keyless)).toStrictEqual({ ground: 'screw', hot: 'screw', neutral: 'screw' });
    expect(methods(chain)).toStrictEqual({ centre: '', ground: 'screw', hot: 'screw', neutral: 'screw' });
    expect(chain.terminals.find((t) => t.id === 'centre')?.access).toBe('none');
    expect(chain.controls).toStrictEqual([{ id: 'closed', label: 'Pull chain', type: 'toggle' }]);
    // A 4-1/4 in base covers a 4 in box: 4.25 × 25.4 = 107.95 mm, drawn 108.
    expect(Math.round(4.25 * IN)).toBe(keyless.sizeMm?.widthMm);
  });

  it('the A19 bulbs: 60 × 60 × 112 mm, centred on the socket axis, foot and shell contacts of 2 mΩ', () => {
    // Hand: A19 is 19/8 in across at most = 60.325 mm, drawn 60; the LED sheet read gives 2.36 in
    // (59.944 mm) and 4.41 in (112.014 mm) overall.
    expect((19 / 8) * IN).toBeCloseTo(60.325, 6);
    expect(2.36 * IN).toBeCloseTo(59.944, 6);
    expect(Math.round(4.41 * IN)).toBe(112);
    for (const id of [A19_60, A19_100, LED_A19]) {
      const d = device(id);
      const size = d.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
      expect([id, size]).toStrictEqual([id, { widthMm: 60, heightMm: 60, depthMm: 112 }]);
      expect(d.terminals.map((t) => [t.id, t.access, t.methods])).toStrictEqual([
        ['a', 'clip', []],
        ['b', 'clip', []],
      ]);
      expect(d.mounts).toStrictEqual([
        {
          type: 'e26',
          widthMm: 26,
          crossMm: -size.heightMm / 2,
          alongMm: -size.widthMm / 2,
          contacts: [
            { id: 'foot', terminal: 'a', host: 'centre', positionOffset: 0, contactOhm: 0.002 },
            { id: 'shell', terminal: 'b', host: 'shell', positionOffset: 0, contactOhm: 0.002 },
          ],
        },
      ]);
    }
    // The contact anchor (game-design, an order of magnitude): one spot of a = 15 µm in cartridge brass
    // (28 % IACS: ρ = 1.7241e-8 / 0.28 = 6.1575e-8 Ω·m), R = ρ / (2a) = 2.0525 mΩ; 2 mΩ is 2.6 % under.
    const rho = 1.7241e-8 / 0.28;
    expect(rho).toBeCloseTo(6.1575e-8, 11);
    const spot = rho / (2 * 15e-6);
    expect(spot).toBeCloseTo(2.0525e-3, 7);
    expect(rel(0.002, spot)).toBeLessThan(0.03);
  });

  it('the incandescent A19s: the P3 120 V filament data, 30 ms at 60 W and 40 ms at 100 W from the same estimate', () => {
    const p60 = device(A19_60).model.params;
    const p100 = device(A19_100).model.params;
    expect(p60).toStrictEqual({
      ratedVoltageV: 120,
      ratedPowerW: 60,
      filamentRatedTempK: 2700,
      thermalTimeConstantMs: 30,
      conductionFraction: 0.05,
    });
    expect(p100).toStrictEqual({ ...p60, ratedPowerW: 100, thermalTimeConstantMs: 40 });
    // The P3 D17 estimate, for a straight tungsten wire at T = 2700 K radiating 95 % of P with ε = 0.317,
    // R_hot = V² / P (240 Ω, 144 Ω) at ρ = 81.095 µΩ·cm:
    //   area π d L = 0.95 P / (ε σ T⁴); R = 4 ρ L / (π d²) ⇒ L / d² = R π / (4 ρ); d³ = (dL) / (L / d²);
    //   m = 19 300 kg/m³ × π d² L / 4; C = m × 36.19 / 183.84 J/(g·K);
    //   slope = 4 × 0.95 P / T + 0.05 P / (T − 293.15 K); τ = C / slope.
    // 60 W: d = 43.39 µm, L = 437.7 mm, m = 12.49 mg, C = 2.459 mJ/K, slope 0.08569 W/K, τ = 28.70 ms.
    // 100 W: d = 61.00 µm, L = 518.9 mm, m = 29.27 mg, C = 5.762 mJ/K, slope 0.14282 W/K, τ = 40.35 ms.
    const SIGMA = 5.670374419e-8;
    const estimate = (watts: number) => {
      const t = 2700;
      const r = (120 * 120) / watts;
      const rho = 81.095e-8;
      const dL = (0.95 * watts) / (0.317 * SIGMA * t ** 4) / Math.PI;
      const lOverD2 = (r * Math.PI) / (4 * rho);
      const d = Math.cbrt(dL / lOverD2);
      const length = lOverD2 * d * d;
      const massG = ((19300 * Math.PI * d * d) / 4) * length * 1000;
      const heatJPerK = massG * (36.19 / 183.84);
      const slope = (4 * 0.95 * watts) / t + (0.05 * watts) / (t - 293.15);
      return { d, length, massG, heatJPerK, slope, tauMs: (heatJPerK / slope) * 1000 };
    };
    const e60 = estimate(60);
    expect(e60.d).toBeCloseTo(43.39e-6, 8);
    expect(e60.length).toBeCloseTo(0.4377, 4);
    expect(e60.massG * 1000).toBeCloseTo(12.49, 2);
    expect(e60.heatJPerK * 1000).toBeCloseTo(2.459, 3);
    expect(e60.tauMs).toBeCloseTo(28.7, 1);
    const e100 = estimate(100);
    expect(e100.d).toBeCloseTo(61.0e-6, 8);
    expect(e100.length).toBeCloseTo(0.5189, 4);
    expect(e100.massG * 1000).toBeCloseTo(29.27, 2);
    expect(e100.heatJPerK * 1000).toBeCloseTo(5.762, 3);
    expect(e100.slope).toBeCloseTo(0.14282, 5);
    expect(e100.tauMs).toBeCloseTo(40.35, 1);
    // The entries round the straight-wire estimate (game-design): 30 ms is 4.5 % over 28.7 ms (the P3
    // value), 40 ms 0.9 % under 40.35 ms; τ scales with the diameter: 40.35 / 28.70 = 1.406 ≈ 61.00 / 43.39.
    expect(rel(p100['thermalTimeConstantMs'], e100.tauMs)).toBeLessThan(0.01);
    expect(rel(e100.tauMs / e60.tauMs, e100.d / e60.d)).toBeLessThan(0.01);
    // Hot and cold resistance: 14400 / 100 = 144 Ω; cold 144 × 5.4849 / 81.095 = 9.7395 Ω (1/14.785).
    expect((120 * 120) / 100).toBe(144);
    expect((144 * 5.4849) / 81.095).toBeCloseTo(9.7395, 4);
  });

  it('the LED drivers: constant power at PF 0.9 (inside 0.6–0.9), dropout 90 V < restart 95 V < 108 V < rated 120 V', () => {
    const bulb = LedDriverParams.parse(device(LED_A19).model.params);
    const wall = LedDriverParams.parse(device(LED_WALL).model.params);
    expect(bulb).toStrictEqual({
      ratedVoltageV: 120,
      ratedPowerW: 9,
      powerFactor: 0.9,
      dropoutVoltageV: 90,
      restartVoltageV: 95,
    });
    expect(wall).toStrictEqual({ ...bulb, ratedPowerW: 15 });
    for (const p of [bulb, wall]) {
      expect(p.powerFactor).toBeGreaterThanOrEqual(0.6);
      expect(p.powerFactor).toBeLessThanOrEqual(0.9);
      expect(p.dropoutVoltageV).toBeLessThan(p.restartVoltageV);
      // The pre-audit holds constant power from 108 V, so the driver must be running there.
      expect(p.restartVoltageV).toBeLessThan(108);
      expect(p.restartVoltageV).toBeLessThan(p.ratedVoltageV);
    }
    // Hand: 9 W at PF 0.9 is |S| = 10 VA, |Q| = 9 √(1 − 0.81) / 0.9 = 4.35890 var, |I| = 10 / 120 = 83.3 mA;
    // 15 W: 16.667 VA, 7.26483 var, 138.9 mA.
    const q = (w: number) => (w * Math.sqrt(1 - 0.81)) / 0.9;
    expect(q(9)).toBeCloseTo(4.3589, 4);
    expect(q(15)).toBeCloseTo(7.26483, 4);
    expect(9 / 0.9 / 120).toBeCloseTo(0.083333, 6);
    // The light's push-in block: 14–12 AWG solid copper, the 2.5 mm² spring-cage block's contact values.
    const sc25 = BUILTIN_CATALOG.device({ id: 'tb.quennick-sc25', version: 1 })?.terminals[0].methods[0];
    for (const t of device(LED_WALL).terminals) {
      const m = method(device(LED_WALL), t.id, 'springCage');
      expect([t.id, m.awgRange, m.stranding, m.contactOhm, m.heatPathWPerK, m.hotSpotHeatCapacityJPerK]).toStrictEqual([
        t.id,
        { smallest: 14, largest: 12 },
        ['solid'],
        sc25?.contactOhm,
        sc25?.heatPathWPerK,
        sc25?.hotSpotHeatCapacityJPerK,
      ]);
    }
  });
});
