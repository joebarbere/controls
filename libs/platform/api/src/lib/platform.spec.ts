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
      canQuit: false,
      quit: () => undefined,
    };
    await expect(fake.getAppInfo()).resolves.toMatchObject({ platform: 'web' });
  });
});
