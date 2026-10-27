import { AppInfoSchema } from './app-info';

describe('AppInfoSchema', () => {
  it('accepts a desktop payload', () => {
    const info = {
      appVersion: '0.1.0',
      platform: 'linux',
      arch: 'x64',
      isPackaged: false,
      versions: { electron: '45.0.0', chrome: '156.0.0.0', node: '24.22.0' },
    };
    expect(AppInfoSchema.parse(info)).toEqual(info);
  });

  it('rejects an unknown platform', () => {
    expect(() =>
      AppInfoSchema.parse({ appVersion: '0.1.0', platform: 'beos', arch: 'x64', isPackaged: false, versions: {} }),
    ).toThrow();
  });
});
