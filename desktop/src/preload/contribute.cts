// Preload for the hidden Contribute window (#826): it only relays the model worker's messages and
// reports what this computer can do. It never sees the device credential; the main process makes
// every API call.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('fasContribute', {
  /** Messages from the main process for the worker, or `delete-model`. */
  onMessage(listener: (message: unknown) => void) {
    ipcRenderer.on('contribute:to-worker', (_event, message) => listener(message));
  },
  fromWorker: (message: unknown) => ipcRenderer.send('contribute:from-worker', message),
  engine: (engine: unknown) => ipcRenderer.send('contribute:engine', engine),
});
