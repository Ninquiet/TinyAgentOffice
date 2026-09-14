'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const DASHBOARD_PORT = Number(process.env.AGENTS_COORDINATOR_PORT || 5188);
const DEV_SERVER_URL = process.env.AGENTS_COORDINATOR_DESKTOP_URL || '';
const PROJECT_ROOT = process.env.TAO_PROJECT_ROOT || process.cwd();
let serverProcess = null;

function startServer() {
  const script = path.join(ROOT, 'system', 'dashboard-server.js');
  const nodePath = process.env.npm_node_execpath || process.env.NODE || 'node';
  serverProcess = spawn(nodePath, [script, '--port', String(DASHBOARD_PORT), '--project', PROJECT_ROOT], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 950,
    minWidth: 1250,
    minHeight: 950,
    title: 'Agent Coordination',
    frame: false,
    backgroundColor: '#f3f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadURL(DEV_SERVER_URL || `http://127.0.0.1:${DASHBOARD_PORT}/`);
}

ipcMain.handle('desktop:close-app', () => {
  app.quit();
});

ipcMain.handle('desktop:choose-project-folder', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose project folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

app.whenReady().then(() => {
  if (DEV_SERVER_URL) {
    createWindow();
    return;
  }
  startServer();
  setTimeout(createWindow, 700);
});

app.on('window-all-closed', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
  if (process.platform !== 'darwin') app.quit();
});
