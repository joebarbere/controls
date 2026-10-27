import type { ControlsBridge } from '@controls/ipc-contract';
import { ElectronPlatform, findBridge } from './electron-platform';

const info = {
  appVersion: '0.1.0',
  platform: 'linux',
  arch: 'x64',
  isPackaged: true,
  versions: { electron: '45.0.0' },
} as const;

describe('ElectronPlatform', () => {
  it('returns validated app info from the bridge', async () => {
    const bridge: ControlsBridge = { getAppInfo: async () => ({ ...info }) };
    await expect(new ElectronPlatform(bridge).getAppInfo()).resolves.toEqual(info);
  });

  it('rejects a malformed bridge response', async () => {
    const bridge = { getAppInfo: async () => ({ nope: true }) } as unknown as ControlsBridge;
    await expect(new ElectronPlatform(bridge).getAppInfo()).rejects.toThrow();
  });

  it('finds the bridge only when the preload installed it', () => {
    expect(findBridge({})).toBeUndefined();
    const bridge: ControlsBridge = { getAppInfo: async () => ({ ...info }) };
    expect(findBridge({ controls: bridge })).toBe(bridge);
  });
});
