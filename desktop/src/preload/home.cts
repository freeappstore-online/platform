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
  registry: () => ipcRenderer.invoke('home:registry'),
});
