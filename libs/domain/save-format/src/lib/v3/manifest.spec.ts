import { APP_VERSION } from '@controls/units';
import fc from 'fast-check';
import { rawManifestV3Arb } from '../../testing/arbitraries';
import { createManifest, migrateManifest } from '../documents';
import { CTRL_FORMAT } from '../v1/manifest';
import { ManifestV3 } from './manifest';

describe('ManifestV3', () => {
  it('createManifest records this build’s APP_VERSION, schemaVersion 3 and the given catalogue and engine', () => {
    expect(createManifest({ catalogVersion: 1, simEngineVersion: 3 })).toStrictEqual({
      format: CTRL_FORMAT,
      schemaVersion: 3,
      appVersion: APP_VERSION,
      catalogVersion: 1,
      simEngineVersion: 3,
      extensions: {},
    });
    expect(() => createManifest({ catalogVersion: 1, simEngineVersion: -1 })).toThrow();
  });

  it('requires simEngineVersion: a non-negative integer', () => {
    const good = createManifest({ catalogVersion: 1, simEngineVersion: 1 });
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
          value: manifest,
          fromVersion: 3,
        });
      }),
    );
  });
});
