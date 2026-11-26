// Preload for app windows. It exposes only the AI bridge channel that
// `@freeappstore/sdk/bridge` looks for; the page gets no other access.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('fasDesktopBridge', {
  send(message: string) {
    if (typeof message === 'string') ipcRenderer.send('bridge:send', message);
  },
  onMessage(listener: (message: string) => void) {
    ipcRenderer.on('bridge:message', (_event, message: string) => listener(message));
  },
});
