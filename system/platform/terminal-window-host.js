'use strict';

const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, 'terminal-window-host.ps1');
const ASYNC_SCRIPT_TIMEOUT_MS = 15000;

function runScript(args) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT_PATH,
    ...args,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Terminal host script failed: ${args.join(' ')}`);
  }

  return String(result.stdout || '').trim();
}

// Async twin of runScript. Callers on a timer must use this one: spawnSync here
// blocks the whole event loop for the lifetime of the PowerShell child, which is
// long enough to stall every HTTP and WebSocket response.
function runScriptAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
      ...args,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error(`Terminal host script timed out: ${args.join(' ')}`));
    }, ASYNC_SCRIPT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Terminal host script failed: ${args.join(' ')}`));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function parseWindowList(raw) {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function listWindows() {
  return parseWindowList(runScript(['-Command', 'list']));
}

async function listWindowsAsync() {
  return parseWindowList(await runScriptAsync(['-Command', 'list']));
}

function titleMatches(windowInfo, titleHints) {
  const title = String(windowInfo && windowInfo.title ? windowInfo.title : '').toLowerCase();
  return (titleHints || []).some((hint) => title.includes(String(hint || '').toLowerCase()));
}

function processPriority(name) {
  const normalized = String(name || '').toLowerCase();
  if (normalized === 'windowsterminal') return 0;
  if (normalized === 'openconsole') return 1;
  if (normalized === 'conhost') return 2;
  if (normalized === 'powershell') return 3;
  if (normalized === 'cmd') return 4;
  return 5;
}

function chooseWindowCandidate(candidates, titleHints) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const titleScoreA = titleMatches(a, titleHints) ? 0 : 1;
    const titleScoreB = titleMatches(b, titleHints) ? 0 : 1;
    if (titleScoreA !== titleScoreB) return titleScoreA - titleScoreB;

    const processScoreA = processPriority(a.processName);
    const processScoreB = processPriority(b.processName);
    if (processScoreA !== processScoreB) return processScoreA - processScoreB;

    return Number(b.pid || 0) - Number(a.pid || 0);
  });
  return sorted[0] || null;
}

function waitForWindowRegistration(beforeWindows, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 4000;
  const titleHints = Array.isArray(options.titleHints) ? options.titleHints.filter(Boolean) : [];
  const beforeHandles = new Set((beforeWindows || []).map((entry) => String(entry.handle)));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const current = listWindows();
    const newWindows = current.filter((entry) => !beforeHandles.has(String(entry.handle)));
    const candidate = chooseWindowCandidate(newWindows, titleHints);
    if (candidate) return candidate;

    if (titleHints.length > 0) {
      const hintedCandidate = chooseWindowCandidate(current.filter((entry) => titleMatches(entry, titleHints)), titleHints);
      if (hintedCandidate) return hintedCandidate;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }

  return null;
}

function focusWindow(windowHandle, pid = null) {
  if (!Number.isInteger(windowHandle) || windowHandle <= 0) {
    throw new Error('focusWindow requires a valid window handle.');
  }

  const args = ['-Command', 'focus', '-Handle', String(windowHandle)];
  if (Number.isInteger(pid) && pid > 0) {
    args.push('-TargetPid', String(pid));
  }
  runScript(args);
}

module.exports = {
  listWindows,
  listWindowsAsync,
  waitForWindowRegistration,
  focusWindow,
};
