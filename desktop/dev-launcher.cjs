'use strict';

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const electronPath = require('electron');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const DEV_PROCESS_FILE = path.join(RUNTIME_DIR, 'dev-processes.json');
const BACKEND_PORT = Number(process.env.AGENTS_COORDINATOR_PORT || 5188);
const VITE_PORT = Number(process.env.AGENTS_COORDINATOR_VITE_PORT || 5190);
const VITE_URL = `http://127.0.0.1:${VITE_PORT}`;
const children = new Set();

function parseArgs(argv) {
  const options = {
    projectRoot: process.env.TAO_PROJECT_ROOT || null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project' && argv[i + 1]) {
      options.projectRoot = path.resolve(argv[++i]);
    }
  }
  return options;
}

function spawnChild(command, args, options = {}) {
  const label = options.label || path.basename(command);
  console.log(`[desktop-dev] Starting ${label}...`);
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    ...options,
  });
  children.add(child);
  writeDevProcessFile();
  child.on('error', (error) => {
    console.error(`[desktop-dev] ${label} failed to start:`, error.message);
  });
  child.on('exit', (code, signal) => {
    children.delete(child);
    writeDevProcessFile();
    if (code !== null && code !== 0) {
      console.error(`[desktop-dev] ${label} exited with code ${code}.`);
    } else if (signal) {
      console.error(`[desktop-dev] ${label} exited from signal ${signal}.`);
    }
  });
  return child;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return result.status === 0;
  }
  try {
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch (_) {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch (_) {
      return false;
    }
  }
}

function readDevProcessFile() {
  try {
    return JSON.parse(require('fs').readFileSync(DEV_PROCESS_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeDevProcessFile() {
  const fs = require('fs');
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const pids = Array.from(children)
    .map((child) => child.pid)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  fs.writeFileSync(DEV_PROCESS_FILE, `${JSON.stringify({
    launcherPid: process.pid,
    updatedAt: new Date().toISOString(),
    pids,
  }, null, 2)}\n`, 'utf8');
}

function clearDevProcessFile() {
  try {
    require('fs').rmSync(DEV_PROCESS_FILE, { force: true });
  } catch (_) {
    // Best effort cleanup only.
  }
}

function cleanupRecordedDevProcesses() {
  const record = readDevProcessFile();
  if (!record || !Array.isArray(record.pids)) return;
  for (const pid of record.pids) {
    if (!processIsAlive(pid)) continue;
    console.log(`[desktop-dev] Cleaning up stale dev process ${pid}...`);
    killProcessTree(pid);
  }
  clearDevProcessFile();
}

function owningPidForPort(port) {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
    ], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const pid = Number.parseInt(String(result.stdout || '').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  return null;
}

function processCommandLine(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid)) return '';
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -First 1 -ExpandProperty CommandLine)`,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return String(result.stdout || '').trim();
}

function looksLikeTinyAgentOfficeDevProcess(pid) {
  const commandLine = processCommandLine(pid).toLowerCase();
  const normalizedRoot = ROOT.toLowerCase();
  return commandLine.includes(normalizedRoot)
    || commandLine.includes('tiny-agent-office')
    || commandLine.includes('vite');
}

function assertPortAvailable(port, label) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      const ownerPid = owningPidForPort(port);
      if (ownerPid && looksLikeTinyAgentOfficeDevProcess(ownerPid)) {
        console.log(`[desktop-dev] ${label} port ${port} is held by stale dev process ${ownerPid}. Cleaning it up...`);
        killProcessTree(ownerPid);
        setTimeout(() => {
          assertPortAvailable(port, label).then(resolve, reject);
        }, 350);
        return;
      }
      reject(new Error(`${label} port ${port} is already in use${ownerPid ? ` by PID ${ownerPid}` : ''}. Close that process and try again. ${error.message}`));
    });
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen(port, '127.0.0.1');
  });
}

function waitForHttp(url, timeoutMs = 20_000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    function attempt() {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(attempt, 300);
      });
      request.setTimeout(1000, () => {
        request.destroy();
      });
    }

    attempt();
  });
}

function shutdown() {
  for (const child of children) {
    if (child.killed) continue;
    killProcessTree(child.pid);
  }
  clearDevProcessFile();
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(143);
});
process.on('exit', shutdown);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const nodePath = process.env.npm_node_execpath || process.env.NODE || process.execPath;
  const npmCliPath = process.env.npm_execpath;
  if (!npmCliPath) {
    throw new Error('Could not find npm CLI path. Start this launcher through npm run start:desktop:dev.');
  }

  cleanupRecordedDevProcesses();
  await assertPortAvailable(BACKEND_PORT, 'Backend');
  await assertPortAvailable(VITE_PORT, 'Vite');

  const backendArgs = [path.join(ROOT, 'system', 'dashboard-server.js'), '--port', String(BACKEND_PORT)];
  if (options.projectRoot) backendArgs.push('--project', options.projectRoot);
  spawnChild(nodePath, backendArgs, {
    label: 'backend server',
  });
  spawnChild(nodePath, [npmCliPath, 'run', 'dev:web', '--', '--port', String(VITE_PORT)], {
    label: 'Vite dev server',
  });

  await waitForHttp(VITE_URL);
  console.log(`[desktop-dev] Vite is ready at ${VITE_URL}. Launching Electron...`);

  const electron = spawnChild(electronPath, ['desktop/main.cjs'], {
    label: 'Electron desktop app',
    windowsHide: false,
    env: {
      ...process.env,
      ...(options.projectRoot ? { TAO_PROJECT_ROOT: options.projectRoot } : {}),
      AGENTS_COORDINATOR_PORT: String(BACKEND_PORT),
      AGENTS_COORDINATOR_DESKTOP_URL: VITE_URL,
    },
  });

  electron.on('exit', (code) => {
    shutdown();
    process.exit(code || 0);
  });
}

main().catch((error) => {
  console.error(error);
  shutdown();
  process.exit(1);
});
