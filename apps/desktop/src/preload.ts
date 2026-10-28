// Sandboxed preload: may only use `electron`'s renderer APIs. Exposes the narrow typed bridge.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { BRIDGE_KEY, IpcChannel, type ControlsBridge } from '@controls/ipc-contract/preload';

const bridge: ControlsBridge = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.AppInfo),
  getSettings: () => ipcRenderer.invoke(IpcChannel.SettingsGet),
  setSettings: (settings) => ipcRenderer.invoke(IpcChannel.SettingsSet, settings),
  quit: () => ipcRenderer.invoke(IpcChannel.AppQuit),
  onFlushRequest: (listener) => {
    // Pass the payload only: the IPC event (and its `sender`) must not reach the page.
    const forward = (_event: IpcRendererEvent, request: unknown) => listener(request);
    ipcRenderer.on(IpcChannel.FlushRequest, forward);
    return () => void ipcRenderer.removeListener(IpcChannel.FlushRequest, forward);
  },
  ackFlush: (ack) => ipcRenderer.invoke(IpcChannel.FlushAck, ack),
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
