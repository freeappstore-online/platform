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
  setFavorite: (appId: string, on: boolean) => ipcRenderer.invoke('home:set-favorite', appId, on),
  update: (action: 'check' | 'apply') => ipcRenderer.invoke('home:update', action),
  setAutoUpdate: (on: boolean) => ipcRenderer.invoke('home:set-auto-update', on),
  releaseNotes: (version: string) => ipcRenderer.invoke('home:release-notes', version),
  pairCode: () => ipcRenderer.invoke('home:pair-code'),
  publish: {
    refresh: () => ipcRenderer.invoke('home:publish-refresh'),
    signIn: () => ipcRenderer.invoke('home:publish-sign-in'),
    signOut: () => ipcRenderer.invoke('home:publish-sign-out'),
    cancel: () => ipcRenderer.invoke('home:publish-cancel'),
    create: (appId: string) => ipcRenderer.invoke('home:publish-new', appId),
    add: () => ipcRenderer.invoke('home:publish-add'),
    remove: (path: string) => ipcRenderer.invoke('home:publish-remove', path),
    show: (path: string) => ipcRenderer.invoke('home:publish-show', path),
    check: (path: string) => ipcRenderer.invoke('home:publish-check', path),
    publish: (path: string, input: { category: string; oneliner: string }) =>
      ipcRenderer.invoke('home:publish-publish', path, input),
    push: (path: string, message: string) => ipcRenderer.invoke('home:publish-push', path, message),
  },
  contribute: {
    connect: () => ipcRenderer.invoke('home:contribute-connect'),
    cancel: () => ipcRenderer.invoke('home:contribute-cancel'),
    disconnect: () => ipcRenderer.invoke('home:contribute-disconnect'),
    setOptIn: (appId: string, on: boolean) =>
      ipcRenderer.invoke('home:contribute-opt-in', appId, on),
    setMode: (mode: 'auto' | 'run-now' | 'off') => ipcRenderer.invoke('home:contribute-mode', mode),
    setWhen: (changes: object) => ipcRenderer.invoke('home:contribute-when', changes),
    downloadModel: () => ipcRenderer.invoke('home:contribute-download'),
    deleteModel: () => ipcRenderer.invoke('home:contribute-delete-model'),
    refresh: () => ipcRenderer.invoke('home:contribute-refresh'),
    history: () => ipcRenderer.invoke('home:contribute-history'),
    audio: (appId: string, jobId: string) =>
      ipcRenderer.invoke('home:contribute-audio', appId, jobId),
    saveRecord: (appId: string, jobId: string, at: number) =>
      ipcRenderer.invoke('home:contribute-save-record', appId, jobId, at),
    report: (appId: string, jobId: string, good: boolean, note: string) =>
      ipcRenderer.invoke('home:contribute-report', appId, jobId, good, note),
    copyDiagnostics: () => ipcRenderer.invoke('home:contribute-diagnostics'),
  },
});
