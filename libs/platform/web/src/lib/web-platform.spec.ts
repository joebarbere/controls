import { AppInfoSchema } from '@controls/ipc-contract';
import { APP_VERSION } from '@controls/units';
import { WebPlatform } from './web-platform';

describe('WebPlatform', () => {
  it('reports a schema-valid web app info with the build version', async () => {
    const info = await new WebPlatform().getAppInfo();
    expect(AppInfoSchema.parse(info)).toEqual(info);
    expect(info.appVersion).toBe(APP_VERSION);
  });

  it('cannot quit (a tab cannot close itself), and quit is a harmless no-op', () => {
    const platform = new WebPlatform();
    expect(platform.canQuit).toBe(false);
    expect(() => platform.quit()).not.toThrow();
  });
});
