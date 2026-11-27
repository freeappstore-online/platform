// Preload for the hidden Contribute window (#826, #837): it only relays the AAC encoder's messages
// and reports whether this computer can encode, and its battery level. It never sees the device credential; the main
// process makes every API call.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('fasContribute', {
  /** Encoder requests from the main process. */
  onMessage(listener: (message: unknown) => void) {
    ipcRenderer.on('contribute:to-encoder', (_event, message) => listener(message));
  },
  reply: (message: unknown) => ipcRenderer.send('contribute:from-encoder', message),
  engine: (engine: unknown) => ipcRenderer.send('contribute:engine', engine),
  /** This computer's battery level, 0-100, or null (#830): the main process can't read it. */
  battery: (level: number | null) => ipcRenderer.send('contribute:battery', level),
});
