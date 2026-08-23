import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agent', {
  giveConsent: (sessionId: string) => ipcRenderer.invoke('give-consent', sessionId),
  declineConsent: () => ipcRenderer.invoke('decline-consent'),
});
