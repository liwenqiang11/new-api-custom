import { ipcRenderer, contextBridge } from 'electron';
import * as Sentry from '@sentry/electron/renderer';
import { IPC_CHANNELS } from './shared/constants';

import path from 'path';
import fs from 'fs';
import os from 'os';

// Config check logic - reads from Manager's own data directory
let sentryEnabled = false;
try {
  const home = os.homedir();
  const managerDataDir = path.join(home, '.antigravity-agent');
  const configPath = path.join(managerDataDir, 'gui_config.json');
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    sentryEnabled = config.error_reporting_enabled === true;
  }
} catch {
  // console.error('Preload: Failed to read config', e);
}

if (sentryEnabled && process.env.NODE_ENV === 'production') {
  // Defer Sentry init to avoid blocking main thread during startup (white screen fix)
  setTimeout(() => {
    // console.log('[Preload] Initializing Sentry (Deferred)');
    Sentry.init({});
  }, 2000);
}
window.addEventListener('message', (event) => {
  if (event.data === IPC_CHANNELS.START_ORPC_SERVER) {
    const [serverPort] = event.ports;

    ipcRenderer.postMessage(IPC_CHANNELS.START_ORPC_SERVER, null, [serverPort]);
  }
});

contextBridge.exposeInMainWorld('electron', {
  SENTRY_ENABLED: sentryEnabled,
  onGoogleAuthCode: (callback: (code: string) => void) => {
    const handler = (_event: any, code: string) => callback(code);
    ipcRenderer.on('GOOGLE_AUTH_CODE', handler);
    return () => ipcRenderer.off('GOOGLE_AUTH_CODE', handler);
  },
  changeLanguage: (lang: string) => {
    ipcRenderer.send(IPC_CHANNELS.CHANGE_LANGUAGE, lang);
  },
  onManualUpdateAvailable: (callback: (update: ManualUpdateInfo) => void) => {
    const handler = (_event: any, update: ManualUpdateInfo) => callback(update);
    ipcRenderer.on(IPC_CHANNELS.MANUAL_UPDATE_AVAILABLE, handler);
    ipcRenderer.send(IPC_CHANNELS.MANUAL_UPDATE_RENDERER_READY);
    return () => ipcRenderer.off(IPC_CHANNELS.MANUAL_UPDATE_AVAILABLE, handler);
  },
  checkForUpdates: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.CHECK_FOR_UPDATES);
  },
  dismissManualUpdate: (version: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.DISMISS_MANUAL_UPDATE, version);
  },
  openExternalUrl: (url: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, url);
  },
});
