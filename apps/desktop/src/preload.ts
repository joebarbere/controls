// Sandboxed preload: may only use `electron`'s renderer APIs. Exposes the narrow typed bridge.
import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_KEY, IpcChannel, type ControlsBridge } from '@controls/ipc-contract/preload';

const bridge: ControlsBridge = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.AppInfo),
  getSettings: () => ipcRenderer.invoke(IpcChannel.SettingsGet),
  setSettings: (settings) => ipcRenderer.invoke(IpcChannel.SettingsSet, settings),
  quit: () => ipcRenderer.invoke(IpcChannel.AppQuit),
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
