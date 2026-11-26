// Preload for the home window: the calls its UI needs, nothing more.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('fasDesktop', {
  state: () => ipcRenderer.invoke('home:state'),
  onState(listener: (state: unknown) => void) {
    ipcRenderer.on('home:state', (_event, state) => listener(state));
  },
  openApp: (appId: string) => ipcRenderer.invoke('home:open-app', appId),
  copySetupCommand: () => ipcRenderer.invoke('home:copy-setup'),
  regenerateToken: () => ipcRenderer.invoke('home:regenerate-token'),
  setPaused: (paused: boolean) => ipcRenderer.invoke('home:set-paused', paused),
  setOpenAtLogin: (open: boolean) => ipcRenderer.invoke('home:set-open-at-login', open),
  clients: () => ipcRenderer.invoke('home:clients'),
  setConnected: (id: string, connect: boolean) => ipcRenderer.invoke('home:connect', id, connect),
  registry: () => ipcRenderer.invoke('home:registry'),
});
