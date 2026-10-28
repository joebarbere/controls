import { defaultSettings } from '@controls/save-format';
import { NOOP_LIFECYCLE } from './lifecycle';
import type { Platform } from './platform';

describe('Platform', () => {
  it('can be implemented by a plain object', async () => {
    const fake: Platform = {
      kind: 'web',
      getAppInfo: async () => ({
        appVersion: '0.0.0',
        platform: 'web',
        arch: 'unknown',
        isPackaged: false,
        versions: {},
      }),
      settings: {
        load: async () => ({ settings: defaultSettings(), fallbackReason: 'missing' }),
        save: async () => undefined,
      },
      canQuit: false,
      quit: () => undefined,
      lifecycle: NOOP_LIFECYCLE,
    };
    await expect(fake.getAppInfo()).resolves.toMatchObject({ platform: 'web' });
    await expect(fake.settings.load()).resolves.toMatchObject({ fallbackReason: 'missing' });
  });
});
