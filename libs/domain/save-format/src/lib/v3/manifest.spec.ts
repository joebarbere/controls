import { APP_VERSION } from '@controls/units';
import fc from 'fast-check';
import { rawManifestV3Arb } from '../../testing/arbitraries';
import { migrateManifest } from '../documents';
import { manifestV3ToV4 } from '../v4/from-v3';
import { CTRL_FORMAT } from '../v1/manifest';
import { ManifestV3 } from './manifest';

describe('ManifestV3', () => {
  it('requires simEngineVersion: a non-negative integer', () => {
    const good = {
      format: CTRL_FORMAT,
      schemaVersion: 3,
      appVersion: APP_VERSION,
      catalogVersion: 1,
      simEngineVersion: 1,
      extensions: {},
    };
    expect(ManifestV3.safeParse(good).success).toBe(true);
    expect(ManifestV3.safeParse({ ...good, simEngineVersion: 1.5 }).success).toBe(false);
    const missing: Record<string, unknown> = { ...good };
    delete missing['simEngineVersion'];
    expect(ManifestV3.safeParse(missing).success).toBe(false);
    expect(ManifestV3.safeParse({ ...good, savedAt: 'now' }).success).toBe(false);
  });

  it('round-trips any valid manifest through JSON and the loader (property)', () => {
    fc.assert(
      fc.property(rawManifestV3Arb, (raw) => {
        const manifest = ManifestV3.parse(raw);
        expect(migrateManifest(JSON.parse(JSON.stringify(manifest)))).toStrictEqual({
          ok: true,
          value: manifestV3ToV4(manifest),
          fromVersion: 3,
        });
      }),
    );
  });
});
