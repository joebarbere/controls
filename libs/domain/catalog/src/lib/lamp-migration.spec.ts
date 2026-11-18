import { CURRENT_SCHEMA_VERSION, LAMP_INCANDESCENT_REFS_V3, LAMP_SIM_KEYS_V4 } from '@controls/save-format';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialBags, MODEL_KINDS } from './model-kinds';

/*
 * The v3 → v4 migration's lamp data (ADR 0019 deviation 1): `save-format` holds the shipped
 * `lamp.incandescent` refs and the kind's two new sim keys as frozen literals, so the step never reads
 * the catalogue. These tests tie the literals to the catalogue they stand for.
 */

interface ShippedDevice {
  id: string;
  version: number;
  model: { kind: string };
}

const shippedDir = join(import.meta.dirname, '../../fixtures/shipped');
const shipped = readdirSync(shippedDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => {
    const doc = JSON.parse(readFileSync(join(shippedDir, name), 'utf8')) as {
      catalogVersion: number;
      devices: ShippedDevice[];
    };
    return { name, ...doc };
  });

const key = (ref: { id: string; version: number }) => `${ref.id}@${ref.version}`;

describe('the v3 → v4 migration’s lamp refs (LAMP_INCANDESCENT_REFS_V3)', () => {
  it('equal the lamp.incandescent entries of every frozen catalogue up to catalogue 2 (0.3.0 and 0.4.0)', () => {
    // A v3 save names entries of catalogue 2 or earlier (catalogue 1 saves migrate through v2 → v3).
    // Catalogue 2 is frozen with v0.4.0, so the literal is complete and never changes.
    const lamps = new Set(
      shipped
        .filter((release) => release.catalogVersion <= 2)
        .flatMap((release) => release.devices.filter((d) => d.model.kind === 'lamp.incandescent').map(key)),
    );
    expect(shipped.some((release) => release.catalogVersion === 2)).toBe(true);
    expect([...lamps].sort()).toStrictEqual(LAMP_INCANDESCENT_REFS_V3.map(key).sort());
    expect([...lamps].sort()).toStrictEqual(['lamp.lumivane-120v-60w@1', 'lamp.lumivane-12v-5w@1']);
  });
});

describe('the v3 → v4 migration’s lamp keys (LAMP_SIM_KEYS_V4)', () => {
  it('are exactly what the lamp.incandescent kind added to its initial sim bag, while schemaVersion 4 is current', () => {
    // Once a later version changes the lamp kind's keys, this test moves to that version's migration
    // (the v4 literal itself never changes).
    expect(CURRENT_SCHEMA_VERSION).toBe(4);
    const { state, sim } = initialBags(MODEL_KINDS['lamp.incandescent']);
    expect(state).toStrictEqual({});
    expect(sim).toStrictEqual({ filamentTempK: null, ...LAMP_SIM_KEYS_V4 });
  });
});
