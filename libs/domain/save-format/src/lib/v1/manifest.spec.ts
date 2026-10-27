import { APP_VERSION } from '@controls/units';
import { createManifest, migrateManifest } from '../documents';
import { CTRL_FORMAT, ManifestV1 } from './manifest';

describe('ManifestV1', () => {
  it('createManifest records this build’s APP_VERSION and schemaVersion 1', () => {
    expect(createManifest()).toStrictEqual({
      format: CTRL_FORMAT,
      schemaVersion: 1,
      appVersion: APP_VERSION,
      catalogVersion: 0,
      extensions: {},
    });
    expect(createManifest({ catalogVersion: 3 }).catalogVersion).toBe(3);
  });

  it('rejects a foreign format marker, a bad app version or a negative catalogVersion', () => {
    const good = createManifest();
    expect(ManifestV1.safeParse({ ...good, format: 'zip' }).success).toBe(false);
    expect(ManifestV1.safeParse({ ...good, appVersion: 'latest' }).success).toBe(false);
    expect(ManifestV1.safeParse({ ...good, catalogVersion: -1 }).success).toBe(false);
    expect(ManifestV1.safeParse({ ...good, savedAt: '2026-10-27' }).success).toBe(false);
  });

  it('loads through the migrator and round-trips through JSON', () => {
    const manifest = createManifest();
    const loaded = migrateManifest(JSON.parse(JSON.stringify(manifest)));
    expect(loaded).toStrictEqual({ ok: true, value: manifest, fromVersion: 1 });
  });
});
