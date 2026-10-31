import {
  LAMP_DARK_BELOW_REL,
  LAMP_DISPLAY_CURVE_SOURCE,
  LAMP_RATED_LEVEL,
  lampDisplayCurve,
  lampDisplayLevel,
} from './display-curve';
import { lampDrawLevel, lampDrawStatus, type LampOutput } from './lamp-display';

describe('lamp display curve (F2.5)', () => {
  it('is dark at 0 and below one display step of rated light', () => {
    expect(lampDisplayCurve(0)).toBe(0);
    expect(lampDisplayLevel(0)).toBe(0);
    expect(lampDisplayLevel(LAMP_DARK_BELOW_REL * 0.999)).toBe(0);
    expect(lampDisplayLevel(1e-9)).toBe(0);
    expect(lampDisplayLevel(LAMP_DARK_BELOW_REL)).toBeGreaterThan(0);
  });

  it('draws rated light at the documented level and saturates toward 255 without clipping', () => {
    expect(lampDisplayCurve(1)).toBeCloseTo(0.8, 12);
    expect(lampDisplayLevel(1)).toBe(LAMP_RATED_LEVEL);
    expect(LAMP_RATED_LEVEL).toBe(204);
    expect(lampDisplayLevel(1.5)).toBeGreaterThan(LAMP_RATED_LEVEL);
    expect(lampDisplayLevel(2)).toBeLessThan(255);
    expect(lampDisplayLevel(50)).toBe(255);
    expect(lampDisplayLevel(Infinity)).toBe(255);
  });

  it('is monotone non-decreasing, integer and in 0…255 across the range', () => {
    let previousCurve = 0;
    let previousLevel = 0;
    const bad: number[] = [];
    for (let i = 0; i <= 4000; i++) {
      const l = i / 1000; // 0 … 4 × rated
      const c = lampDisplayCurve(l);
      const level = lampDisplayLevel(l);
      const ok = c >= previousCurve && level >= previousLevel && Number.isInteger(level) && level >= 0 && level <= 255;
      if (!ok) bad.push(l);
      previousCurve = c;
      previousLevel = level;
    }
    expect(bad).toStrictEqual([]);
  });

  it('treats NaN and negative input as dark', () => {
    expect(lampDisplayLevel(Number.NaN)).toBe(0);
    expect(lampDisplayLevel(-1)).toBe(0);
    expect(lampDisplayLevel(-Infinity)).toBe(0);
  });

  it('is a game-design choice and says so', () => {
    expect(LAMP_DISPLAY_CURVE_SOURCE.kind).toBe('game-design');
    expect(LAMP_DISPLAY_CURVE_SOURCE.source.startsWith('game-design:')).toBe(true);
  });
});

describe('lamp validity rule (F2.5)', () => {
  const at = (status: LampOutput['status'], lightOutputRel = 1): LampOutput => ({ status, lightOutputRel });

  it('draws a solved lamp by its level, including a real "off" at 0', () => {
    expect([lampDrawStatus(at('solved')), lampDrawLevel(at('solved'))]).toStrictEqual(['solved', LAMP_RATED_LEVEL]);
    expect([lampDrawStatus(at('solved', 0)), lampDrawLevel(at('solved', 0))]).toStrictEqual(['solved', 0]);
  });

  it('never draws an unsolved, singular or missing lamp as off: it is unknown, with no glow', () => {
    for (const output of [at('unsolved'), at('singular'), at('unsolved', 0), undefined]) {
      expect(lampDrawStatus(output)).toBe('unknown');
      expect(lampDrawLevel(output)).toBe(0);
    }
  });

  it('draws an unsettled lamp by its level, marked unsettled', () => {
    expect([lampDrawStatus(at('unsettled', 1)), lampDrawLevel(at('unsettled', 1))]).toStrictEqual([
      'unsettled',
      LAMP_RATED_LEVEL,
    ]);
  });
});
