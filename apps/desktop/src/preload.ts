// Sandboxed preload: may only use `electron`'s renderer APIs. Exposes the narrow typed bridge.
import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_KEY, IpcChannel, type ControlsBridge } from '@controls/ipc-contract/preload';

const bridge: ControlsBridge = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.AppInfo),
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
