import { APP_VERSION } from '@controls/units';
import { migrateManifest } from '../documents';
import { manifestV1ToV2 } from '../v2/from-v1';
import { CTRL_FORMAT, ManifestV1 } from './manifest';

/** A v1 manifest as P1 builds wrote it (no catalogue yet). */
const v1 = () => ({
  format: CTRL_FORMAT,
  schemaVersion: 1,
  appVersion: APP_VERSION,
  catalogVersion: 0,
  extensions: {},
});

describe('ManifestV1', () => {
  it('accepts what P1 builds wrote', () => {
    expect(ManifestV1.parse(v1())).toStrictEqual(v1());
    expect(ManifestV1.parse({ ...v1(), catalogVersion: 3 }).catalogVersion).toBe(3);
  });

  it('rejects a foreign format marker, a bad app version or a negative catalogVersion', () => {
    const good = v1();
    expect(ManifestV1.safeParse({ ...good, format: 'zip' }).success).toBe(false);
    expect(ManifestV1.safeParse({ ...good, appVersion: 'latest' }).success).toBe(false);
    expect(ManifestV1.safeParse({ ...good, catalogVersion: -1 }).success).toBe(false);
    expect(ManifestV1.safeParse({ ...good, savedAt: '2026-10-27' }).success).toBe(false);
  });

  it('loads through the migrator, round-trips through JSON and migrates to v2', () => {
    const manifest = ManifestV1.parse(v1());
    const loaded = migrateManifest(JSON.parse(JSON.stringify(manifest)));
    expect(loaded).toStrictEqual({ ok: true, value: manifestV1ToV2(manifest), fromVersion: 1 });
  });
});
