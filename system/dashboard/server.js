'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { deriveDashboardState } = require('../runtime/coordination-core');
const coordinationCore = require('../runtime/coordination-core');
const runtimeStore = require('../runtime/runtime-store');
const runtimeReconcile = require('../runtime/runtime-reconcile');
const liveSessionRecovery = require('../runtime/live-session-recovery');
const taskGraphIntegrity = require('../runtime/task-graph-integrity');
const coordinationTelemetry = require('../runtime/coordination-telemetry');
const daemonFleet = require('../daemon/daemon-fleet');
const sessionDispatch = require('../dispatch/session-dispatch');
const { createWorldTick } = require('../runtime/world-tick');
const { DashboardWebSocketHub } = require('./websocket-hub');
const { json, text } = require('./http-utils');
const { serveReactApp } = require('./static-app');
const contextManager = require('../context/context-manager');
const themeService = require('./theme-service');
const {
  APP_ROOT,
  configureProjectWorkspace,
  getActiveProjectWorkspace,
} = require('../core/project-workspace');
const recentProjects = require('../core/recent-projects');
const { generalContextTemplate } = require('../core/office-templates');
const { createTransitionBuffer } = require('../runtime/transition-buffer');
const { resolveLimits } = require('../runtime/runtime-policy');
// The single OpenCode entry point. Everything this file needs from the runtime
// comes through it, and it hands back plain facts rather than touching the view.
const { createOpencodeRuntime, commandExists } = require('../opencode');
const { buildCartridgeView } = require('./cartridge-view');
const blueprintStore = require('../core/blueprint-store');
const blueprintInstances = require('../core/blueprint-instances');
const agentMemory = require('../core/agent-memory');
const secretaryInbox = require('../core/secretary-inbox');

const APP_DIST_DIR = path.resolve(__dirname, '..', '..', 'app', 'dist');
const DEFAULT_PORT = 5188;
const CONTEXT_BOOTSTRAP_TASK_TITLE = 'Create the initial reviewed general context';

// Attribution is resolved when the batch is written, from the registry as it is
// at that moment. The reducer only knows a session id, and which task that
// session was working on stops being recoverable once the agent moves on.
const transitionBuffer = createTransitionBuffer({
  resolveContext: (opencodeSessionId) => {
    const agents = runtimeStore.readCoordinationState(activeRuntimeOptions({ runLimit: 1 })).registry.agents || [];
    const agent = agents.find((entry) => entry.opencodeSessionId === opencodeSessionId);
    if (!agent) return null;
    return {
      agentSessionId: agent.sessionId,
      agentName: agent.agentName,
      role: agent.role,
      taskId: agent.activeTaskId || null,
    };
  },
  write: (rows) => runtimeStore.appendWorkflowTransitions(activeRuntimeOptions(), rows),
});

const opencode = createOpencodeRuntime({
  cwd: APP_ROOT,
  onTransition: (transition) => transitionBuffer.record(transition),
});

// Gap between world-tick passes, measured from the end of the previous pass.
// PM_USER_REQUEST_SETTLE_MS and the watchdog's STALLED_ACTIVITY_WINDOW_MS were
// both tuned against a pass roughly every second; change this and re-check them
// together.
const WORLD_TICK_INTERVAL_MS = 1000;
let worldTick = null;

const PM_USER_REQUEST_SETTLE_MS = 1800;
const USER_TASK_QUEUE_HISTORY_LIMIT = 25;

function utcNow() {
  return new Date().toISOString();
}

function safeAttachmentSegment(value) {
  return String(value || 'unknown').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'unknown';
}

function extensionForImageMime(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  return null;
}

function saveAgentAttachment(payload = {}) {
  const sessionId = safeAttachmentSegment(payload.sessionId);
  const mimeType = String(payload.mimeType || '');
  const extension = extensionForImageMime(mimeType);
  if (!extension) throw new Error('Only PNG, JPEG, WebP, and GIF images are supported.');

  const rawBase64 = String(payload.data || '').replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(rawBase64, 'base64');
  if (buffer.length === 0) throw new Error('Attachment image is empty.');
  if (buffer.length > 20 * 1024 * 1024) throw new Error('Attachment image is larger than 20 MiB.');

  const dir = path.join(getActiveProjectWorkspace().paths.attachmentsDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${Date.now()}-${safeAttachmentSegment(payload.name || 'image')}.${extension}`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buffer);

  return {
    message: 'Image attached.',
    attachment: {
      path: filePath,
      name: fileName,
      mimeType,
      size: buffer.length,
    },
  };
}

function psQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function shQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "'\"'\"'")}'`;
}

function appleScriptQuote(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function openTerminalHelper({ title, command, warning, mode }) {
  if (process.platform === 'win32') {
    const psScript = [
      `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}`,
      `Set-Location ${psQuote(APP_ROOT)}`,
      `Write-Host ${psQuote(mode === 'install' ? 'OpenCode install helper' : 'OpenCode update helper')} -ForegroundColor Cyan`,
      'Write-Host "This terminal is intentionally launched outside agent mode."',
      warning ? `Write-Host ${psQuote(warning)} -ForegroundColor Yellow` : null,
      'Write-Host ""',
      `Read-Host ${psQuote(`Press Enter to run: ${command}`)}`,
      command,
      'Write-Host ""',
      `Read-Host ${psQuote(`${mode === 'install' ? 'Install' : 'Update'} command finished. Press Enter to close this helper`)}`,
      'exit',
    ].filter(Boolean).join('; ');

    const encodedScript = Buffer.from(psScript, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      [
        `$argumentList = @('-EncodedCommand', ${psQuote(encodedScript)})`,
        `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentList -WorkingDirectory ${psQuote(APP_ROOT)} -WindowStyle Normal -PassThru`,
        'Write-Output $p.Id',
      ].join('; '),
    ], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) {
      const stderr = String(result.stderr || '').trim();
      const stdout = String(result.stdout || '').trim();
      throw new Error(stderr || stdout || 'Could not open OpenCode update terminal.');
    }
    return {
      message: `${mode === 'install' ? 'OpenCode install' : 'OpenCode update'} terminal opened.`,
      pid: Number.parseInt(String(result.stdout || '').trim(), 10) || null,
    };
  }

  const shellScript = [
    `printf '\\033]0;${String(title).replace(/'/g, '')}\\007'`,
    `cd ${shQuote(APP_ROOT)}`,
    `printf '%s\\n' ${shQuote(mode === 'install' ? 'OpenCode install helper' : 'OpenCode update helper')}`,
    `printf '%s\\n' ${shQuote('This terminal is intentionally launched outside agent mode.')}`,
    warning ? `printf '%s\\n' ${shQuote(warning)}` : null,
    `printf '\\n'`,
    `printf '%s' ${shQuote(`Press Enter to run: ${command}`)}`,
    'read -r _',
    command,
    `printf '\\n'`,
    `printf '%s' ${shQuote(`${mode === 'install' ? 'Install' : 'Update'} command finished. Press Enter to close this helper`)}`,
    'read -r _',
  ].filter(Boolean).join('\n');

  if (process.platform === 'darwin') {
    const result = spawnSync('osascript', [
      '-e',
      `tell application "Terminal" to do script "${appleScriptQuote(shellScript)}"`,
    ], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(String(result.stderr || '').trim() || String(result.stdout || '').trim() || `Could not open OpenCode ${mode} terminal.`);
    }
    return { message: `${mode === 'install' ? 'OpenCode install' : 'OpenCode update'} terminal opened.`, pid: null };
  }

  const linuxLaunchers = [
    ['x-terminal-emulator', ['-e', 'sh', '-lc', shellScript]],
    ['gnome-terminal', ['--', 'sh', '-lc', shellScript]],
    ['konsole', ['-e', 'sh', '-lc', shellScript]],
    ['xfce4-terminal', ['-e', `sh -lc ${shQuote(shellScript)}`]],
    ['mate-terminal', ['--', 'sh', '-lc', shellScript]],
    ['lxterminal', ['-e', 'sh', '-lc', shellScript]],
    ['xterm', ['-e', 'sh', '-lc', shellScript]],
  ];
  let lastError = '';
  for (const [launcher, args] of linuxLaunchers) {
    if (!commandExists(launcher)) continue;
    const result = spawnSync(launcher, args, { encoding: 'utf8' });
    if (result.status === 0) {
      return { message: `${mode === 'install' ? 'OpenCode install' : 'OpenCode update'} terminal opened.`, pid: null };
    }
    lastError = String(result.stderr || '').trim() || String(result.stdout || '').trim();
  }

  const result = spawnSync('sh', ['-lc', shellScript], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || '').trim() || String(result.stdout || '').trim() || lastError || `Could not open OpenCode ${mode} terminal.`);
  }
  return { message: `${mode === 'install' ? 'OpenCode install' : 'OpenCode update'} helper ran in the current shell.`, pid: null };
}

function openOpencodeUpdateTerminal() {
  const maintenance = opencode.resolveMaintenance();
  return openTerminalHelper({
    title: maintenance.installed ? 'OpenCode Update' : 'OpenCode Install',
    command: maintenance.installed ? maintenance.updateCommand : maintenance.installCommand,
    warning: maintenance.warning,
    mode: maintenance.installed ? 'update' : 'install',
  });
}

function activeProjectRootPath() {
  return getActiveProjectWorkspace().projectRoot;
}

function activeRuntimeOptions(extra = {}) {
  return {
    ...extra,
    projectRoot: activeProjectRootPath(),
  };
}

function nextMainTaskId(store) {
  const tasks = [
    ...(store.tasks || []),
    ...(store.nextTodo || []),
    ...(store.history || []),
  ];
  let maxId = 0;
  for (const task of tasks) {
    const match = /^TASK-(\d+)$/.exec(String(task.id || ''));
    if (!match) continue;
    maxId = Math.max(maxId, Number.parseInt(match[1], 10));
  }
  return `TASK-${String(maxId + 1).padStart(3, '0')}`;
}

function buildProjectManagerTaskRequestPrompt(request) {
  const attachmentLines = (request.attachments || []).map((attachment) => `${attachment.token}: ${attachment.path}`);
  const projectRoot = activeProjectRootPath();
  const coordinationCli = path.join(APP_ROOT, 'system', 'agent-coordination.js');
  return [
    'New task request from the user.',
    'Analyze this request as Project Manager.',
    'If it is actionable, create one or more Todo Tasks using this exact coordination CLI command: create-next-todo.',
    `Every coordination CLI command must include: --project "${projectRoot}".`,
    `Example command shape: node "${coordinationCli}" create-next-todo --project "${projectRoot}" --role SS --name "<your agent name>" --session-id "<your session id>" --task "<task id>" --title "<title>".`,
    'For create-next-todo, --role is the recommended owner role for the new Todo item, not your Project Manager identity. Use --name and --session-id for your identity.',
    'Do not use create-task for user requests unless the user explicitly asks to start active execution immediately.',
    'After creating Todo Tasks, verify they exist by running the coordination CLI query with --include-next.',
    'Only tell the user that tasks were created if the query confirms they are present.',
    'When useful, add one or more --context-hint values matching stable headings in .tiny-agent-office/general-context.md.',
    'Use context hints to point implementation agents to the most relevant context sections, not to summarize the whole context.',
    'Do not implement it yourself unless it is purely PM planning work.',
    'Keep your response brief and report the verified Todo Tasks you created.',
    '',
    'User request:',
    request.text || '',
    attachmentLines.length > 0 ? `\nAttached image paths:\n${attachmentLines.join('\n')}` : '',
  ].join('\n').trim();
}

function queueProjectManagerTaskRequest(payload = {}) {
  const textValue = String(payload.text || '').trim();
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (!textValue && attachments.length === 0) throw new Error('Task request text or attachment is required.');

  return runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const queue = state.userTaskQueue || runtimeStore.emptyUserTaskQueue();
    const now = utcNow();
    const request = {
      id: `user-task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text: textValue,
      attachments: attachments.map((attachment) => ({
        token: String(attachment.token || ''),
        path: String(attachment.path || ''),
      })).filter((attachment) => attachment.token || attachment.path),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    if (!Array.isArray(queue.pending)) queue.pending = [];
    queue.pending.push(request);
    queue.updatedAt = now;
    state.userTaskQueue = queue;
    return {
      message: queue.inFlight
        ? `Task request queued for Project Manager. ${queue.pending.length} pending.`
        : 'Task request queued for Project Manager.',
      request,
      queue,
    };
  });
}

function projectManagerCanAcceptUserRequest(agent) {
  if (!agent) return false;
  if (agent.role !== 'Project Manager') return false;
  if (!agent.hasLiveTerminal) return false;
  if (agent.operationalStatus === 'error') return false;
  if (agent.attentionRequired || agent.status === 'attention') return false;
  if (agent.activeTaskId) return false;
  if (['working', 'assigned', 'stalled', 'blocked'].includes(agent.status)) return false;
  if (agent.sessionConsole && Number(agent.sessionConsole.todoCount || 0) > 0) return false;
  return true;
}

function findAvailableProjectManager(derived) {
  return (derived.agents || []).find(projectManagerCanAcceptUserRequest) || null;
}

function latestProjectManagerConsoleActivity(consoleState) {
  if (!consoleState) {
    return {
      lastConsoleEventAt: null,
      lastAgentResponseAt: null,
    };
  }
  const messages = Array.isArray(consoleState.messages) ? consoleState.messages : [];
  const lastConsoleEventAt = newestTimestamp([
    consoleState.lastEventAt || null,
    ...messages.map((entry) => entry && entry.createdAt ? entry.createdAt : null),
  ]);
  const lastAgentResponseAt = newestTimestamp(messages
    .filter((entry) => entry && String(entry.role || '').toLowerCase() === 'assistant')
    .map((entry) => entry.createdAt || null));

  return {
    lastConsoleEventAt,
    lastAgentResponseAt,
  };
}

function userTaskRequestSettled(inFlight, pmAgent) {
  if (!inFlight || !inFlight.sentAt || !pmAgent || !pmAgent.sessionConsole) return false;
  const { lastConsoleEventAt, lastAgentResponseAt } = latestProjectManagerConsoleActivity(pmAgent.sessionConsole);
  const responseMs = parseTimeMs(lastAgentResponseAt);
  const eventMs = parseTimeMs(lastConsoleEventAt);
  const sentMs = parseTimeMs(inFlight.sentAt);
  if (sentMs == null || responseMs == null || responseMs < sentMs) return false;
  if (eventMs != null && Date.now() - eventMs < PM_USER_REQUEST_SETTLE_MS) return false;
  return true;
}

async function processProjectManagerTaskRequestQueue(snapshot, derived) {
  const queue = snapshot.userTaskQueue || runtimeStore.emptyUserTaskQueue();
  let changed = false;

  if (queue.inFlight) {
    const pmAgent = (derived.agents || []).find((agent) => agent.sessionId === queue.inFlight.sessionId);
    if (userTaskRequestSettled(queue.inFlight, pmAgent)) {
      runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
        const liveQueue = state.userTaskQueue || runtimeStore.emptyUserTaskQueue();
        if (!liveQueue.inFlight || liveQueue.inFlight.id !== queue.inFlight.id) return;
        const completed = {
          ...liveQueue.inFlight,
          status: 'completed',
          completedAt: utcNow(),
          updatedAt: utcNow(),
        };
        if (!Array.isArray(liveQueue.history)) liveQueue.history = [];
        liveQueue.history.unshift(completed);
        liveQueue.history = liveQueue.history.slice(0, USER_TASK_QUEUE_HISTORY_LIMIT);
        liveQueue.inFlight = null;
        liveQueue.updatedAt = utcNow();

        const liveAgent = (state.registry.agents || []).find((agent) => agent.sessionId === completed.sessionId);
        if (liveAgent && !liveAgent.activeTaskId && liveAgent.status !== 'attention') {
          liveAgent.status = 'available';
          liveAgent.note = 'Available for next request';
          liveAgent.lastSeenAt = utcNow();
          state.registry.updatedAt = utcNow();
        }
        state.userTaskQueue = liveQueue;
      });
      changed = true;
    }
  }

  const refreshedSnapshot = changed ? runtimeStore.readCoordinationState(activeRuntimeOptions({ runLimit: 25 })) : snapshot;
  const refreshedQueue = refreshedSnapshot.userTaskQueue || runtimeStore.emptyUserTaskQueue();
  if (refreshedQueue.inFlight || !Array.isArray(refreshedQueue.pending) || refreshedQueue.pending.length === 0) {
    return changed;
  }

  const pmAgent = findAvailableProjectManager(derived);
  if (!pmAgent) return changed;

  const reserved = runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const liveQueue = state.userTaskQueue || runtimeStore.emptyUserTaskQueue();
    if (liveQueue.inFlight || !Array.isArray(liveQueue.pending) || liveQueue.pending.length === 0) return null;
    const request = liveQueue.pending.shift();
    const now = utcNow();
    liveQueue.inFlight = {
      ...request,
      status: 'dispatching',
      sessionId: pmAgent.sessionId,
      agentName: pmAgent.agentName,
      sentAt: null,
      updatedAt: now,
    };
    liveQueue.updatedAt = now;

    const liveAgent = (state.registry.agents || []).find((agent) => agent.sessionId === pmAgent.sessionId);
    if (liveAgent) {
      liveAgent.status = 'assigned';
      liveAgent.note = 'Planning queued user task request';
      liveAgent.lastSeenAt = now;
      state.registry.updatedAt = now;
    }
    state.userTaskQueue = liveQueue;
    return liveQueue.inFlight;
  });

  if (!reserved) return changed;

  try {
    if (!String(reserved.text || '').trim() && (!Array.isArray(reserved.attachments) || reserved.attachments.length === 0)) {
      throw new Error('Refusing to deliver an empty Project Manager task request.');
    }
    await messageSession(pmAgent.sessionId, buildProjectManagerTaskRequestPrompt(reserved));
    runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
      const liveQueue = state.userTaskQueue || runtimeStore.emptyUserTaskQueue();
      if (!liveQueue.inFlight || liveQueue.inFlight.id !== reserved.id) return;
      const now = utcNow();
      liveQueue.inFlight.status = 'sent';
      liveQueue.inFlight.sentAt = now;
      liveQueue.inFlight.updatedAt = now;
      liveQueue.updatedAt = now;
      const liveAgent = (state.registry.agents || []).find((agent) => agent.sessionId === pmAgent.sessionId);
      if (liveAgent) {
        liveAgent.status = 'working';
        liveAgent.note = 'Planning user task request';
        liveAgent.lastPromptSentAt = now;
        liveAgent.lastSeenAt = now;
        state.registry.updatedAt = now;
      }
      state.userTaskQueue = liveQueue;
    });
  } catch (error) {
    runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
      const liveQueue = state.userTaskQueue || runtimeStore.emptyUserTaskQueue();
      if (!liveQueue.inFlight || liveQueue.inFlight.id !== reserved.id) return;
      const failed = {
        ...liveQueue.inFlight,
        status: 'failed',
        error: error.message,
        completedAt: utcNow(),
        updatedAt: utcNow(),
      };
      if (!Array.isArray(liveQueue.history)) liveQueue.history = [];
      liveQueue.history.unshift(failed);
      liveQueue.history = liveQueue.history.slice(0, USER_TASK_QUEUE_HISTORY_LIMIT);
      liveQueue.inFlight = null;
      liveQueue.updatedAt = utcNow();
      const liveAgent = (state.registry.agents || []).find((agent) => agent.sessionId === pmAgent.sessionId);
      if (liveAgent) {
        // A spend or prompt cap refusing delivery is a budget decision, not a
        // broken agent. Branding the Project Manager as operationally failed
        // would send the user chasing a session that is perfectly healthy.
        if (error.refused) {
          liveAgent.note = `Task request not delivered: ${error.message}`;
          liveAgent.lastSeenAt = utcNow();
        } else {
          liveAgent.status = 'attention';
          liveAgent.attentionRequired = true;
          liveAgent.operationalStatus = 'error';
          liveAgent.operationalError = `Could not deliver queued user task request: ${error.message}`;
          liveAgent.note = liveAgent.operationalError;
          liveAgent.lastSeenAt = utcNow();
        }
        state.registry.updatedAt = utcNow();
      }
      state.userTaskQueue = liveQueue;
    });
  }

  return true;
}

function ensureGeneralContextBootstrap() {
  const generalContextPath = contextManager.generalContextPath();
  const contextExists = fs.existsSync(generalContextPath);
  if (!contextExists) {
    fs.mkdirSync(path.dirname(generalContextPath), { recursive: true });
    fs.writeFileSync(generalContextPath, `${generalContextTemplate()}\n`, 'utf8');
  }

  return runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const hasBootstrapTask = [
      ...(state.tasksStore.tasks || []),
      ...(state.tasksStore.nextTodo || []),
      ...(state.tasksStore.history || []),
    ].some((task) => (
      task
      && task.title === CONTEXT_BOOTSTRAP_TASK_TITLE
      && task.recommendedRole === 'Senior Pro'
      && task.source
      && task.source.kind === 'general-context-bootstrap'
    ));

    if (contextExists || hasBootstrapTask) {
      return {
        createdContextFile: !contextExists,
        createdTask: false,
      };
    }

    const taskId = nextMainTaskId(state.tasksStore);
    const maxOrder = (state.tasksStore.tasks || []).reduce((max, task) => Math.max(max, task.order || 0), 0);
    if (!Array.isArray(state.tasksStore.tasks)) state.tasksStore.tasks = [];
    state.tasksStore.tasks.push({
      id: taskId,
      parentId: null,
      type: 'task',
      section: 'active',
      status: 'TODO',
      attentionType: null,
      title: CONTEXT_BOOTSTRAP_TASK_TITLE,
      recommendedRole: 'Senior Pro',
      priority: 'High',
      suggestedOwnerRole: null,
      goal: [
        'create the first reviewed project context for this repository',
        'replace the bootstrap placeholders in .tiny-agent-office/general-context.md with accurate project-specific content',
      ],
      scope: [
        'inspect the repository structure, active runtime surfaces, and coordination system before writing',
        'keep the document concise but high-signal',
        'include sections for Project Summary, Current Architecture, Important Decisions, Completed Work Summary, Current Focus, Known Risks, Reviewed Task Notes, and Notes for Future Agents',
        'capture only reviewed, durable context; avoid speculative filler and raw task-by-task noise',
      ],
      contextHints: [],
      prerequisites: [],
      claim: null,
      completedBy: null,
      completedAt: null,
      reports: [],
      notes: [
        {
          kind: 'bootstrap',
          text: 'Created automatically because the dashboard started without .tiny-agent-office/general-context.md.',
          createdAt: utcNow(),
        },
      ],
      children: [],
      source: {
        kind: 'general-context-bootstrap',
        path: '.tiny-agent-office/general-context.md',
      },
      order: maxOrder + 10,
    });
    coordinationCore.setWorkflowState(
      state.tasksStore.tasks[state.tasksStore.tasks.length - 1],
      'implementation_queue',
      'Senior Pro',
      null
    );
    state.tasksStore.updatedAt = utcNow();

    return {
      createdContextFile: !contextExists,
      createdTask: true,
      taskId,
    };
  });
}

function emptyRegistry() {
  return runtimeStore.emptyRegistry();
}

function buildPresetKey(name, role) {
  return `${String(name || '').toLowerCase()}::${String(role || '').toLowerCase()}`;
}

function findPresetForTask(fleetConfig, task) {
  const roleAcronym = task && task.claim && task.claim.role
    ? ({
        'Project Manager': 'PM',
        'Senior Pro': 'SP',
        'Semi Senior': 'SS',
        Junior: 'Jr',
      }[task.claim.role] || task.claim.role)
    : null;
  if (!roleAcronym || !task.claim || !task.claim.agentName) return null;
  return (fleetConfig.agents || []).find((preset) => (
    String(preset.name || '').toLowerCase() === String(task.claim.agentName || '').toLowerCase()
    && String(preset.role || '').toLowerCase() === String(roleAcronym).toLowerCase()
  )) || null;
}

function enrichDashboardStateWithExecution(derived, fleetConfig, liveRuns) {
  const presetMap = new Map((fleetConfig.agents || []).map((preset) => [
    buildPresetKey(preset.name, preset.role),
    preset,
  ]));
  const liveRunMap = new Map((liveRuns || []).map((run) => [run.agentSessionId, run]));

  derived.agents = (derived.agents || []).map((agent) => {
    const preset = presetMap.get(buildPresetKey(agent.agentName, agent.roleAcronym || agent.role));
    const liveRun = liveRunMap.get(agent.sessionId);
    return {
      ...agent,
      terminalPid: agent.terminalPid || null,
      source: preset ? 'fleet' : 'manual',
      sourceLabel: preset ? 'Fleet preset' : 'Manual session',
      modeLabel: agent.executionMode === 'daemon' ? 'Daemon' : 'Manual',
      hasLiveWorker: Boolean(liveRun),
      hasLiveTerminal: runtimeReconcile.isPidAlive(agent.terminalPid),
      presetModel: preset ? preset.model || null : null,
    };
  });

  derived.runningWorkers = (liveRuns || []).map((run) => ({
    runId: run.runId,
    agentSessionId: run.agentSessionId || null,
    agentName: run.agentName || null,
    role: run.role || null,
    taskId: run.taskId || null,
    workerPid: run.workerPid || null,
    startedAt: run.startedAt || null,
    updatedAt: run.updatedAt || null,
    adapterType: run.adapterType || null,
  }));

  return derived;
}

// Maps the plain facts OpenCode reports onto the dashboard's view model. This is
// the only place that knows both shapes, and the direction is deliberate: the
// OpenCode modules never see `derived`, `roles` or `alerts`.
function applyOpencodeFacts(derived) {
  const facts = opencode.factsFor((derived.agents || []).map((agent) => ({
    sessionId: agent.sessionId,
    adapterType: agent.adapterType,
    hasLiveTerminal: agent.hasLiveTerminal,
    serverHost: agent.serverHost,
    serverPort: agent.serverPort,
    opencodeSessionId: agent.opencodeSessionId,
    configuredModel: agent.presetModel || null,
  })));

  const alerts = Array.isArray(derived.alerts) ? [...derived.alerts] : [];

  for (const agent of derived.agents || []) {
    const fact = facts.get(agent.sessionId);
    if (!fact || !fact.reachable) {
      agent.nativePendingQuestions = 0;
      agent.nativePendingPermissions = 0;
      agent.nativeAttentionRequired = false;
      agent.pendingQuestions = 0;
      agent.pendingPermissions = 0;
      continue;
    }

    agent.sessionConsole = fact.consoleState;
    // The state machine's verdict, carried into the view. Without this the fact
    // is produced on every render and read by nobody, so the UI cannot show what
    // the scheduler is deciding from.
    agent.runtimeState = fact.runtimeState;
    agent.nativePendingQuestions = fact.pendingQuestions;
    agent.nativePendingPermissions = fact.pendingPermissions;
    agent.nativeAttentionRequired = fact.attentionRequired;
    agent.pendingQuestions = fact.pendingQuestions;
    agent.pendingPermissions = fact.pendingPermissions;
    agent.attentionRequired = Boolean(agent.attentionRequired || fact.attentionRequired);
    agent.operationalStatus = fact.operationalStatus;
    agent.operationalError = fact.operationalError;

    if (fact.attentionRequired && !agent.attentionRequest) {
      agent.status = 'attention';
      agent.note = fact.pendingQuestions > 0
        ? `Native OpenCode question pending${fact.firstQuestionText ? `: ${fact.firstQuestionText}` : ''}`
        : `Waiting for permission response (${fact.pendingPermissions})`;
      alerts.push(`${agent.agentName} has native OpenCode attention pending.${fact.firstQuestionText ? ` ${fact.firstQuestionText}` : ''}`);
    }

    if (fact.operationalStatus === 'error') {
      agent.status = 'attention';
      agent.attentionRequired = true;
      agent.note = fact.operationalError;
      alerts.push(`${agent.agentName} needs attention: ${fact.operationalError}`);
    }
  }

  derived.roles = (derived.roles || []).map((roleEntry) => {
    const roleAgents = (derived.agents || []).filter((agent) => agent.role === roleEntry.role);
    const broken = roleAgents.filter((agent) => agent.operationalStatus === 'error');
    const waiting = roleAgents.filter((agent) => agent.attentionRequired);
    if (broken.length > 0) {
      return { ...roleEntry, label: 'attention', detail: `${broken.length} session(s) connected but not operational.` };
    }
    if (waiting.length > 0) {
      return { ...roleEntry, label: 'attention', detail: `${waiting.length} session(s) waiting for user attention.` };
    }
    return roleEntry;
  });

  derived.alerts = alerts;
  return derived;
}

function buildAttentionReplyPrompt(taskId, question, answer) {
  return [
    `User response for your coordination question${taskId ? ` on ${taskId}` : ''}.`,
    `Question: ${question}.`,
    `Answer: ${answer}.`,
    'Continue the same task and keep explanations brief unless more detail is requested.',
  ].join(' ');
}

async function answerAgentAttention(sessionId, payload = {}) {
  if (!sessionId) throw new Error('sessionId is required.');
  const rawAnswer = String(payload.answer || '').trim();
  if (!rawAnswer) throw new Error('answer is required.');

  const snapshot = runtimeStore.readCoordinationState(activeRuntimeOptions());
  const agent = (snapshot.registry.agents || []).find((entry) => entry.sessionId === sessionId);
  if (!agent) throw new Error(`${sessionId} not found.`);
  if (!agent.attentionRequest) throw new Error(`${agent.agentName} has no pending coordination question.`);
  if (!Number.isInteger(agent.terminalPid) || !runtimeReconcile.isPidAlive(agent.terminalPid)) {
    throw new Error(`${agent.agentName} does not have a live launched terminal.`);
  }

  const replyDelivery = await sessionDispatch.sendPrompt(agent, buildAttentionReplyPrompt(
    agent.attentionRequest.taskId || null,
    agent.attentionRequest.question || 'User decision required',
    rawAnswer
  ), {
    runtimeOptions: activeRuntimeOptions(),
    command: 'attention-reply',
    taskId: agent.attentionRequest.taskId || null,
  });

  // A refusal does not throw. Clearing the pending question after one would lose
  // the user's answer and leave the agent waiting for a reply it never got.
  if (replyDelivery && replyDelivery.delivered === false) {
    const refusal = new Error(`Answer to ${agent.agentName} was refused: ${replyDelivery.refusedReason}.`);
    refusal.refused = true;
    refusal.refusedReason = replyDelivery.refusedReason;
    throw refusal;
  }

  return runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const liveAgent = (state.registry.agents || []).find((entry) => entry.sessionId === sessionId);
    if (!liveAgent) throw new Error(`${sessionId} not found.`);
    if (!liveAgent.attentionRequest) throw new Error(`${liveAgent.agentName} has no pending coordination question.`);
    const attention = liveAgent.attentionRequest;
    const task = attention.taskId
      ? (state.tasksStore.tasks || []).find((entry) => entry.id === attention.taskId)
      : null;
    if (task) {
      if (!Array.isArray(task.notes)) task.notes = [];
      task.notes.push({
        kind: 'user-answer',
        createdAt: new Date().toISOString(),
        agentName: liveAgent.agentName,
        role: liveAgent.role,
        question: attention.question || '',
        answer: rawAnswer,
      });
      state.tasksStore.updatedAt = new Date().toISOString();
    }
    liveAgent.attentionRequest = null;
    secretaryInbox.resolveInboxQuestion(state.secretaryInbox, { sessionId, answer: rawAnswer });
    liveAgent.status = attention.previousStatus || (liveAgent.activeTaskId ? 'working' : 'available');
    liveAgent.note = attention.previousNote || (liveAgent.activeTaskId ? 'User answer delivered.' : '');
    liveAgent.lastSeenAt = new Date().toISOString();
    liveAgent.lastPromptSentAt = liveAgent.lastSeenAt;
    state.registry.updatedAt = new Date().toISOString();
    return {
      message: `Answer sent to ${liveAgent.agentName}.`,
      sessionId: liveAgent.sessionId,
    };
  });
}

function parseTimeMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function newestTimestamp(values) {
  let latest = null;
  for (const value of values) {
    const ms = parseTimeMs(value);
    if (ms == null) continue;
    if (latest == null || ms > latest) latest = ms;
  }
  return latest == null ? null : new Date(latest).toISOString();
}

// ---------------------------------------------------------------------------
// Read path.
//
// buildView is the only function the render surfaces call: the WebSocket hub and
// GET /api/dashboard-state. It is a pure read over already-cached state. It must
// not write to the coordination store and must not talk to OpenCode. The
// regression suite asserts both.
// ---------------------------------------------------------------------------

function buildView() {
  const fleetConfig = daemonFleet.listConfig({ configPath: daemonFleet.DEFAULT_CONFIG_PATH });
  const snapshot = runtimeStore.readCoordinationState(activeRuntimeOptions({ runLimit: 25 }));
  const liveRuns = Array.from(runtimeReconcile.buildLiveRunMap(snapshot.runs || []).values());
  const derived = enrichDashboardStateWithExecution(
    deriveDashboardState(snapshot.tasksStore, snapshot.registry),
    fleetConfig,
    liveRuns
  );

  applyOpencodeFacts(derived);

  derived.daemonStatus = snapshot.daemonStatus;
  derived.userTaskQueue = snapshot.userTaskQueue || runtimeStore.emptyUserTaskQueue();
  derived.secretaryInbox = snapshot.secretaryInbox || runtimeStore.emptySecretaryInbox();
  derived.runs = snapshot.runs;
  derived.fleetConfig = fleetConfig;
  derived.project = {
    root: getActiveProjectWorkspace().projectRoot,
    officeRoot: getActiveProjectWorkspace().paths.officeRoot,
  };
  derived.maintenanceNotifications = opencode.maintenanceNotifications();
  // Placement joined with what is actually running. `activated` is the user's
  // intent and the live session is the observation; they are reported side by
  // side rather than one overwriting the other.
  // App-level, so it is deliberately read without a project. It rides the
  // project payload because that is the channel the UI already has, not because
  // it belongs to the project.
  derived.blueprints = blueprintStore.readBlueprints();
  derived.cartridges = buildCartridgeView(
    runtimeStore.readProjectCartridges(activeRuntimeOptions()),
    derived.agents,
    derived.blueprints
  );
  derived.worldTick = worldTick ? worldTick.getStatus() : null;
  return derived;
}

// ---------------------------------------------------------------------------
// Write path.
//
// advanceWorld is the only place the dashboard process mutates the world. It runs
// on its own interval through system/runtime/world-tick.js, which guarantees two
// passes never overlap. Dispatch is deliberately absent: the daemon owns
// scheduling, this tick owns reconciliation and the Project Manager queue.
//
// Nothing here holds a lock across the OpenCode calls; every write goes through a
// short mutateCoordination so the daemon is not blocked behind runtime.db.lock.
// ---------------------------------------------------------------------------

// The agent shape the caches need, taken straight from the registry. Building a
// full view here would be circular: the caches these two consumers maintain are
// what the view reads.
function liveAgentsForCaches(snapshot) {
  return (snapshot.registry.agents || []).map((agent) => ({
    ...agent,
    hasLiveTerminal: runtimeReconcile.isPidAlive(agent.terminalPid),
  }));
}

async function advanceWorld() {
  const result = {
    recoveredManualSessions: 0,
    watchdog: null,
    queueChanged: false,
    failures: [],
  };

  // Each phase fails on its own. A flaky OpenCode endpoint must not starve the
  // reconciliation or the Project Manager queue that run after it.
  const phase = async (name, run) => {
    try {
      return await run();
    } catch (error) {
      result.failures.push({ phase: name, error: error && error.message ? error.message : String(error) });
      return null;
    }
  };

  // 0. Seeding is a write, so it belongs here and not in whatever happens to
  //    open the database first. It is a no-op once the store has been seeded.
  await phase('ensure-initialized', async () => runtimeStore.ensureInitialized(activeRuntimeOptions()));

  // 1. Reconcile durable state with the real processes.
  await phase('reconcile', async () => {
    const recovered = await liveSessionRecovery.detectLiveManualSessionsAsync(activeProjectRootPath());
    runtimeReconcile.reconcileCoordination(activeRuntimeOptions());
    if (recovered.length > 0) {
      result.recoveredManualSessions = recovered.length;
      runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
        liveSessionRecovery.recoverLiveManualSessionCandidates(state, recovered);
      });
    }
  });

  // 2. Refresh the caches the read path depends on.
  const liveAgents = liveAgentsForCaches(runtimeStore.readCoordinationState(activeRuntimeOptions({ runLimit: 1 })));
  await phase('event-broker-sync', async () => opencode.syncSessions(liveAgents));
  await phase('attention-cache', async () => opencode.refreshAttention(liveAgents));
  // Rescues sessions stuck in a state no event will move them out of. Read-only:
  // it lists messages and sends nothing.
  await phase('session-state-sweep', async () => opencode.sweepSessionStates(liveAgents));

  // The seam to the daemon. It is a separate process and cannot read the
  // in-memory state store, so the registry is how the verdict crosses over.
  // Without this the scheduler never sees an idle agent and nothing dispatches.
  await phase('publish-runtime-state', async () => runtimeStore.publishAgentRuntimeStates(
    activeRuntimeOptions(),
    opencode.runtimeStatesFor(liveAgents)
  ));
  await phase('close-finished-prompts', async () => {
    for (const agent of liveAgents) {
      if (!agent.opencodeSessionId) continue;
      if (opencode.runtimeStateFor(agent.opencodeSessionId).state !== 'idle') continue;
      runtimeStore.closeOpenPromptEntries(activeRuntimeOptions(), {
        agentSessionId: agent.sessionId,
        outcome: 'completed',
        reason: 'session returned to idle',
      });
    }
  });
  await phase('models-cache', async () => opencode.refreshModels());
  await phase('maintenance-cache', async () => opencode.refreshMaintenance());

  // 3. Advance the world itself.
  const watchdogResult = await phase('watchdog', async () => (
    opencode.reconcileActivity(activeRuntimeOptions())
  ));
  result.watchdog = watchdogResult;

  await phase('pm-request-queue', async () => {
    const snapshot = runtimeStore.readCoordinationState(activeRuntimeOptions({ runLimit: 25 }));
    result.queueChanged = await processProjectManagerTaskRequestQueue(snapshot, buildView());
  });

  // Batched on purpose: one narrow insert per pass instead of a lock per
  // transition. Costs up to a tick of transitions if the process dies mid-pass,
  // which is accepted for a diagnostic and visualisation log.
  // Cost and tokens, from what OpenCode reported on the stream. Every ledger
  // row read 0 after a full task cycle because nothing ever collected this,
  // which left the spend cap uncalibratable and the budget mechanic sourceless.
  // The runtime names the message each prompt became. Attribute first, so a
  // cost reported in the same pass has something to attach to.
  await phase('prompt-admissions', async () => {
    const admissions = opencode.drainAdmissions();
    if (admissions.length === 0) return;
    const agents = runtimeStore.readCoordinationState(activeRuntimeOptions({ runLimit: 1 })).registry.agents || [];
    runtimeStore.attributePromptMessage(activeRuntimeOptions(), admissions.map((admission) => {
      const agent = agents.find((entry) => entry.opencodeSessionId === admission.sessionId);
      return agent ? { agentSessionId: agent.sessionId, messageId: admission.messageId } : null;
    }).filter(Boolean));
  });

  await phase('prompt-usage', async () => {
    const usage = opencode.drainUsage();
    if (usage.length > 0) runtimeStore.recordPromptUsage(activeRuntimeOptions(), usage);
  });

  await phase('transition-log', async () => transitionBuffer.flush());

  const watchdogChanged = Boolean(watchdogResult)
    && (watchdogResult.inspected > 0 || watchdogResult.pinged > 0 || watchdogResult.released > 0);
  if (watchdogChanged || result.queueChanged) {
    await phase('post-reconcile', async () => runtimeReconcile.reconcileCoordination(activeRuntimeOptions()));
  }

  return result;
}

function promoteNextTodo(id) {
  if (!id) throw new Error('id is required.');
  return runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const store = state.tasksStore;
    const nextTodo = store.nextTodo || [];
    const idx = nextTodo.findIndex((item) => item.id === id);
    if (idx === -1) {
      const alreadyActive = (store.tasks || []).find((item) => item.id === id);
      if (alreadyActive) throw new Error(`${id} is already in active tasks.`);
      throw new Error(`${id} not found in nextTodo.`);
    }

    const [item] = nextTodo.splice(idx, 1);
    item.section = 'active';
    coordinationCore.setWorkflowState(
      item,
      coordinationCore.requireRole(item.recommendedRole) === 'Project Manager' ? 'pm_planning' : 'implementation_queue',
      coordinationCore.requireRole(item.recommendedRole),
      null
    );
    const maxOrder = (store.tasks || []).reduce((max, task) => Math.max(max, task.order || 0), 0);
    item.order = maxOrder + 10;
    if (!Array.isArray(store.tasks)) store.tasks = [];
    store.tasks.push(item);
    store.updatedAt = new Date().toISOString();
    taskGraphIntegrity.normalizeTaskGraph(store);

    return {
      message: `${id} promoted to active tasks.`,
      store,
    };
  });
}

function removeNextTodo(id) {
  if (!id) throw new Error('id is required.');
  return runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const store = state.tasksStore;
    const nextTodo = store.nextTodo || [];
    const idx = nextTodo.findIndex((item) => item.id === id);
    if (idx === -1) {
      throw new Error(`${id} not found in nextTodo.`);
    }

    const [item] = nextTodo.splice(idx, 1);
    store.updatedAt = new Date().toISOString();

    return {
      message: `${id} removed from next-todo queue.`,
      task: { id: item.id, title: item.title },
    };
  });
}

function hasOpenActiveChildren(store, taskId) {
  return (store.tasks || []).some((entry) => (
    entry.parentId === taskId && !coordinationCore.FINISHED_STATUSES.has(entry.status)
  ));
}

function activeTaskHasOwner(task) {
  return Boolean(task && task.claim && task.claim.agentName && ['CLAIMED', 'IN_PROGRESS'].includes(task.status));
}

function moveActiveTaskToNext(id) {
  if (!id) throw new Error('id is required.');
  return runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const store = state.tasksStore;
    const tasks = store.tasks || [];
    const idx = tasks.findIndex((item) => item.id === id);
    if (idx === -1) throw new Error(`${id} not found in active tasks.`);

    const task = tasks[idx];
    if (hasOpenActiveChildren(store, task.id)) {
      throw new Error(`${id} has open subtasks. Move or remove the subtasks first.`);
    }
    if (activeTaskHasOwner(task)) {
      throw new Error(`${id} is currently claimed by ${task.claim.agentName}. Close or release that session first.`);
    }

    const [item] = tasks.splice(idx, 1);
    item.section = 'nextTodo';
    item.status = 'TODO';
    item.attentionType = null;
    item.claim = null;
    item.reviewClaim = null;
    coordinationCore.setWorkflowState(item, 'backlog', coordinationCore.requireRole(item.recommendedRole), null);
    item.notes = Array.isArray(item.notes) ? item.notes : [];
    item.notes.push({
      kind: 'user-moved-to-next',
      text: 'Task moved back to Todo Tasks from the dashboard.',
      createdAt: new Date().toISOString(),
    });

    const maxOrder = (store.nextTodo || []).reduce((max, entry) => Math.max(max, entry.order || 0), 0);
    item.order = maxOrder + 10;
    if (!Array.isArray(store.nextTodo)) store.nextTodo = [];
    store.nextTodo.push(item);
    store.updatedAt = new Date().toISOString();

    return {
      message: `${id} moved back to Todo Tasks.`,
      task: { id: item.id, title: item.title, status: item.status },
    };
  });
}

function deleteActiveTask(id) {
  if (!id) throw new Error('id is required.');
  return runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const store = state.tasksStore;
    const task = (store.tasks || []).find((item) => item.id === id);
    if (!task) throw new Error(`${id} not found in active tasks.`);
    if (hasOpenActiveChildren(store, task.id)) {
      throw new Error(`${id} has open subtasks. Delete the subtasks first.`);
    }
    if (activeTaskHasOwner(task)) {
      throw new Error(`${id} is currently claimed by ${task.claim.agentName}. Close or release that session first.`);
    }

    task.status = 'CANCELLED';
    task.attentionType = null;
    task.claim = null;
    task.reviewClaim = null;
    coordinationCore.setWorkflowState(task, 'closed', null, null);
    task.notes = Array.isArray(task.notes) ? task.notes : [];
    task.notes.push({
      kind: 'user-deleted-active-task',
      text: 'Task removed from Active Tasks by the user.',
      createdAt: new Date().toISOString(),
    });

    for (const agent of state.registry.agents || []) {
      if (agent.activeTaskId === task.id) {
        agent.activeTaskId = null;
        agent.status = agent.status === 'working' || agent.status === 'assigned' ? 'available' : agent.status;
        agent.note = 'Task was removed by the user.';
      }
    }

    store.updatedAt = new Date().toISOString();
    state.registry.updatedAt = new Date().toISOString();

    return {
      message: `${id} deleted from Active Tasks.`,
      task: { id: task.id, title: task.title, status: task.status },
    };
  });
}

function removeSession(sessionId) {
  if (!sessionId) throw new Error('sessionId is required.');
  return runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const agent = (state.registry.agents || []).find((entry) => entry.sessionId === sessionId);
    if (!agent) throw new Error(`${sessionId} not found.`);
    const terminalCloseRequested = Number.isInteger(agent.terminalPid) && agent.terminalPid > 0
      ? daemonFleet.requestKillPid(agent.terminalPid)
      : false;

    const ownedTask = agent.activeTaskId
      ? (state.tasksStore.tasks || []).find((entry) => entry.id === agent.activeTaskId)
      : null;

    if (ownedTask && ownedTask.claim
      && ownedTask.claim.agentName === agent.agentName
      && ownedTask.claim.role === agent.role) {
      ownedTask.status = 'BLOCKED';
      ownedTask.attentionType = agent.role === 'Project Manager' ? null : 'implementation_help';
      if (!Array.isArray(ownedTask.notes)) ownedTask.notes = [];
      ownedTask.notes.push({
        kind: 'session-removed',
        text: `Session ${agent.agentName} (${agent.sessionId}) was removed from the dashboard registry.`,
        createdAt: new Date().toISOString(),
      });
    }

    state.registry.agents = (state.registry.agents || []).filter((entry) => entry.sessionId !== sessionId);
    state.registry.updatedAt = new Date().toISOString();
    state.tasksStore.updatedAt = new Date().toISOString();

    return {
      message: `${agent.agentName} removed from registered sessions.`,
      sessionId,
      taskBlocked: ownedTask ? ownedTask.id : null,
      terminalCloseRequested,
    };
  });
}

function removeLiveSessions() {
  return runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const now = new Date().toISOString();
    const agents = state.registry.agents || [];
    const removed = [];
    const taskMap = new Map((state.tasksStore.tasks || []).map((task) => [task.id, task]));

    for (const agent of agents) {
      const hasLiveTerminal = Number.isInteger(agent.terminalPid) && runtimeReconcile.isPidAlive(agent.terminalPid);
      if (!hasLiveTerminal) continue;

      const terminalCloseRequested = daemonFleet.requestKillPid(agent.terminalPid);
      const ownedTask = agent.activeTaskId ? taskMap.get(agent.activeTaskId) : null;

      if (ownedTask && ownedTask.claim
        && ownedTask.claim.agentName === agent.agentName
        && ownedTask.claim.role === agent.role) {
        ownedTask.status = 'BLOCKED';
        ownedTask.attentionType = agent.role === 'Project Manager' ? null : 'implementation_help';
        if (!Array.isArray(ownedTask.notes)) ownedTask.notes = [];
        ownedTask.notes.push({
          kind: 'app-close-session-removed',
          text: `Session ${agent.agentName} (${agent.sessionId}) was closed when the application exited.`,
          createdAt: now,
        });
      }

      removed.push({
        sessionId: agent.sessionId,
        agentName: agent.agentName,
        role: agent.role,
        taskBlocked: ownedTask ? ownedTask.id : null,
        terminalCloseRequested,
      });
    }

    if (removed.length === 0) {
      return {
        message: 'No live agent sessions were open.',
        removed,
      };
    }

    const removedSessionIds = new Set(removed.map((entry) => entry.sessionId));
    state.registry.agents = agents.filter((agent) => !removedSessionIds.has(agent.sessionId));
    state.registry.updatedAt = now;
    state.tasksStore.updatedAt = now;

    return {
      message: `${removed.length} live agent session(s) closed.`,
      removed,
    };
  });
}

function focusSession(sessionId) {
  if (!sessionId) throw new Error('sessionId is required.');
  const snapshot = runtimeStore.readCoordinationState(activeRuntimeOptions());
  let agent = (snapshot.registry.agents || []).find((entry) => entry.sessionId === sessionId);
  if (!agent) throw new Error(`${sessionId} not found.`);
  if (!Number.isInteger(agent.terminalPid) || !runtimeReconcile.isPidAlive(agent.terminalPid)) {
    throw new Error(`${agent.agentName} does not have a live launched terminal.`);
  }

  const windowInfo = sessionDispatch.resolveAgentTerminalWindow(agent);
  if (windowInfo && (
    agent.terminalWindowHandle !== windowInfo.handle
    || agent.terminalHostPid !== windowInfo.pid
    || agent.terminalHostProcessName !== (windowInfo.processName || null)
    || agent.terminalWindowTitle !== (windowInfo.title || null)
  )) {
    runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
      const liveAgent = (state.registry.agents || []).find((entry) => entry.sessionId === sessionId);
      if (!liveAgent) return;
      liveAgent.terminalWindowHandle = Number.isInteger(windowInfo.handle) ? windowInfo.handle : null;
      liveAgent.terminalHostPid = Number.isInteger(windowInfo.pid) ? windowInfo.pid : null;
      liveAgent.terminalHostProcessName = windowInfo.processName || null;
      liveAgent.terminalWindowTitle = windowInfo.title || null;
      state.registry.updatedAt = new Date().toISOString();
    });
    const refreshed = runtimeStore.readCoordinationState(activeRuntimeOptions());
    agent = (refreshed.registry.agents || []).find((entry) => entry.sessionId === sessionId) || agent;
  }

  sessionDispatch.activateAgentTerminal(agent);
  return {
    message: `${agent.agentName} focused.`,
    sessionId: agent.sessionId,
  };
}

async function messageSession(sessionId, text, options = {}) {
  if (!sessionId) throw new Error('sessionId is required.');
  const trimmedText = String(text || '').trim();
  if (!trimmedText) throw new Error('text is required.');
  const snapshot = runtimeStore.readCoordinationState(activeRuntimeOptions());
  const agent = (snapshot.registry.agents || []).find((entry) => entry.sessionId === sessionId);
  if (!agent) throw new Error(`${sessionId} not found.`);
  if (!opencode.isOpencodeAgent(agent)) {
    throw new Error(`${agent.agentName} does not support dashboard messaging.`);
  }
  if (!Number.isInteger(agent.terminalPid) || !runtimeReconcile.isPidAlive(agent.terminalPid)) {
    throw new Error(`${agent.agentName} does not have a live launched terminal.`);
  }
  const promptResult = await sessionDispatch.sendPromptToOpencode(agent, trimmedText, {
    runtimeOptions: activeRuntimeOptions(),
    limits: resolveLimits(options.limits || {}),
    command: options.command || 'message',
    taskId: options.taskId || agent.activeTaskId || null,
  });

  // A refused prompt does not throw, so it has to be checked. Reporting a
  // refusal as "sent" is how a user's request would disappear silently.
  if (promptResult && promptResult.delivered === false) {
    const refusal = new Error(`Message to ${agent.agentName} was refused: ${promptResult.refusedReason}.`);
    // Marked so callers can tell a budget decision from a broken session.
    refusal.refused = true;
    refusal.refusedReason = promptResult.refusedReason;
    throw refusal;
  }

  runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const liveAgent = (state.registry.agents || []).find((entry) => entry.sessionId === sessionId);
    if (!liveAgent) return;
    liveAgent.lastPromptSentAt = new Date().toISOString();
    if (promptResult && promptResult.opencodeSessionId) {
      liveAgent.opencodeSessionId = promptResult.opencodeSessionId;
      liveAgent.opencodeSessionTitle = promptResult.opencodeSessionTitle || null;
    }
    liveAgent.lastSeenAt = liveAgent.lastPromptSentAt;
    state.registry.updatedAt = new Date().toISOString();
  });
  return {
    message: `Message sent to ${agent.agentName}.`,
    sessionId: agent.sessionId,
  };
}

function resolvePmSession(state, requestedSessionId = null) {
  const pmSessions = (state.registry.agents || []).filter((agent) => agent.role === 'Project Manager');
  if (requestedSessionId) {
    const match = pmSessions.find((agent) => agent.sessionId === requestedSessionId);
    if (!match) throw new Error(`Project Manager session ${requestedSessionId} not found.`);
    return match;
  }
  if (pmSessions.length === 1) return pmSessions[0];
  if (pmSessions.length === 0) throw new Error('No Project Manager session is registered.');
  throw new Error('Multiple Project Manager sessions are registered. Specify sessionId.');
}

function resolveSeniorProSessionForTask(state, task, requestedSessionId = null) {
  const spSessions = (state.registry.agents || []).filter((agent) => agent.role === 'Senior Pro');
  if (requestedSessionId) {
    const match = spSessions.find((agent) => agent.sessionId === requestedSessionId);
    if (!match) throw new Error(`Senior Pro session ${requestedSessionId} not found.`);
    return match;
  }

  if (task && task.reviewedBy && task.reviewedBy.agentName) {
    const reviewedBySession = spSessions.find((agent) => agent.agentName === task.reviewedBy.agentName);
    if (reviewedBySession) return reviewedBySession;
  }

  if (task && task.claim && task.claim.role === 'Senior Pro' && task.claim.agentName) {
    const claimingSession = spSessions.find((agent) => agent.agentName === task.claim.agentName);
    if (claimingSession) return claimingSession;
  }

  if (spSessions.length === 1) return spSessions[0];
  if (spSessions.length === 0) throw new Error('No Senior Pro session is registered.');
  throw new Error('Multiple Senior Pro sessions are registered. Specify sessionId.');
}

function contextReviewResolved(task) {
  return contextManager.proposalResolved(task && task.contextProposal);
}

function pmReviewTask(taskId, payload = {}) {
  if (!taskId) throw new Error('taskId is required.');
  return runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const pmSession = resolvePmSession(state, payload.sessionId || null);
    const task = (state.tasksStore.tasks || []).find((entry) => entry.id === taskId);
    if (!task) throw new Error(`${taskId} not found.`);
    if (task.status !== 'DONE' && task.status !== 'REVIEW_NEEDED') {
      throw new Error(`${taskId} must be DONE or REVIEW_NEEDED before PM review.`);
    }

    const contextResolved = contextReviewResolved(task);
    const contextApplyResult = contextResolved
      ? contextManager.applyContextProposal(task, { appliedBy: pmSession.agentName })
      : null;
    task.status = contextResolved ? 'CONTEXT_UPDATED' : 'PM_REVIEWED';
    task.attentionType = null;
    coordinationCore.setWorkflowState(task, 'pm_closeout', 'Project Manager', pmSession.sessionId);
    if (!Array.isArray(task.notes)) task.notes = [];
    task.notes.push({
      kind: 'pm-review',
      text: payload.note || (contextResolved
        ? `Task approved by user; ${contextApplyResult.summary}`
        : 'Task reviewed by PM from dashboard.'),
      createdAt: new Date().toISOString(),
      agentName: pmSession.agentName,
      role: pmSession.role,
      sessionId: pmSession.sessionId,
    });

    state.tasksStore.updatedAt = new Date().toISOString();
    state.registry.updatedAt = new Date().toISOString();

    return {
      message: contextResolved
        ? `${taskId} marked as CONTEXT_UPDATED.`
        : `${taskId} marked as PM_REVIEWED.`,
      task: { id: task.id, title: task.title, status: task.status },
      sessionId: pmSession.sessionId,
      contextApplyResult,
    };
  });
}

function archiveTaskDirect(taskId, payload = {}) {
  if (!taskId) throw new Error('taskId is required.');
  return runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const pmSession = resolvePmSession(state, payload.sessionId || null);
    const task = (state.tasksStore.tasks || []).find((entry) => entry.id === taskId);
    if (!task) throw new Error(`${taskId} not found.`);
    if (!['DONE', 'REVIEW_NEEDED', 'PM_REVIEWED', 'CONTEXT_UPDATED'].includes(task.status)) {
      throw new Error(`${taskId} cannot be archived directly from status ${task.status}.`);
    }

    task.status = 'ARCHIVED';
    task.attentionType = null;
    coordinationCore.setWorkflowState(task, 'closed', null, null);
    if (!Array.isArray(task.notes)) task.notes = [];
    task.notes.push({
      kind: 'pm-archive-direct',
      text: payload.note || 'Task archived directly from dashboard without PM review/context pass.',
      createdAt: new Date().toISOString(),
      agentName: pmSession.agentName,
      role: pmSession.role,
      sessionId: pmSession.sessionId,
    });

    state.tasksStore.updatedAt = new Date().toISOString();
    state.registry.updatedAt = new Date().toISOString();

    return {
      message: `${taskId} archived directly.`,
      task: { id: task.id, title: task.title, status: task.status },
      sessionId: pmSession.sessionId,
    };
  });
}

function buildExplainTestPrompt(task) {
  return [
    `Review task ${task.id} - ${task.title}.`,
    'Explain briefly what was done and how the user should test it.',
    'Read the task reports/notes for this task before answering.',
    'Keep the answer concise and practical.',
    'Use this format:',
    '1. What was done',
    '2. How to test it',
    '3. What was not tested or still risky',
  ].join(' ');
}

function buildExplainTaskPrompt(task) {
  return [
    `Explain task ${task.id} - ${task.title}.`,
    'Explain briefly what this task means, why it exists, and what outcome is expected.',
    'Read the task fields and notes before answering.',
    'Keep the answer concise and practical.',
    'Use this format:',
    '1. Purpose',
    '2. Expected result',
    '3. Important constraints or prerequisites',
  ].join(' ');
}

function buildUserDeclinePrompt(task, reason) {
  return [
    `The user declined task ${task.id} - ${task.title}.`,
    `Decline reason: ${reason}.`,
    'Read the task reports and the decline reason.',
    'Plan the required adjustments.',
    'Create or update the follow-up tasks needed for the changes.',
    'If you create a follow-up implementation subtask for this declined task, parent it to the declined task but do not add the declined task as a prerequisite; the follow-up must remain claimable while the declined task stays in review.',
    'Keep the response concise and action-oriented.',
  ].join(' ');
}

async function explainHowToTest(taskId, payload = {}) {
  if (!taskId) throw new Error('taskId is required.');
  const snapshot = runtimeStore.readCoordinationState(activeRuntimeOptions());
  const task = (snapshot.tasksStore.tasks || []).find((entry) => entry.id === taskId);
  if (!task) throw new Error(`${taskId} not found.`);
  const seniorSession = resolveSeniorProSessionForTask(snapshot, task, payload.sessionId || null);
  focusSession(seniorSession.sessionId);
  const result = await messageSession(seniorSession.sessionId, buildExplainTestPrompt(task));
  return {
    message: `Senior Pro focused and asked to explain how to test ${taskId}.`,
    task: { id: task.id, title: task.title },
    sessionId: result.sessionId,
  };
}

async function explainTask(taskId, payload = {}) {
  if (!taskId) throw new Error('taskId is required.');
  const snapshot = runtimeStore.readCoordinationState(activeRuntimeOptions());
  const task = [
    ...(snapshot.tasksStore.tasks || []),
    ...(snapshot.tasksStore.nextTodo || []),
    ...(snapshot.tasksStore.history || []),
  ].find((entry) => entry.id === taskId);
  if (!task) throw new Error(`${taskId} not found.`);
  const pmSession = resolvePmSession(snapshot, payload.sessionId || null);
  focusSession(pmSession.sessionId);
  const result = await messageSession(pmSession.sessionId, buildExplainTaskPrompt(task));
  return {
    message: `Project Manager focused and asked to explain ${taskId}.`,
    task: { id: task.id, title: task.title },
    sessionId: result.sessionId,
  };
}

async function userDeclineTask(taskId, payload = {}) {
  if (!taskId) throw new Error('taskId is required.');
  const reason = String(payload.reason || '').trim();
  if (!reason) throw new Error('reason is required.');

  const mutation = runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
    const pmSession = resolvePmSession(state, payload.sessionId || null);
    const task = (state.tasksStore.tasks || []).find((entry) => entry.id === taskId);
    if (!task) throw new Error(`${taskId} not found.`);
    if (!['DONE', 'PM_REVIEWED'].includes(task.status)) {
      throw new Error(`${taskId} must be DONE or PM_REVIEWED before user decline.`);
    }

    task.status = 'REVIEW_NEEDED';
    task.attentionType = 'senior_closure';
    task.reviewClaim = null;
    task.reviewedBy = null;
    contextManager.discardContextProposal(task, {
      discardedBy: pmSession.agentName,
      reason,
    });
    coordinationCore.setWorkflowState(task, 'senior_review', 'Senior Pro', null);
    if (!Array.isArray(task.notes)) task.notes = [];
    task.notes.push({
      kind: 'user-decline',
      text: reason,
      createdAt: new Date().toISOString(),
      agentName: pmSession.agentName,
      role: pmSession.role,
      sessionId: pmSession.sessionId,
    });

    state.tasksStore.updatedAt = new Date().toISOString();
    state.registry.updatedAt = new Date().toISOString();

    return {
      pmSessionId: pmSession.sessionId,
      task: { id: task.id, title: task.title, status: task.status },
      reason,
    };
  });

  try {
    const refreshed = runtimeStore.readCoordinationState(activeRuntimeOptions());
    const task = (refreshed.tasksStore.tasks || []).find((entry) => entry.id === taskId);
    const seniorSession = resolveSeniorProSessionForTask(refreshed, task, payload.seniorSessionId || null);
    focusSession(seniorSession.sessionId);
    await messageSession(seniorSession.sessionId, buildUserDeclinePrompt(task, reason));
    return {
      message: `${taskId} declined and sent back to Senior Pro for follow-up planning.`,
      task: mutation.task,
      sessionId: seniorSession.sessionId,
      pmSessionId: mutation.pmSessionId,
    };
  } catch (_) {
    return {
      message: `${taskId} declined and returned to Senior Pro review queue.`,
      task: mutation.task,
      pmSessionId: mutation.pmSessionId,
    };
  }
}

async function reviveTask(taskId, payload = {}) {
  if (!taskId) throw new Error('taskId is required.');

  const runtimeSnapshot = runtimeStore.readCoordinationState(activeRuntimeOptions());
  const task = (runtimeSnapshot.tasksStore.tasks || []).find((entry) => entry.id === taskId);
  if (!task) throw new Error(`${taskId} not found.`);

  let sessionId = payload.sessionId || null;
  if (!sessionId) {
    const existingSession = (runtimeSnapshot.registry.agents || []).find((agent) => (
      task.claim
      && agent.agentName === task.claim.agentName
      && agent.role === task.claim.role
      && agent.executionMode === 'manual'
      && Number.isInteger(agent.terminalPid)
      && runtimeReconcile.isPidAlive(agent.terminalPid)
    ));
    if (existingSession) {
      sessionId = existingSession.sessionId;
    }
  }

  if (!sessionId) {
    const fleetConfig = daemonFleet.listConfig({ configPath: daemonFleet.DEFAULT_CONFIG_PATH });
    const preset = findPresetForTask(fleetConfig, task);
    if (!preset) {
      throw new Error(`No fleet preset matches ${task.claim ? task.claim.agentName : taskId}.`);
    }

    const launch = await daemonFleet.launchPreset({
      configPath: daemonFleet.DEFAULT_CONFIG_PATH,
      name: preset.name,
      tasksPath: payload.tasksPath || null,
      registryPath: payload.registryPath || null,
      dbPath: payload.dbPath || null,
      runsPath: payload.runsPath || null,
    });
    sessionId = launch && launch.launched ? launch.launched.sessionId : null;
  }

  if (!sessionId) throw new Error(`Could not obtain a session to revive ${taskId}.`);

  return sessionDispatch.reviveBlockedTask({
    tasksPath: payload.tasksPath || null,
    registryPath: payload.registryPath || null,
    dbPath: payload.dbPath || null,
    runsPath: payload.runsPath || null,
  }, taskId, sessionId);
}

async function handleApi(req, res) {
  if (req.method === 'GET' && req.url === '/api/projects') {
    const workspace = getActiveProjectWorkspace();
    json(res, 200, {
      currentProject: {
        root: workspace.projectRoot,
        officeRoot: workspace.paths.officeRoot,
        initialized: workspace.exists(),
      },
      recentProjects: recentProjects.readRecentProjects().projects,
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/projects/open') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.projectRoot) throw new Error('projectRoot is required.');
        const workspace = configureProjectWorkspace(payload.projectRoot);
        recentProjects.rememberProject(workspace.projectRoot);
        ensureGeneralContextBootstrap();
        json(res, 200, {
          message: `${workspace.projectRoot} opened.`,
          project: {
            root: workspace.projectRoot,
            officeRoot: workspace.paths.officeRoot,
          },
          recentProjects: recentProjects.readRecentProjects().projects,
        });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/dashboard-state') {
    json(res, 200, buildView());
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/telemetry') {
    json(res, 200, coordinationTelemetry.computeTelemetry(activeRuntimeOptions()));
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/telemetry/reset') {
    json(res, 200, coordinationTelemetry.resetTelemetry(activeRuntimeOptions()));
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/tasks') {
    json(res, 200, runtimeStore.readCoordinationState(activeRuntimeOptions()).tasksStore);
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/agents') {
    json(res, 200, runtimeStore.readCoordinationState(activeRuntimeOptions()).registry);
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/runs') {
    runtimeReconcile.reconcileCoordination(activeRuntimeOptions());
    json(res, 200, runtimeStore.listRuns({ runLimit: 25 }));
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/daemon/status') {
    runtimeReconcile.reconcileCoordination(activeRuntimeOptions());
    json(res, 200, runtimeStore.readCoordinationState(activeRuntimeOptions({ runLimit: 5 })).daemonStatus);
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/fleet') {
    json(res, 200, daemonFleet.listConfig({ configPath: daemonFleet.DEFAULT_CONFIG_PATH }));
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/themes') {
    try {
      json(res, 200, themeService.listThemes());
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/opencode/models') {
    json(res, 200, await opencode.getModels());
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/adapters') {
    json(res, 200, { adapters: [opencode.describe()] });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/opencode/models/refresh') {
    json(res, 200, await opencode.getModels({ forceRefresh: true }));
    return true;
  }

  if (req.method === 'GET' && req.url === '/api/maintenance/opencode-update') {
    json(res, 200, opencode.forceMaintenanceCheck());
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/maintenance/opencode-update/fix') {
    try {
      json(res, 200, openOpencodeUpdateTerminal());
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/tasks/promote') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const result = promoteNextTodo(id);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/tasks/next-todo/remove') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const result = removeNextTodo(id);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/tasks/active/move-to-next') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const result = moveActiveTaskToNext(id);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/tasks/active/delete') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const result = deleteActiveTask(id);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/agents/clear') {
    const result = runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => {
      state.registry = emptyRegistry();
      return {
        message: 'Registry cleared. Task data was not modified.',
        registry: state.registry,
      };
    });
    json(res, 200, result);
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/agents/remove') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = removeSession(payload.sessionId);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  // Blueprints. App-level, so none of these take a project.
  if (req.method === 'POST' && req.url === '/api/blueprints/save') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = blueprintStore.saveBlueprint({}, payload.blueprint || {});
        json(res, result.saved ? 200 : 404, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  // Where a blueprint's instances are, across every project this machine knows.
  // The prompt needs to name them, so a count would not do.
  // Reordering the tray. One request for the whole column, because a reorder
  // shifts every place between the old and new positions.
  if (req.method === 'POST' && req.url === '/api/blueprints/reorder') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        json(res, 200, blueprintStore.reorderBlueprints({}, payload.order || []));
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/blueprints/instances') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        json(res, 200, blueprintInstances.findBlueprintInstances(payload.blueprintId, {
          alsoInclude: [activeProjectRootPath()],
        }));
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  // Editing a blueprint. The edit is the irreversible commit, so the operation
  // stops or unlinks the running instances first and only then writes it -- and
  // refuses the whole thing if anything blocks, rather than leaving an agent
  // running whose definition changed underneath it.
  if (req.method === 'POST' && req.url === '/api/blueprints/apply-edit') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = blueprintInstances.applyBlueprintEdit(payload.id, {
          definition: payload.definition,
          trayIndex: payload.trayIndex,
          choice: payload.choice,
          alsoInclude: [activeProjectRootPath()],
          stopSession: (instance) => {
            if (!instance.sessionId) return true;
            const snapshot = runtimeStore.readCoordinationState({ projectRoot: instance.projectRoot, runLimit: 1 });
            const agent = (snapshot.registry.agents || [])
              .find((entry) => entry.sessionId === instance.sessionId);
            if (!agent || !Number.isInteger(agent.terminalPid)) return true;
            return daemonFleet.requestKillPid(agent.terminalPid);
          },
        });
        json(res, result.applied ? 200 : 409, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/blueprints/delete') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        // Unlink everywhere first, remove the blueprint last, and refuse the
        // whole thing if any project cannot be reached.
        const result = blueprintInstances.deleteBlueprintEverywhere(payload.id, {
          alsoInclude: [activeProjectRootPath()],
        });
        json(res, result.deleted ? 200 : 409, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  // Cartridge placement. Committed when a drag ends, not while it moves: a
  // gesture emits a position on every mouse move and none of them belong on the
  // file lock.
  if (req.method === 'POST' && req.url === '/api/cartridges/save') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = runtimeStore.saveProjectCartridge(activeRuntimeOptions(), payload.cartridge || {});
        // A refusal is a normal answer here -- the project already has an
        // instance of that blueprint -- so it is reported as one rather than as
        // an error, and the client shows the hint the plan specifies.
        json(res, result.saved ? 200 : 409, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/cartridges/remove') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        json(res, 200, runtimeStore.removeProjectCartridge(activeRuntimeOptions(), payload.id));
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  // The one-time import of what the browser was holding. Idempotent by a marker
  // in the store, so a second call -- or a second browser profile -- does
  // nothing, and cartridges the user has deleted stay deleted.
  if (req.method === 'POST' && req.url === '/api/cartridges/import-legacy') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        json(res, 200, runtimeStore.importLegacyProjectCartridges(
          activeRuntimeOptions(),
          Array.isArray(payload.cartridges) ? payload.cartridges : [],
          // The way back in if an import goes wrong. Nothing sets this on its
          // own: a forced run overwrites placements, so it is a deliberate act.
          { force: payload.force === true }
        ));
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/agents/close-live') {
    try {
      json(res, 200, removeLiveSessions());
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/agents/focus') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = focusSession(payload.sessionId);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/agents/message') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = await messageSession(payload.sessionId, payload.text);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/project-manager/task-requests') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = queueProjectManagerTaskRequest(payload);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/agents/attachments') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = saveAgentAttachment(payload);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/agents/attention/respond') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = await answerAgentAttention(payload.sessionId, payload);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/secretary/messages/dismiss') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.id) throw new Error('id is required.');
        const result = runtimeStore.mutateCoordination(activeRuntimeOptions(), (state) => (
          secretaryInbox.dismissInboxMessage(state.secretaryInbox, payload.id)
        ));
        json(res, 200, { message: 'Message dismissed.', ...result });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/cartridges/memory/clean') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const cartridge = runtimeStore.readProjectCartridges(activeRuntimeOptions())
          .find((entry) => entry.id === payload.cartridgeId);
        const snapshot = runtimeStore.readCoordinationState(activeRuntimeOptions());
        agentMemory.assertMemoryCanBeCleaned({
          cartridge,
          agents: snapshot.registry.agents,
          isPidAlive: runtimeReconcile.isPidAlive,
        });
        const definition = cartridge.definition || {};
        const cleaned = agentMemory.cleanAgentMemory({
          projectRoot: activeProjectRootPath(),
          cartridgeId: cartridge.id,
          agentName: definition.name || 'Unnamed agent',
          role: definition.role || 'Unknown',
        });
        json(res, 200, {
          message: cleaned.archivedPath ? 'Agent memory archived and cleaned.' : 'Fresh agent memory created.',
          memoryPath: cleaned.path,
          archivedPath: cleaned.archivedPath,
        });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/fleet/add') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = daemonFleet.addAgent({
          configPath: daemonFleet.DEFAULT_CONFIG_PATH,
          cli: payload.cli,
          role: payload.role,
          name: payload.name,
          workspace: activeProjectRootPath(),
          model: payload.model,
          profile: payload.profile,
          opencodeAgent: payload.opencodeAgent,
          startupInstructions: payload.startupInstructions,
          disabled: Boolean(payload.disabled),
        });
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/fleet/delete') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = daemonFleet.removeAgent({
          configPath: daemonFleet.DEFAULT_CONFIG_PATH,
          name: payload.name,
        });
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/fleet/update') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = daemonFleet.updateAgent({
          configPath: daemonFleet.DEFAULT_CONFIG_PATH,
          name: payload.name,
          cli: payload.cli,
          role: payload.role,
          workspace: activeProjectRootPath(),
          model: Object.prototype.hasOwnProperty.call(payload, 'model') ? payload.model : undefined,
          profile: Object.prototype.hasOwnProperty.call(payload, 'profile') ? payload.profile : undefined,
          opencodeAgent: Object.prototype.hasOwnProperty.call(payload, 'opencodeAgent') ? payload.opencodeAgent : undefined,
          disabled: Object.prototype.hasOwnProperty.call(payload, 'disabled') ? payload.disabled : undefined,
        });
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/fleet/register') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = daemonFleet.registerFleet({
          configPath: daemonFleet.DEFAULT_CONFIG_PATH,
          tasksPath: payload.tasksPath || null,
          registryPath: payload.registryPath || null,
          dbPath: payload.dbPath || null,
          runsPath: payload.runsPath || null,
        });
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/fleet/register-one') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = daemonFleet.registerOne({
          configPath: daemonFleet.DEFAULT_CONFIG_PATH,
          name: payload.name,
          tasksPath: payload.tasksPath || null,
          registryPath: payload.registryPath || null,
          dbPath: payload.dbPath || null,
          runsPath: payload.runsPath || null,
        });
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/fleet/launch') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = await daemonFleet.launchPreset({
          configPath: daemonFleet.DEFAULT_CONFIG_PATH,
          name: payload.name,
          cartridgeId: payload.cartridgeId,
          workspace: activeProjectRootPath(),
          tasksPath: payload.tasksPath || null,
          registryPath: payload.registryPath || null,
          dbPath: payload.dbPath || null,
          runsPath: payload.runsPath || null,
        });
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/dispatch/run-next') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.sessionId) throw new Error('sessionId is required.');
        const runtimeOptionsForRequest = activeRuntimeOptions({
          tasksPath: payload.tasksPath || null,
          registryPath: payload.registryPath || null,
          dbPath: payload.dbPath || null,
          runsPath: payload.runsPath || null,
        });
        const snapshot = runtimeStore.readCoordinationState(runtimeOptionsForRequest);
        const agent = (snapshot.registry.agents || []).find((entry) => entry.sessionId === payload.sessionId);
        const result = agent && agent.activeTaskId
          ? await sessionDispatch.continueActiveTask(runtimeOptionsForRequest, payload.sessionId)
          : await sessionDispatch.dispatchNextTask(runtimeOptionsForRequest, payload.sessionId);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/tasks/revive') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.taskId) throw new Error('taskId is required.');
        const result = await reviveTask(payload.taskId, payload);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/tasks/pm-review') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = pmReviewTask(payload.taskId, payload);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/tasks/archive-direct') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = archiveTaskDirect(payload.taskId, payload);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/tasks/explain-test') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = await explainHowToTest(payload.taskId, payload);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/tasks/explain-task') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = await explainTask(payload.taskId, payload);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/tasks/user-decline') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = await userDeclineTask(payload.taskId, payload);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/fleet/up') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = await daemonFleet.up({
          configPath: daemonFleet.DEFAULT_CONFIG_PATH,
          tasksPath: payload.tasksPath || null,
          registryPath: payload.registryPath || null,
          dbPath: payload.dbPath || null,
          runsPath: payload.runsPath || null,
          dashboardPort: payload.dashboardPort || null,
          daemonIntervalMs: payload.daemonIntervalMs || null,
          noDashboard: true,
        });
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && req.url === '/api/fleet/down') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = daemonFleet.down({
          configPath: daemonFleet.DEFAULT_CONFIG_PATH,
          tasksPath: payload.tasksPath || null,
          registryPath: payload.registryPath || null,
          dbPath: payload.dbPath || null,
          runsPath: payload.runsPath || null,
        });
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
    return true;
  }

  return false;
}

function createServer() {
  const server = http.createServer((req, res) => {
    Promise.resolve(handleApi(req, res))
      .then((handled) => {
        if (handled) return;
        if (req.url.startsWith('/api/')) {
          text(res, 404, 'Not found');
          return;
        }
        if (req.method === 'GET' && serveReactApp(req, res, { appDistDir: APP_DIST_DIR })) return;
        text(res, 404, 'Not found');
      })
      .catch((error) => {
        json(res, 500, {
          error: error.message,
        });
      });
  });
  const hub = new DashboardWebSocketHub({
    buildPayload: async () => buildView(),
    intervalMs: 1000,
  });
  hub.attach(server);

  worldTick = createWorldTick({
    label: 'dashboard-world-tick',
    intervalMs: WORLD_TICK_INTERVAL_MS,
    advance: advanceWorld,
    onError: (error) => {
      console.error(`World tick failed: ${error.message}`);
    },
  });
  // start() runs the first pass immediately and then chains: the render path no
  // longer warms these caches, so they must be primed at startup.
  worldTick.start();

  server.on('close', () => {
    hub.close();
    if (worldTick) worldTick.stop();
    // Event streams and their reconnect timers outlive the server otherwise.
    opencode.dispose();
  });
  return server;
}

function main() {
  const portArgIndex = process.argv.indexOf('--port');
  const projectArgIndex = process.argv.indexOf('--project');
  const port = portArgIndex !== -1 && process.argv[portArgIndex + 1]
    ? Number(process.argv[portArgIndex + 1])
    : Number(process.env.PORT || DEFAULT_PORT);
  const projectRoot = projectArgIndex !== -1 && process.argv[projectArgIndex + 1]
    ? process.argv[projectArgIndex + 1]
    : process.env.TAO_PROJECT_ROOT || process.cwd();

  if (!Number.isInteger(port) || port < 1) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }

  const workspace = configureProjectWorkspace(projectRoot);
  runtimeStore.ensureInitialized(activeRuntimeOptions());
  ensureGeneralContextBootstrap();

  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`TinyAgentOffice dashboard: http://127.0.0.1:${port}/`);
    console.log(`Project: ${workspace.projectRoot}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  createServer,
  ensureGeneralContextBootstrap,
  buildProjectManagerTaskRequestPrompt,
  buildView,
  queueProjectManagerTaskRequest,
  advanceWorld,
  disposeOpencodeRuntime: () => opencode.dispose(),
  main,
};
