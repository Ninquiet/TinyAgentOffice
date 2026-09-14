'use strict';

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const coordinationCore = require('../runtime/coordination-core');
const runtimeStore = require('../runtime/runtime-store');
const runtimeReconcile = require('../runtime/runtime-reconcile');
const terminalWindowHost = require('../platform/terminal-window-host');
const opencodeSessionResolver = require('../opencode/session-resolver');
const opencodeProvider = require('../opencode/provider');

function utcNow() {
  return new Date().toISOString();
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function createSessionId(name, role) {
  const normalizedRole = coordinationCore.requireRole(role);
  const suffix = String(coordinationCore.ROLE_ACRONYMS[normalizedRole] || normalizedRole).toLowerCase();
  return `${slugify(name)}-${suffix}-${Date.now()}`;
}

function runtimeOptions(options = {}) {
  return {
    projectRoot: options.projectRoot || options.workspacePath || null,
    tasksPath: options.tasksPath || null,
    registryPath: options.registryPath || null,
    dbPath: options.dbPath || null,
    runsPath: options.runsPath || null,
  };
}

function chooseTaskForRole(store, role) {
  const normalizedRole = coordinationCore.requireRole(role);
  if (normalizedRole === 'Project Manager') {
    const tasks = coordinationCore.activeTasks(store);
    const taskMap = coordinationCore.buildTaskMap(store);
    const claimable = [];

    for (const task of tasks) {
      if (coordinationCore.normalizedTaskRole(task) !== 'Project Manager') continue;
      if (task.status !== 'TODO') continue;
      if (coordinationCore.hasOpenSubtasks(task, tasks)) continue;

      let blocked = false;
      for (const prereqId of task.prerequisites || []) {
        const prerequisite = taskMap.get(prereqId);
        if (!prerequisite || !coordinationCore.SATISFIED_STATUSES.has(prerequisite.status)) {
          blocked = true;
          break;
        }
      }

      if (!blocked) {
        claimable.push(task);
      }
    }

    claimable.sort(coordinationCore.sortClaimable);
    return claimable[0] || null;
  }
  return coordinationCore.chooseAssignableTask(store, normalizedRole);
}

function buildDispatchInstruction(agent, task) {
  const identity = buildSessionIdentityInstruction(agent);
  const contextHints = Array.isArray(task.contextHints) && task.contextHints.length > 0
    ? `Suggested context sections: ${task.contextHints.map((hint) => `"${hint}"`).join(', ')}. Read these sections first; read the full context if more background is needed.`
    : 'No task-specific context sections were provided; read the full context if needed.';
  const instructions = [
    identity,
    `You already own ${task.id} - ${task.title}.`,
    'Read .tiny-agent-office/AGENTS.md, .tiny-agent-office/agents-principles.md, and .tiny-agent-office/general-context.md.',
    contextHints,
    'Work only on that task and do not claim another one.',
  ];
  if (task.status === 'REVIEW_NEEDED' && agent.role === 'Senior Pro') {
    instructions.push(
      'When approving this Senior Pro review, close it with the coordination CLI complete command using your exact --name, --role, and --session-id flags.',
      'If no durable project context changed, include: --context-reviewed not-needed --context-note "No durable project context changed."'
    );
  }
  instructions.push('Communicate in English and keep explanations brief unless the user asks for more detail.');
  return instructions.join(' ');
}

function buildResumeInstruction(agent, task) {
  const identity = buildSessionIdentityInstruction(agent);
  const contextHints = Array.isArray(task.contextHints) && task.contextHints.length > 0
    ? `Suggested context sections: ${task.contextHints.map((hint) => `"${hint}"`).join(', ')}. Read these sections first; read the full context if more background is needed.`
    : 'No task-specific context sections were provided; read the full context if needed.';
  return [
    identity,
    `Resume ${task.id} - ${task.title}.`,
    'This task was blocked because the previous session was lost.',
    'Read .tiny-agent-office/AGENTS.md, .tiny-agent-office/agents-principles.md, and .tiny-agent-office/general-context.md.',
    contextHints,
    'Continue the same task; do not claim another one and do not restart from scratch.',
    'Communicate in English and keep explanations brief unless the user asks for more detail.',
  ].join(' ');
}

function buildSessionIdentityInstruction(agent) {
  const projectRoot = path.resolve(agent.workspacePath || process.cwd());
  const coordinationCli = path.join(__dirname, '..', 'agent-coordination.js');
  const requiredIdentityFlags = `--project "${projectRoot}" --name "${agent.agentName}" --role "${coordinationCore.ROLE_ACRONYMS[agent.role] || agent.role}" --session-id "${agent.sessionId}"`;
  return [
    `Agent Name: ${agent.agentName}.`,
    `Role: ${agent.role}.`,
    `Session ID: ${agent.sessionId}.`,
    agent.cartridgeId ? `Cartridge ID: ${agent.cartridgeId}.` : null,
    agent.memoryPath ? `Agent Memory Path: ${agent.memoryPath}. Read it before task work and update it briefly after completing a task.` : null,
    `Project root: ${projectRoot}.`,
    `Use the coordination CLI at: ${coordinationCli}.`,
    `Every coordination CLI command must include these identity flags: ${requiredIdentityFlags}.`,
    'This session was already created by the dashboard.',
    'Use exactly that Agent Name and Session ID in every coordination command.',
    'Do not invent a new name even though .tiny-agent-office/AGENTS.md normally asks for one; this session must keep the registered identity.',
  ].filter(Boolean).join(' ');
}

function httpJsonRequest(baseOptions, method, pathName, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: baseOptions.hostname,
      port: baseOptions.port,
      method,
      path: pathName,
      timeout: baseOptions.timeoutMs || 2000,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : undefined,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${pathName} failed with ${res.statusCode}. ${raw}`.trim()));
          return;
        }
        if (!raw) {
          resolve(true);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (_) {
          resolve(raw);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`${method} ${pathName} timed out.`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForOpencodeServer(agent, requestJson = httpJsonRequest) {
  const hostname = agent.serverHost || '127.0.0.1';
  const port = Number(agent.serverPort);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`${agent.agentName} has no OpenCode server port.`);
  }

  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await requestJson({ hostname, port, timeoutMs: 1000 }, 'GET', '/global/health');
      return { hostname, port };
    } catch (error) {
      lastError = error;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  throw new Error(`OpenCode server did not become ready for ${agent.agentName}. ${lastError ? lastError.message : ''}`.trim());
}

// The prompt hash is half the idempotency key, so it has to be a function of
// the prompt text and nothing else. Anything time- or random-derived in here
// would switch deduplication off without failing anything.
function hashPrompt(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 32);
}

// The real ledger, backed by the coordination store. Injectable so tests can
// observe the calls without a database.
function createStoreLedger(options = {}, limits = {}) {
  return {
    reserve: (request) => runtimeStore.reservePrompt(options, request, limits),
    recordTransport: (key, status, details) => runtimeStore.recordPromptTransport(options, key, status, details),
    recordOutcome: (key, status, details) => runtimeStore.recordPromptOutcome(options, key, status, details),
  };
}

async function sendPromptToOpencode(agent, text, dependencies = {}) {
  const requestJson = dependencies.httpJsonRequest || httpJsonRequest;
  const resolverApi = dependencies.sessionResolver || opencodeSessionResolver;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  // Nothing is sent without a reservation, and there is no way to opt out. A
  // ledger the send path does not write is worse than none: the caps never fire
  // and the table stays empty while looking like protection. Callers that cannot
  // reach a database pass an in-memory ledger instead of disabling recording.
  const ledger = dependencies.ledger || createStoreLedger(dependencies.runtimeOptions || {}, dependencies.limits || {});

  const promptHash = hashPrompt(text);
  const reservationRequest = {
    agentSessionId: agent.sessionId,
    taskId: dependencies.taskId || agent.activeTaskId || null,
    command: dependencies.command || 'message',
    // Which run at this task this is. A task released by the watchdog comes
    // back with its attempt advanced, so the identical instruction sent again
    // is a new ledger entry rather than a duplicate of the one that failed.
    attempt: dependencies.attempt || 0,
    promptHash,
  };

  const reserved = ledger.reserve(reservationRequest);
  if (!reserved || !reserved.reserved) {
    // Refusing is a normal outcome, not an error: the caps exist to be hit.
    return {
      delivered: false,
      refusedReason: (reserved && reserved.reason) || 'ledger-refused',
      opencodeSessionId: agent.opencodeSessionId || null,
      opencodeSessionTitle: agent.opencodeSessionTitle || null,
      deliveryVerified: false,
    };
  }

  const ledgerKey = reserved.entry ? reserved.entry.idempotencyKey : null;

  const noteTransport = (status, details) => ledger.recordTransport(ledgerKey, status, details);
  const noteOutcome = (status, details) => ledger.recordOutcome(ledgerKey, status, details);
  const endpoint = await waitForOpencodeServer(agent, requestJson);
  const promptText = String(text || '');
  const identity = {
    dashboardSessionId: agent.sessionId,
    agentName: agent.agentName,
  };
  const knownSessions = await resolverApi.listSessions(endpoint);
  const identitySession = await resolverApi.findSessionByDashboardIdentity(endpoint, identity, knownSessions);
  const preferredSessionId = identitySession && identitySession.id
    ? identitySession.id
    : agent.opencodeSessionId || null;
  const beforePreferredMessages = preferredSessionId
    ? await resolverApi.listMessages(endpoint, preferredSessionId)
    : [];
  const preferredCheckpoint = resolverApi.sessionMessageCheckpoint(beforePreferredMessages);
  const beforeUpdates = resolverApi.indexSessionUpdates(knownSessions);
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let submitted = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      await requestJson(endpoint, 'POST', '/tui/append-prompt', { text: promptText });
      noteTransport('appended');
      // eslint-disable-next-line no-await-in-loop
      await requestJson(endpoint, 'POST', '/tui/submit-prompt');
      submitted = true;
      noteTransport('submitted');
      for (let detectionAttempt = 0; detectionAttempt < 10; detectionAttempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(150);
        if (preferredSessionId) {
          // eslint-disable-next-line no-await-in-loop
          const messages = await resolverApi.listMessages(endpoint, preferredSessionId);
          if (resolverApi.hasDeliveredPromptAfterCheckpoint(messages, preferredCheckpoint, promptText)) {
            // eslint-disable-next-line no-await-in-loop
            const session = await resolverApi.getSession(endpoint, preferredSessionId);
            noteOutcome('admitted', { deliveryVerified: true });
            return {
              opencodeSessionId: preferredSessionId,
              opencodeSessionTitle: session && (session.title || session.name) ? session.title || session.name : agent.opencodeSessionTitle || null,
              deliveryVerified: true,
            };
          }
        }

        // eslint-disable-next-line no-await-in-loop
        const touchedSession = resolverApi.detectTouchedSession(beforeUpdates, await resolverApi.listSessions(endpoint));
        if (touchedSession) {
          // eslint-disable-next-line no-await-in-loop
          const messages = await resolverApi.listMessages(endpoint, touchedSession.id);
          if (!resolverApi.messagePayloadMatchesDashboardIdentity(messages, identity)) continue;
          if (!messages.some((message) => message && message.info && message.info.role === 'user' && resolverApi.extractMessageText(message).includes(promptText.trim()))) continue;
          noteOutcome('admitted', { deliveryVerified: true });
          return {
            opencodeSessionId: touchedSession.id,
            opencodeSessionTitle: touchedSession.title,
            deliveryVerified: true,
          };
        }
      }
      noteOutcome('failed', { error: 'delivery not verified after submit' });
      return {
        opencodeSessionId: preferredSessionId || agent.opencodeSessionId || null,
        opencodeSessionTitle: agent.opencodeSessionTitle || null,
        deliveryVerified: false,
        deliveryWarning: 'OpenCode accepted the prompt request, but prompt delivery was not verified.',
      };
    } catch (error) {
      lastError = error;
      if (submitted) {
        noteOutcome('failed', { error: error.message });
        return {
          opencodeSessionId: preferredSessionId || agent.opencodeSessionId || null,
          opencodeSessionTitle: agent.opencodeSessionTitle || null,
          deliveryVerified: false,
          deliveryWarning: `OpenCode accepted the prompt request, but prompt delivery was not verified. ${error.message}`.trim(),
        };
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(250);
    }
  }

  noteOutcome('failed', { error: lastError ? lastError.message : 'prompt delivery failed' });
  throw new Error(`Prompt delivery failed for ${agent.agentName}. ${lastError ? lastError.message : ''}`.trim());
}

function activateAgentTerminal(agent) {
  const windowInfo = resolveAgentTerminalWindow(agent);
  if (!windowInfo) {
    throw new Error(`Could not resolve a terminal window for ${agent.agentName}. Relaunch the session to register its host window.`);
  }
  terminalWindowHost.focusWindow(windowInfo.handle, windowInfo.pid || null);
}

function resolveAgentTerminalWindow(agent) {
  if (Number.isInteger(agent.terminalWindowHandle) && agent.terminalWindowHandle > 0) {
    return {
      handle: agent.terminalWindowHandle,
      pid: Number.isInteger(agent.terminalHostPid) ? agent.terminalHostPid : null,
      processName: agent.terminalHostProcessName || null,
      title: agent.terminalWindowTitle || null,
    };
  }

  const windows = terminalWindowHost.listWindows();
  const titleHints = [agent.terminalWindowTitle, agent.agentName, agent.sessionId].filter(Boolean);

  const exactWindow = windows.find((entry) => (
    Number.isInteger(agent.terminalHostPid)
    && entry.pid === agent.terminalHostPid
  ));
  if (exactWindow && Number.isInteger(exactWindow.handle) && exactWindow.handle > 0) {
    return exactWindow;
  }

  const hintedWindow = windows.find((entry) => titleHints.some((hint) => String(entry.title || '').toLowerCase().includes(String(hint).toLowerCase())));
  if (hintedWindow && Number.isInteger(hintedWindow.handle) && hintedWindow.handle > 0) {
    return hintedWindow;
  }

  const shellMatchedWindow = windows.find((entry) => (
    Number.isInteger(agent.terminalPid)
    && entry.pid === agent.terminalPid
  ));
  if (shellMatchedWindow && Number.isInteger(shellMatchedWindow.handle) && shellMatchedWindow.handle > 0) {
    return shellMatchedWindow;
  }

  return null;
}

// Prompts go to OpenCode's HTTP API and nowhere else. There used to be a
// fallback here that took over the user's clipboard, called AppActivate on
// whatever window matched the agent name, and SendKeys'd Ctrl+V and Enter into
// it. It was unreachable in practice, and broken anyway: it called a psQuote
// that is not defined in this module, so it would have thrown a ReferenceError
// on the first invocation.
async function sendPrompt(agent, text, dependencies = {}) {
  opencodeProvider.requireOpencodeAgent(agent);
  return sendPromptToOpencode(agent, text, dependencies);
}

function reserveTaskForSession(options, sessionId) {
  return runtimeStore.mutateCoordination(runtimeOptions(options), (state) => {
    const agent = (state.registry.agents || []).find((entry) => entry.sessionId === sessionId);
    if (!agent) throw new Error(`Session ${sessionId} not found.`);
    if (!Number.isInteger(agent.terminalPid) || !runtimeReconcile.isPidAlive(agent.terminalPid)) {
      throw new Error(`${agent.agentName} does not have a live launched terminal.`);
    }
    if (agent.activeTaskId || agent.attentionRequired || agent.operationalStatus === 'error' || ['attention', 'assigned', 'working', 'blocked'].includes(agent.status)) {
      throw new Error(`${agent.agentName} is not idle.`);
    }

    const task = chooseTaskForRole(state.tasksStore, agent.role);
    if (!task) {
      throw new Error(`No claimable active task is available for ${agent.role}.`);
    }

    const evaluation = coordinationCore.evaluateStructuredTask(task, agent.role, state.tasksStore);
    if (!evaluation.claimable) {
      throw new Error(`${task.id} is no longer claimable for ${agent.role}.`);
    }

    if (evaluation.isSeniorReview) {
      task.status = 'REVIEW_NEEDED';
      task.attentionType = 'senior_closure';
      task.reviewClaim = {
        agentName: agent.agentName,
        role: agent.role,
        claimedAt: utcNow(),
        sessionId: agent.sessionId,
      };
      coordinationCore.setWorkflowState(task, 'senior_review', 'Senior Pro', agent.sessionId);
    } else {
      task.status = 'CLAIMED';
      task.attentionType = null;
      task.claim = {
        agentName: agent.agentName,
        role: agent.role,
        claimedAt: utcNow(),
      };
      coordinationCore.setWorkflowState(task, 'implementation', agent.role, agent.sessionId);
    }

    agent.status = 'assigned';
    agent.activeTaskId = task.id;
    agent.note = 'Task reserved; delivering prompt to launched terminal';
    agent.lastPromptSentAt = utcNow();
    agent.lastSeenAt = utcNow();

    state.tasksStore.updatedAt = utcNow();
    state.registry.updatedAt = utcNow();

    return {
      agent: {
        sessionId: agent.sessionId,
        agentName: agent.agentName,
        role: agent.role,
        adapterType: agent.adapterType || null,
        terminalPid: agent.terminalPid,
        workspacePath: agent.workspacePath || null,
        serverHost: agent.serverHost || null,
        serverPort: Number.isInteger(agent.serverPort) ? agent.serverPort : null,
        opencodeSessionId: agent.opencodeSessionId || null,
        opencodeSessionTitle: agent.opencodeSessionTitle || null,
      },
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        // Carried deliberately: the prompt ledger keys on it, so dropping it
        // here makes every retry of a released task look like a duplicate of
        // the prompt that failed. A narrow projection is the right shape, but
        // it has to include the fields the caller actually decides with.
        attempt: Number(task.attempt) || 0,
      },
    };
  });
}

function releaseReservedTask(options, sessionId, taskId, reason) {
  runtimeStore.mutateCoordination(runtimeOptions(options), (state) => {
    const agent = (state.registry.agents || []).find((entry) => entry.sessionId === sessionId);
    const task = (state.tasksStore.tasks || []).find((entry) => entry.id === taskId);

    if (task && agent) {
      const reservedImplementation = task.claim && task.claim.agentName === agent.agentName && task.claim.role === agent.role;
      const reservedReview = task.reviewClaim && task.reviewClaim.agentName === agent.agentName && task.reviewClaim.role === agent.role;
      if (reservedImplementation) {
        task.status = 'TODO';
        task.claim = null;
        task.attentionType = null;
        coordinationCore.setWorkflowState(
          task,
          coordinationCore.normalizedTaskRole(task) === 'Project Manager' ? 'pm_planning' : 'implementation_queue',
          coordinationCore.normalizedTaskRole(task),
          null
        );
      } else if (reservedReview) {
        task.reviewClaim = null;
        task.attentionType = 'senior_closure';
        coordinationCore.setWorkflowState(task, 'senior_review', 'Senior Pro', null);
      }
      if (reservedImplementation || reservedReview) {
        if (!Array.isArray(task.notes)) task.notes = [];
        task.notes.push({
          kind: 'dispatch-failed',
          text: reason,
          createdAt: utcNow(),
        });
      }
    }

    if (agent) {
      agent.status = 'attention';
      agent.activeTaskId = null;
      agent.attentionRequired = true;
      agent.operationalStatus = 'error';
      agent.operationalError = `Prompt delivery failed: ${reason}`;
      agent.note = `Prompt delivery failed: ${reason}`;
      agent.lastSeenAt = utcNow();
    }

    state.tasksStore.updatedAt = utcNow();
    state.registry.updatedAt = utcNow();
  });
}

async function dispatchNextTask(options, sessionId, dependencies = {}) {
  const reserved = reserveTaskForSession(options, sessionId);
  const instruction = buildDispatchInstruction(reserved.agent, reserved.task);
  const dispatchedAt = utcNow();

  let delivery = null;
  try {
    delivery = await sendPrompt(reserved.agent, instruction, {
      runtimeOptions: runtimeOptions(options),
      command: 'dispatch',
      taskId: reserved.task.id,
      attempt: reserved.task.attempt || 0,
      ...dependencies,
    });
  } catch (error) {
    releaseReservedTask(options, reserved.agent.sessionId, reserved.task.id, error.message);
    throw error;
  }

  // A refused prompt does not throw, because hitting a cap is a normal outcome.
  // That makes it easy to sail past, which is exactly what happened: the task
  // stayed claimed and the agent was marked working, owning a task nobody had
  // told it about. Give the task back and report the refusal instead.
  if (delivery && delivery.delivered === false) {
    releaseReservedTask(
      options,
      reserved.agent.sessionId,
      reserved.task.id,
      `Prompt refused before delivery: ${delivery.refusedReason}.`
    );
    return {
      delivered: false,
      refusedReason: delivery.refusedReason,
      message: `${reserved.task.id} not dispatched to ${reserved.agent.agentName}: ${delivery.refusedReason}.`,
      agent: reserved.agent,
      task: reserved.task,
    };
  }

  runtimeStore.mutateCoordination(runtimeOptions(options), (state) => {
    const agent = (state.registry.agents || []).find((entry) => entry.sessionId === reserved.agent.sessionId);
    const task = (state.tasksStore.tasks || []).find((entry) => entry.id === reserved.task.id);
    if (!agent || !task) return;
    if (task.status === 'CLAIMED' && task.claim && task.claim.agentName === agent.agentName && task.claim.role === agent.role) {
      task.status = 'IN_PROGRESS';
    }
    agent.status = 'working';
    agent.activeTaskId = task.id;
    agent.note = 'Task dispatched to launched terminal';
    agent.lastPromptSentAt = dispatchedAt;
    agent.lastSeenAt = dispatchedAt;
    state.tasksStore.updatedAt = utcNow();
    state.registry.updatedAt = utcNow();
  });

  runtimeStore.upsertRun(runtimeOptions(options), {
    runId: `${reserved.agent.sessionId}-${reserved.task.id}-${Date.now()}`,
    agentSessionId: reserved.agent.sessionId,
    agentName: reserved.agent.agentName,
    role: reserved.agent.role,
    taskId: reserved.task.id,
    adapterType: 'interactive-terminal',
    command: 'dispatch',
    args: [],
    cwd: null,
    prompt: instruction,
    status: 'dispatched',
    startedAt: utcNow(),
    updatedAt: utcNow(),
    daemonPid: null,
    workerPid: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    finishedAt: utcNow(),
  });

  return {
    message: `${reserved.task.id} dispatched to ${reserved.agent.agentName}.`,
    agent: reserved.agent,
    task: reserved.task,
  };
}

function activeTaskReservation(options, sessionId) {
  return runtimeStore.mutateCoordination(runtimeOptions(options), (state) => {
    const agent = (state.registry.agents || []).find((entry) => entry.sessionId === sessionId);
    if (!agent) throw new Error(`Session ${sessionId} not found.`);
    if (!Number.isInteger(agent.terminalPid) || !runtimeReconcile.isPidAlive(agent.terminalPid)) {
      throw new Error(`${agent.agentName} does not have a live launched terminal.`);
    }
    if (!agent.activeTaskId) {
      throw new Error(`${agent.agentName} has no assigned task to continue.`);
    }
    if (agent.attentionRequired || agent.operationalStatus === 'error' || ['attention', 'blocked'].includes(agent.status)) {
      throw new Error(`${agent.agentName} cannot continue its task from status ${agent.status}.`);
    }

    const task = (state.tasksStore.tasks || []).find((entry) => entry.id === agent.activeTaskId);
    if (!task) throw new Error(`${agent.activeTaskId} not found.`);
    if (coordinationCore.currentWorkflowActorRole(task) !== agent.role) {
      throw new Error(`${agent.agentName} is not the current workflow actor for ${task.id}.`);
    }

    const ownsImplementation = task.claim && task.claim.agentName === agent.agentName && task.claim.role === agent.role;
    const ownsReview = task.reviewClaim && task.reviewClaim.agentName === agent.agentName && task.reviewClaim.role === agent.role;
    const workflowSessionMatches = task.workflow && task.workflow.currentActorSessionId === agent.sessionId;
    if (!ownsImplementation && !ownsReview && !workflowSessionMatches) {
      throw new Error(`${agent.agentName} does not own ${task.id}.`);
    }

    if (ownsReview && task.reviewClaim.sessionId !== agent.sessionId) {
      task.reviewClaim.sessionId = agent.sessionId;
    }
    if (task.workflow && task.workflow.currentActorSessionId !== agent.sessionId) {
      task.workflow.currentActorSessionId = agent.sessionId;
    }

    agent.status = 'assigned';
    agent.note = 'Assigned task ready to continue';
    agent.lastSeenAt = utcNow();
    state.tasksStore.updatedAt = utcNow();
    state.registry.updatedAt = utcNow();

    return {
      agent: {
        sessionId: agent.sessionId,
        agentName: agent.agentName,
        role: agent.role,
        adapterType: agent.adapterType || null,
        terminalPid: agent.terminalPid,
        workspacePath: agent.workspacePath || null,
        serverHost: agent.serverHost || null,
        serverPort: Number.isInteger(agent.serverPort) ? agent.serverPort : null,
        opencodeSessionId: agent.opencodeSessionId || null,
        opencodeSessionTitle: agent.opencodeSessionTitle || null,
      },
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        // Carried deliberately: the prompt ledger keys on it, so dropping it
        // here makes every retry of a released task look like a duplicate of
        // the prompt that failed. A narrow projection is the right shape, but
        // it has to include the fields the caller actually decides with.
        attempt: Number(task.attempt) || 0,
      },
    };
  });
}

async function continueActiveTask(options, sessionId) {
  const reserved = activeTaskReservation(options, sessionId);
  const instruction = buildDispatchInstruction(reserved.agent, reserved.task);
  const dispatchedAt = utcNow();

  const delivery = await sendPrompt(reserved.agent, instruction, {
    runtimeOptions: runtimeOptions(options),
    command: 'continue',
    taskId: reserved.task.id,
    attempt: reserved.task.attempt || 0,
  });

  // A refusal does not throw. Marking the agent as working after one would
  // claim a prompt was re-sent that never left.
  if (delivery && delivery.delivered === false) {
    return {
      delivered: false,
      refusedReason: delivery.refusedReason,
      message: `${reserved.task.id} not re-sent to ${reserved.agent.agentName}: ${delivery.refusedReason}.`,
      agent: reserved.agent,
      task: reserved.task,
    };
  }

  runtimeStore.mutateCoordination(runtimeOptions(options), (state) => {
    const agent = (state.registry.agents || []).find((entry) => entry.sessionId === reserved.agent.sessionId);
    if (!agent) return;
    agent.status = 'working';
    agent.activeTaskId = reserved.task.id;
    agent.note = 'Assigned task re-sent to launched terminal';
    agent.lastPromptSentAt = dispatchedAt;
    agent.lastSeenAt = dispatchedAt;
    state.registry.updatedAt = utcNow();
  });

  runtimeStore.upsertRun(runtimeOptions(options), {
    runId: `${reserved.agent.sessionId}-${reserved.task.id}-continue-${Date.now()}`,
    agentSessionId: reserved.agent.sessionId,
    agentName: reserved.agent.agentName,
    role: reserved.agent.role,
    taskId: reserved.task.id,
    adapterType: 'interactive-terminal',
    command: 'continue',
    args: [],
    cwd: null,
    prompt: instruction,
    status: 'dispatched',
    startedAt: utcNow(),
    updatedAt: utcNow(),
    daemonPid: null,
    workerPid: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    finishedAt: utcNow(),
  });

  return {
    message: `${reserved.task.id} re-sent to ${reserved.agent.agentName}.`,
    agent: reserved.agent,
    task: reserved.task,
  };
}

async function reviveBlockedTask(options, taskId, agentSessionId = null) {
  const runtimeOpts = runtimeOptions(options);

  const reserved = runtimeStore.mutateCoordination(runtimeOpts, (state) => {
    const task = (state.tasksStore.tasks || []).find((entry) => entry.id === taskId);
    if (!task) throw new Error(`${taskId} not found.`);
    if (task.status !== 'BLOCKED') throw new Error(`${taskId} is not BLOCKED.`);

    const hasSessionLost = Array.isArray(task.notes) && task.notes.some((note) => (
      note
      && note.kind === 'daemon-reconcile'
      && typeof note.text === 'string'
      && note.text.includes('lost its terminal')
    ));
    if (!hasSessionLost) {
      throw new Error(`${taskId} is blocked for another reason. Revive only supports session-lost tasks.`);
    }

    let agent = null;
    if (agentSessionId) {
      agent = (state.registry.agents || []).find((entry) => entry.sessionId === agentSessionId);
      if (!agent) throw new Error(`Session ${agentSessionId} not found.`);
    } else if (task.claim) {
      agent = (state.registry.agents || []).find((entry) => (
        entry.agentName === task.claim.agentName
        && entry.role === task.claim.role
        && Number.isInteger(entry.terminalPid)
        && runtimeReconcile.isPidAlive(entry.terminalPid)
        && !entry.activeTaskId
      ));
    }

    if (!agent) {
      throw new Error(`No live launched session is available to revive ${taskId}. Launch the preset first or use the Revive action.`);
    }
    if (!Number.isInteger(agent.terminalPid) || !runtimeReconcile.isPidAlive(agent.terminalPid)) {
      throw new Error(`${agent.agentName} does not have a live launched terminal.`);
    }
    if (agent.activeTaskId || agent.attentionRequired || agent.operationalStatus === 'error' || ['attention', 'assigned', 'working', 'blocked'].includes(agent.status)) {
      throw new Error(`${agent.agentName} is not idle.`);
    }

    task.status = 'IN_PROGRESS';
    task.attentionType = null;
    task.claim = {
      agentName: agent.agentName,
      role: agent.role,
      claimedAt: utcNow(),
    };
    if (!Array.isArray(task.notes)) task.notes = [];
    task.notes.push({
      kind: 'task-revived',
      text: `${taskId} revived after session loss.`,
      createdAt: utcNow(),
      agentName: agent.agentName,
      role: agent.role,
      sessionId: agent.sessionId,
    });

    agent.status = 'working';
    agent.activeTaskId = task.id;
    agent.note = 'Revived blocked task after session loss';
    agent.lastSeenAt = utcNow();

    state.tasksStore.updatedAt = utcNow();
    state.registry.updatedAt = utcNow();

    return {
      agent: {
        sessionId: agent.sessionId,
        agentName: agent.agentName,
        role: agent.role,
        adapterType: agent.adapterType || null,
        terminalPid: agent.terminalPid,
        serverHost: agent.serverHost || null,
        serverPort: Number.isInteger(agent.serverPort) ? agent.serverPort : null,
      },
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        // Carried deliberately: the prompt ledger keys on it, so dropping it
        // here makes every retry of a released task look like a duplicate of
        // the prompt that failed. A narrow projection is the right shape, but
        // it has to include the fields the caller actually decides with.
        attempt: Number(task.attempt) || 0,
      },
    };
  });

  const instruction = buildResumeInstruction(reserved.agent, reserved.task);
  const dispatchedAt = utcNow();

  try {
    const delivery = await sendPrompt(reserved.agent, instruction, {
      runtimeOptions: runtimeOpts,
      command: 'revive',
      taskId,
    });
    if (delivery && delivery.delivered === false) {
      throw new Error(`prompt refused: ${delivery.refusedReason}`);
    }
  } catch (error) {
    const warning = `Revived task assigned, but prompt auto-send failed. Continue manually in the launched terminal. ${error.message}`;
    runtimeStore.mutateCoordination(runtimeOpts, (state) => {
      const task = (state.tasksStore.tasks || []).find((entry) => entry.id === taskId);
      const agent = (state.registry.agents || []).find((entry) => entry.sessionId === reserved.agent.sessionId);
      if (task) {
        task.status = 'IN_PROGRESS';
        task.attentionType = null;
        task.claim = {
          agentName: reserved.agent.agentName,
          role: reserved.agent.role,
          claimedAt: utcNow(),
        };
        if (!Array.isArray(task.notes)) task.notes = [];
        task.notes.push({
          kind: 'revive-warning',
          text: warning,
          createdAt: utcNow(),
        });
      }
      if (agent) {
        agent.status = 'working';
        agent.activeTaskId = taskId;
        agent.note = 'Revived task assigned. Continue manually in this terminal.';
        agent.lastSeenAt = utcNow();
      }
      state.tasksStore.updatedAt = utcNow();
      state.registry.updatedAt = utcNow();
    });

    return {
      message: `${reserved.task.id} revived on ${reserved.agent.agentName}. Prompt auto-send failed; continue manually in the launched terminal.`,
      warning,
      agent: reserved.agent,
      task: reserved.task,
    };
  }

  runtimeStore.mutateCoordination(runtimeOpts, (state) => {
    const agent = (state.registry.agents || []).find((entry) => entry.sessionId === reserved.agent.sessionId);
    const task = (state.tasksStore.tasks || []).find((entry) => entry.id === reserved.task.id);
    if (!agent || !task) return;
    if (task.status === 'CLAIMED' && task.claim && task.claim.agentName === agent.agentName && task.claim.role === agent.role) {
      task.status = 'IN_PROGRESS';
    }
    agent.status = 'working';
    agent.activeTaskId = task.id;
    agent.note = 'Task dispatched to launched terminal';
    agent.lastPromptSentAt = dispatchedAt;
    agent.lastSeenAt = dispatchedAt;
    state.tasksStore.updatedAt = utcNow();
    state.registry.updatedAt = utcNow();
  });

  runtimeStore.upsertRun(runtimeOpts, {
    runId: `${reserved.agent.sessionId}-${reserved.task.id}-revive-${Date.now()}`,
    agentSessionId: reserved.agent.sessionId,
    agentName: reserved.agent.agentName,
    role: reserved.agent.role,
    taskId: reserved.task.id,
    adapterType: 'interactive-terminal',
    command: 'revive',
    args: [],
    cwd: null,
    prompt: instruction,
    status: 'dispatched',
    startedAt: utcNow(),
    updatedAt: utcNow(),
    daemonPid: null,
    workerPid: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    finishedAt: utcNow(),
  });

  return {
    message: `${reserved.task.id} revived on ${reserved.agent.agentName}.`,
    agent: reserved.agent,
    task: reserved.task,
  };
}

module.exports = {
  createSessionId,
  chooseTaskForRole,
  buildSessionIdentityInstruction,
  buildDispatchInstruction,
  buildResumeInstruction,
  activateAgentTerminal,
  resolveAgentTerminalWindow,
  sendPrompt,
  sendPromptToOpencode,
  dispatchNextTask,
  continueActiveTask,
  reviveBlockedTask,
};
