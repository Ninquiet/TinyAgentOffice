'use strict';

const path = require('path');
const { spawn, spawnSync } = require('child_process');
const coordinationCore = require('./coordination-core');
const terminalWindowHost = require('../platform/terminal-window-host');

function utcNow() {
  return new Date().toISOString();
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function extractArg(commandLine, argName) {
  const escaped = argName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\s|;)\\s*['"]?${escaped}['"]?\\s+(['"\u0027])(.*?)\\1`, 'i');
  const quoted = String(commandLine || '').match(pattern);
  if (quoted) return quoted[2];

  const unquotedPattern = new RegExp(`(?:^|\\s|;)\\s*${escaped}\\s+([^\\s;]+)`, 'i');
  const unquoted = String(commandLine || '').match(unquotedPattern);
  return unquoted ? unquoted[1] : null;
}

const PROCESS_SCAN_TIMEOUT_MS = 15000;

const PROCESS_SCAN_SCRIPT = [
  "$items = Get-CimInstance Win32_Process | Where-Object {",
  "  ($_.Name -in @('powershell.exe','pwsh.exe','cmd.exe')) -and",
  "  ($_.CommandLine -like '*agent-coordination.js*' -or $_.CommandLine -like '*agent-coordination.cjs*') -and",
  "  ($_.CommandLine -like '*anunciate*')",
  '} | Select-Object ProcessId,Name,CommandLine;',
  '$items | ConvertTo-Json -Compress',
].join(' ');

function listWindows() {
  try {
    return terminalWindowHost.listWindows();
  } catch (_) {
    return [];
  }
}

async function listWindowsAsync() {
  try {
    return await terminalWindowHost.listWindowsAsync();
  } catch (_) {
    return [];
  }
}

function parseProcessScanOutput(raw) {
  if (!String(raw || '').trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {
    return [];
  }
}

function listWindowsTerminalProcesses() {
  if (process.platform !== 'win32') return [];

  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PROCESS_SCAN_SCRIPT], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) return [];
  return parseProcessScanOutput(result.stdout);
}

// Async twin of listWindowsTerminalProcesses. `Get-CimInstance Win32_Process`
// takes well over a second on a loaded machine, and spawnSync holds the event
// loop for all of it.
function listWindowsTerminalProcessesAsync() {
  if (process.platform !== 'win32') return Promise.resolve([]);

  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PROCESS_SCAN_SCRIPT], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, PROCESS_SCAN_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.on('error', () => {
      clearTimeout(timer);
      finish([]);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? parseProcessScanOutput(stdout) : []);
    });
  });
}

function terminalWindowForProcess(processInfo, windows, agentName) {
  const pid = Number(processInfo.ProcessId);
  const byPid = windows.find((entry) => entry.pid === pid);
  if (byPid) return byPid;

  const needle = String(agentName || '').toLowerCase();
  return windows.find((entry) => String(entry.title || '').toLowerCase().includes(needle)) || null;
}

function recoverableAgentFromProcess(processInfo, projectRoot, windows) {
  const commandLine = String(processInfo.CommandLine || '');
  const workspacePath = extractArg(commandLine, '--workspace') || extractArg(commandLine, '--project');
  if (!samePath(workspacePath, projectRoot)) return null;

  const role = coordinationCore.requireRole(extractArg(commandLine, '--role'));
  const agentName = extractArg(commandLine, '--name');
  const sessionId = extractArg(commandLine, '--session-id');
  if (!agentName || !sessionId) return null;

  const windowInfo = terminalWindowForProcess(processInfo, windows, agentName);
  const serverPort = Number(extractArg(commandLine, '--server-port') || extractArg(commandLine, '--port'));
  const model = extractArg(commandLine, '--model');

  return {
    sessionId,
    agentName,
    role,
    roleAcronym: coordinationCore.ROLE_ACRONYMS[role],
    status: 'available',
    activeTaskId: null,
    note: 'Recovered live terminal session',
    announcedAt: utcNow(),
    lastSeenAt: utcNow(),
    executionMode: 'manual',
    adapterType: 'opencode',
    launchCommand: 'opencode',
    launchArgs: model ? ['--model', model] : [],
    workspacePath: path.resolve(workspacePath),
    disabled: false,
    terminalPid: Number(processInfo.ProcessId),
    terminalWindowHandle: windowInfo && Number.isInteger(windowInfo.handle) ? windowInfo.handle : null,
    terminalHostPid: windowInfo && Number.isInteger(windowInfo.pid) ? windowInfo.pid : Number(processInfo.ProcessId),
    terminalWindowTitle: windowInfo ? windowInfo.title || null : null,
    terminalHostProcessName: windowInfo ? windowInfo.processName || null : processInfo.Name || null,
    serverHost: extractArg(commandLine, '--server-host') || extractArg(commandLine, '--hostname') || '127.0.0.1',
    serverPort: Number.isInteger(serverPort) ? serverPort : null,
    recoveredAt: utcNow(),
  };
}

function findOwnedTask(agent, tasksStore) {
  const tasks = tasksStore.tasks || [];
  return tasks.find((task) => {
    if (!task || coordinationCore.FINISHED_STATUSES.has(task.status)) return false;
    const ownsWorkflow = task.workflow && task.workflow.currentActorSessionId === agent.sessionId;
    const ownsClaim = task.claim && task.claim.agentName === agent.agentName && task.claim.role === agent.role;
    const ownsReview = task.reviewClaim && task.reviewClaim.agentName === agent.agentName && task.reviewClaim.role === agent.role;
    return ownsWorkflow || ownsClaim || ownsReview;
  }) || null;
}

function wasBlockedByLostTerminal(task) {
  return Array.isArray(task && task.notes) && task.notes.some((note) => (
    note
    && note.kind === 'daemon-reconcile'
    && typeof note.text === 'string'
    && note.text.includes('lost its terminal')
  ));
}

function applyTaskOwnership(agent, tasksStore, existingAgent = null) {
  if (
    existingAgent
    && (existingAgent.attentionRequired || existingAgent.operationalStatus === 'error' || existingAgent.status === 'attention')
    && !existingAgent.activeTaskId
  ) {
    return {
      ...agent,
      status: 'attention',
      activeTaskId: null,
      attentionRequired: true,
      operationalStatus: existingAgent.operationalStatus || 'error',
      operationalError: existingAgent.operationalError || existingAgent.note || 'Agent requires user attention.',
      note: existingAgent.note || existingAgent.operationalError || 'Agent requires user attention.',
    };
  }

  const task = findOwnedTask(agent, tasksStore);
  if (!task) return agent;

  if (task.status === 'CLAIMED') {
    const claimedAtMs = task.claim && task.claim.claimedAt ? Date.parse(task.claim.claimedAt) : null;
    const isStaleReservation = Number.isFinite(claimedAtMs) && Date.now() - claimedAtMs >= 45 * 1000;
    const existingAttention = existingAgent && existingAgent.status === 'attention';

    if (!isStaleReservation && !existingAttention) {
      return {
        ...agent,
        status: 'assigned',
        activeTaskId: task.id,
        note: `Task ${task.id} is reserved while prompt delivery is verified.`,
      };
    }

    task.status = 'TODO';
    task.claim = null;
    task.attentionType = null;
    coordinationCore.setWorkflowState(
      task,
      coordinationCore.normalizedTaskRole(task) === 'Project Manager' ? 'pm_planning' : 'implementation_queue',
      coordinationCore.normalizedTaskRole(task),
      null
    );
    if (!Array.isArray(task.notes)) task.notes = [];
    task.notes.push({
      kind: 'live-session-recovery',
      text: `Released unconfirmed claim for ${agent.agentName}; no prompt delivery was recorded.`,
      createdAt: utcNow(),
      agentName: agent.agentName,
      role: agent.role,
      sessionId: agent.sessionId,
    });
    tasksStore.updatedAt = utcNow();
    return {
      ...agent,
      status: 'attention',
      activeTaskId: null,
      attentionRequired: true,
      operationalStatus: 'error',
      operationalError: `Prompt delivery for ${task.id} was not confirmed.`,
      note: `Prompt delivery for ${task.id} was not confirmed. Relaunch or change model before retrying.`,
    };
  }

  if (task.status === 'BLOCKED' && wasBlockedByLostTerminal(task)) {
    task.status = 'TODO';
    task.attentionType = null;
    task.claim = null;
    coordinationCore.setWorkflowState(
      task,
      coordinationCore.normalizedTaskRole(task) === 'Project Manager' ? 'pm_planning' : 'implementation_queue',
      coordinationCore.normalizedTaskRole(task),
      null
    );
    if (!Array.isArray(task.notes)) task.notes = [];
    task.notes.push({
      kind: 'live-session-recovery',
      text: `Released stale blocked claim because ${agent.agentName} has a live recovered session.`,
      createdAt: utcNow(),
      agentName: agent.agentName,
      role: agent.role,
      sessionId: agent.sessionId,
    });
    tasksStore.updatedAt = utcNow();
    return {
      ...agent,
      status: 'available',
      activeTaskId: null,
      note: `Recovered live session; ${task.id} returned to queue.`,
    };
  }

  return {
    ...agent,
    status: task.status === 'BLOCKED' ? 'blocked' : 'working',
    activeTaskId: task.id,
    note: task.status === 'BLOCKED' ? 'Recovered blocked task ownership' : 'Recovered active task ownership',
  };
}

function detectLiveManualSessions(projectRoot) {
  const windows = listWindows();
  return listWindowsTerminalProcesses()
    .map((entry) => recoverableAgentFromProcess(entry, projectRoot, windows))
    .filter(Boolean);
}

// Use this from anything that runs on a timer. Same result, without stalling the
// event loop for the duration of the two PowerShell scans.
async function detectLiveManualSessionsAsync(projectRoot) {
  const [windows, processes] = await Promise.all([
    listWindowsAsync(),
    listWindowsTerminalProcessesAsync(),
  ]);
  return processes
    .map((entry) => recoverableAgentFromProcess(entry, projectRoot, windows))
    .filter(Boolean);
}

function recoverLiveManualSessionCandidates(state, candidates) {
  if (candidates.length === 0) return false;

  if (!Array.isArray(state.registry.agents)) state.registry.agents = [];
  let changed = false;

  for (const rawCandidate of candidates) {
    const existing = state.registry.agents.find((agent) => (
      agent.sessionId === rawCandidate.sessionId
      || (agent.agentName === rawCandidate.agentName && agent.role === rawCandidate.role)
    ));
    const candidate = applyTaskOwnership(rawCandidate, state.tasksStore, existing || null);

    if (!existing) {
      state.registry.agents.push(candidate);
      changed = true;
      continue;
    }

    for (const [key, value] of Object.entries(candidate)) {
      if (existing[key] === value) continue;
      existing[key] = value;
      changed = true;
    }
  }

  if (changed) {
    state.registry.updatedAt = utcNow();
  }

  return changed;
}

function recoverLiveManualSessions(state) {
  const projectRoot = state && state.paths && state.paths.projectRoot;
  if (!projectRoot) return false;
  return recoverLiveManualSessionCandidates(state, detectLiveManualSessions(projectRoot));
}

module.exports = {
  detectLiveManualSessions,
  detectLiveManualSessionsAsync,
  recoverLiveManualSessionCandidates,
  recoverLiveManualSessions,
};
