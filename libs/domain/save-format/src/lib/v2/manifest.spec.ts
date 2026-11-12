import fc from 'fast-check';
import { rawManifestV2Arb } from '../../testing/arbitraries';
import { migrateManifest } from '../documents';
import { CTRL_FORMAT } from '../v1/manifest';
import { manifestV2ToV3 } from '../v3/from-v2';
import { ManifestV2 } from './manifest';

describe('ManifestV2', () => {
  it('requires simEngineVersion: a non-negative integer', () => {
    const good = {
      format: CTRL_FORMAT,
      schemaVersion: 2,
      appVersion: '0.3.0',
      catalogVersion: 1,
      simEngineVersion: 1,
      extensions: {},
    };
    expect(ManifestV2.safeParse(good).success).toBe(true);
    expect(ManifestV2.safeParse({ ...good, simEngineVersion: 1.5 }).success).toBe(false);
    const missing: Record<string, unknown> = { ...good };
    delete missing['simEngineVersion'];
    expect(ManifestV2.safeParse(missing).success).toBe(false);
    expect(ManifestV2.safeParse({ ...good, savedAt: 'now' }).success).toBe(false);
  });

  it('round-trips any valid manifest through JSON and the loader (property)', () => {
    fc.assert(
      fc.property(rawManifestV2Arb, (raw) => {
        const manifest = ManifestV2.parse(raw);
        expect(migrateManifest(JSON.parse(JSON.stringify(manifest)))).toStrictEqual({
          ok: true,
          value: manifestV2ToV3(manifest),
          fromVersion: 2,
        });
      }),
    );
  });
});
