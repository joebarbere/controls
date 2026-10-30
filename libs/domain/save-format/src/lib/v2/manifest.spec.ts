import { APP_VERSION } from '@controls/units';
import fc from 'fast-check';
import { rawManifestV2Arb } from '../../testing/arbitraries';
import { createManifest, migrateManifest } from '../documents';
import { CTRL_FORMAT } from '../v1/manifest';
import { ManifestV2 } from './manifest';

describe('ManifestV2', () => {
  it('createManifest records this build’s APP_VERSION, schemaVersion 2 and the given catalogue and engine', () => {
    expect(createManifest({ catalogVersion: 1, simEngineVersion: 3 })).toStrictEqual({
      format: CTRL_FORMAT,
      schemaVersion: 2,
      appVersion: APP_VERSION,
      catalogVersion: 1,
      simEngineVersion: 3,
      extensions: {},
    });
    expect(() => createManifest({ catalogVersion: 1, simEngineVersion: -1 })).toThrow();
  });

  it('requires simEngineVersion: a non-negative integer', () => {
    const good = createManifest({ catalogVersion: 1, simEngineVersion: 1 });
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
          value: manifest,
          fromVersion: 2,
        });
      }),
    );
  });
});
