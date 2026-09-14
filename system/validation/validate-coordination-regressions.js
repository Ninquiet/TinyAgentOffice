'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createWorldTick } = require('../runtime/world-tick');
const runtimeReconcile = require('../runtime/runtime-reconcile');
const daemonFleet = require('../daemon/daemon-fleet');
const registerDaemonAgent = require('../daemon/register-daemon-agent');
const { APP_ROOT } = require('../core/project-workspace');
const coordinationCore = require('../runtime/coordination-core');
const runtimeStore = require('../runtime/runtime-store');
const { createMemoryPromptLedger } = require('../runtime/memory-prompt-ledger');
const coordinationTelemetry = require('../runtime/coordination-telemetry');
const sessionDispatch = require('../dispatch/session-dispatch');
const dashboardServer = require('../dashboard/server');
const agentDaemon = require('../daemon/agent-daemon');

function task(overrides) {
  return {
    id: 'TASK-001',
    type: 'task',
    section: 'active',
    status: 'REVIEW_NEEDED',
    title: 'Parent task',
    recommendedRole: 'Project Manager',
    priority: 'High',
    prerequisites: [],
    claim: null,
    reviewClaim: null,
    reports: [],
    notes: [],
    children: ['TASK-001.1'],
    workflow: {
      step: 'senior_review',
      currentActorRole: 'Senior Pro',
      currentActorSessionId: null,
    },
    ...overrides,
  };
}

function subtask(overrides = {}) {
  return {
    id: 'TASK-001.1',
    parentId: 'TASK-001',
    type: 'subtask',
    section: 'active',
    status: 'DONE',
    title: 'Finished child',
    recommendedRole: 'Semi Senior',
    priority: 'High',
    prerequisites: [],
    claim: null,
    reports: [],
    notes: [],
    completedBy: 'Neon Hammer',
    completedAt: '2026-08-13T00:00:00.000Z',
    workflow: {
      step: 'user_review',
      currentActorRole: 'User',
      currentActorSessionId: null,
    },
    ...overrides,
  };
}

function storeWith(parentTask) {
  return {
    tasks: [parentTask, subtask()],
    nextTodo: [],
    history: [],
  };
}

function assertArchivedParentIsNotSeniorClaimable() {
  const parent = task({
    status: 'ARCHIVED',
    attentionType: null,
    workflow: {
      step: 'closed',
      currentActorRole: null,
      currentActorSessionId: null,
    },
  });
  const store = storeWith(parent);
  const result = coordinationCore.evaluateStructuredTask(parent, 'Senior Pro', store);
  assert.equal(result.claimable, false);
  assert.equal(coordinationCore.chooseAssignableTask(store, 'Senior Pro'), null);
}

function assertOnlyReviewNeededParentIsSeniorBatchReview() {
  const doneParent = task({
    status: 'DONE',
    attentionType: null,
    workflow: {
      step: 'user_review',
      currentActorRole: 'User',
      currentActorSessionId: null,
    },
  });
  const doneStore = storeWith(doneParent);
  assert.equal(coordinationCore.evaluateStructuredTask(doneParent, 'Senior Pro', doneStore).claimable, false);

  const reviewParent = task();
  const reviewStore = storeWith(reviewParent);
  const result = coordinationCore.evaluateStructuredTask(reviewParent, 'Senior Pro', reviewStore);
  assert.equal(result.claimable, true);
  assert.equal(result.isPmBatchReview, true);
}

function assertDispatchInstructionIncludesIdentityFlags() {
  const instruction = sessionDispatch.buildDispatchInstruction({
    agentName: 'Blue Socket',
    role: 'Senior Pro',
    sessionId: 'blue-socket-sp-test',
    workspacePath: 'C:\\Trabajo\\BlackBoxBird\\TestBook',
  }, task());

  assert.match(instruction, /--name "Blue Socket"/);
  assert.match(instruction, /--role "SP"/);
  assert.match(instruction, /--session-id "blue-socket-sp-test"/);
  assert.match(instruction, /--context-reviewed not-needed/);
}

function assertTelemetryDetectsDuplicateDispatch() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-telemetry-'));
  try {
    fs.mkdirSync(path.join(projectRoot, '.tiny-agent-office', 'coordination'), { recursive: true });
    const options = { projectRoot };
    runtimeStore.mutateCoordination(options, (state) => {
      state.tasksStore.tasks = [];
      state.registry.agents = [];
      state.runs = [
        {
          runId: 'run-1',
          agentSessionId: 'blue-socket-sp-test',
          agentName: 'Blue Socket',
          role: 'Senior Pro',
          taskId: 'TASK-001',
          command: 'dispatch',
          status: 'dispatched',
          startedAt: '2026-08-13T00:00:01.000Z',
          updatedAt: '2026-08-13T00:00:01.000Z',
        },
        {
          runId: 'run-2',
          agentSessionId: 'blue-socket-sp-test',
          agentName: 'Blue Socket',
          role: 'Senior Pro',
          taskId: 'TASK-001',
          command: 'dispatch',
          status: 'dispatched',
          startedAt: '2026-08-13T00:00:05.000Z',
          updatedAt: '2026-08-13T00:00:05.000Z',
        },
      ];
    });

    const telemetry = coordinationTelemetry.computeTelemetry(options);
    const senior = telemetry.roles.find((entry) => entry.role === 'Senior Pro');
    assert.equal(senior.dispatches, 2);
    assert.equal(senior.duplicateDispatches, 1);
    assert.equal(telemetry.anomalies.length, 1);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function assertDaemonDoesNotAutoContinueAssignedStalledAgent() {
  const agent = {
    sessionId: 'pixel-circuit-ss-test',
    agentName: 'Pixel Circuit',
    role: 'Semi Senior',
    executionMode: 'manual',
    disabled: false,
    terminalPid: process.pid,
    status: 'assigned',
    activeTaskId: 'NEXT-017',
    activityState: 'stalled',
    attentionRequired: false,
    operationalStatus: null,
  };

  assert.equal(agentDaemon.isSchedulableAgent(agent), false);
}

function assertProjectManagerPromptPreservesUserRequest() {
  const prompt = dashboardServer.buildProjectManagerTaskRequestPrompt({
    id: 'user-task-test',
    text: 'Crear juego de ardilla con tres niveles',
    attachments: [],
  });

  assert.match(prompt, /User request:\nCrear juego de ardilla con tres niveles/);
  assert.match(prompt, /--role is the recommended owner role for the new Todo item/);
}

async function assertOpencodeAcceptedPromptIsNotReappendedWhenVerificationFails() {
  const calls = [];
  const ledger = createMemoryPromptLedger();
  const fakeResolver = {
    listSessions: async () => [{ id: 'ses-test', title: 'Blue Hammer Test', directory: 'C:\\Trabajo\\BlackBoxBird\\TestApp2' }],
    findSessionByDashboardIdentity: async () => ({ id: 'ses-test', title: 'Blue Hammer Test' }),
    listMessages: async () => [],
    sessionMessageCheckpoint: () => ({ count: 0, lastMessageId: null }),
    indexSessionUpdates: () => new Map(),
    hasDeliveredPromptAfterCheckpoint: () => false,
    detectTouchedSession: () => null,
    getSession: async () => ({ id: 'ses-test', title: 'Blue Hammer Test' }),
    messagePayloadMatchesDashboardIdentity: () => false,
    extractMessageText: () => '',
  };

  const result = await sessionDispatch.sendPromptToOpencode({
    agentName: 'Blue Hammer',
    role: 'Project Manager',
    sessionId: 'blue-hammer-pm-test',
    adapterType: 'opencode',
    serverHost: '127.0.0.1',
    serverPort: 43102,
    opencodeSessionId: 'ses-test',
    opencodeSessionTitle: 'Blue Hammer Test',
  }, 'New task request.\n\nUser request:\nCrear juego de ardilla', {
    httpJsonRequest: async (_endpoint, method, pathName, body) => {
      calls.push({ method, pathName, body });
      return pathName === '/global/health' ? { healthy: true } : true;
    },
    sessionResolver: fakeResolver,
    sleep: async () => {},
    // These two cover transport behaviour only, so they use an in-memory
    // ledger rather than the store-backed one. There is no way to send without
    // a ledger at all, and there should not be.
    ledger,
  });

  assert.equal(calls.filter((call) => call.pathName === '/tui/append-prompt').length, 1);
  assert.equal(calls.filter((call) => call.pathName === '/tui/submit-prompt').length, 1);
  assert.equal(result.deliveryVerified, false);
  assert.match(result.deliveryWarning, /accepted the prompt request/);
  // Now that a ledger is always present, these can assert what was recorded.
  assert.deepEqual(ledger.transportSequence(), ['appended', 'submitted']);
  assert.deepEqual(ledger.outcomeSequence(), ['failed']);
}

async function assertOpencodeAcceptedPromptIsNotReappendedWhenVerificationThrows() {
  const calls = [];
  const ledger = createMemoryPromptLedger();
  let messageReads = 0;
  const fakeResolver = {
    listSessions: async () => [{ id: 'ses-test', title: 'Blue Hammer Test', directory: 'C:\\Trabajo\\BlackBoxBird\\TestApp2' }],
    findSessionByDashboardIdentity: async () => ({ id: 'ses-test', title: 'Blue Hammer Test' }),
    listMessages: async () => {
      messageReads += 1;
      if (messageReads > 1) throw new Error('transient session read failure');
      return [];
    },
    sessionMessageCheckpoint: () => ({ count: 0, lastMessageId: null }),
    indexSessionUpdates: () => new Map(),
    hasDeliveredPromptAfterCheckpoint: () => false,
    detectTouchedSession: () => null,
    getSession: async () => ({ id: 'ses-test', title: 'Blue Hammer Test' }),
    messagePayloadMatchesDashboardIdentity: () => false,
    extractMessageText: () => '',
  };

  const result = await sessionDispatch.sendPromptToOpencode({
    agentName: 'Blue Hammer',
    role: 'Project Manager',
    sessionId: 'blue-hammer-pm-test',
    adapterType: 'opencode',
    serverHost: '127.0.0.1',
    serverPort: 43102,
    opencodeSessionId: 'ses-test',
    opencodeSessionTitle: 'Blue Hammer Test',
  }, 'New task request.\n\nUser request:\nCrear juego de ardilla', {
    httpJsonRequest: async (_endpoint, method, pathName, body) => {
      calls.push({ method, pathName, body });
      return pathName === '/global/health' ? { healthy: true } : true;
    },
    sessionResolver: fakeResolver,
    sleep: async () => {},
    // These two cover transport behaviour only, so they use an in-memory
    // ledger rather than the store-backed one. There is no way to send without
    // a ledger at all, and there should not be.
    ledger,
  });

  assert.equal(calls.filter((call) => call.pathName === '/tui/append-prompt').length, 1);
  assert.equal(calls.filter((call) => call.pathName === '/tui/submit-prompt').length, 1);
  assert.equal(result.deliveryVerified, false);
  assert.match(result.deliveryWarning, /transient session read failure/);
  assert.deepEqual(ledger.transportSequence(), ['appended', 'submitted']);
  assert.deepEqual(ledger.outcomeSequence(), ['failed']);
}

// Finding 01: two world-tick passes must never overlap. The dashboard used to
// advance the world from both the socket timer and GET /api/dashboard-state with
// no mutual exclusion between them.
async function assertWorldTickDoesNotOverlap() {
  let started = 0;
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });

  const tick = createWorldTick({
    intervalMs: 10,
    advance: async () => {
      started += 1;
      await gate;
    },
  });

  const first = tick.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  const second = tick.runOnce();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(started, 1, 'a second pass started while the first was still running');
  assert.equal(second, first, 'overlapping callers must await the in-flight pass');
  assert.equal(tick.getStatus().coalesced, 1);

  release();
  await first;

  assert.equal(started, 1);
  assert.equal(tick.getStatus().runs, 1);
  assert.equal(tick.isRunning(), false);

  // A failing pass must not wedge the tick.
  const failing = createWorldTick({
    intervalMs: 10,
    advance: async () => { throw new Error('advance blew up'); },
  });
  await failing.runOnce();
  assert.equal(failing.getStatus().lastError, 'advance blew up');
  assert.equal(failing.isRunning(), false);
  await failing.runOnce();
  assert.equal(failing.getStatus().runs, 2);
}

// The world tick runs on a timer, so its process/window scan must be the async
// variant. spawnSync here holds the event loop for over a second per pass, which
// is what made every dashboard response wait behind it.
function assertWorldTickScansProcessesAsynchronously() {
  const liveSessionRecovery = require('../runtime/live-session-recovery');
  const terminalWindowHost = require('../platform/terminal-window-host');
  assert.equal(typeof liveSessionRecovery.detectLiveManualSessionsAsync, 'function');
  assert.equal(typeof terminalWindowHost.listWindowsAsync, 'function');

  const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'server.js'), 'utf8');
  assert.ok(
    /detectLiveManualSessionsAsync\(/.test(source),
    'the world tick must scan processes with detectLiveManualSessionsAsync'
  );
  assert.ok(
    !/detectLiveManualSessions\(/.test(source.replace(/detectLiveManualSessionsAsync\(/g, '')),
    'the dashboard must not call the blocking detectLiveManualSessions'
  );
}

// Every launched agent is told where the coordination CLI is. That path was
// built from a WORKSPACE_ROOT that resolved one level above the repository, so
// agents were handed a path that does not exist and could not confirm their
// registered identity or run any coordination command.
function assertLaunchIdentityPromptPointsAtTheRealCli() {
  const prompt = daemonFleet.buildLaunchIdentityPrompt({
    agentName: 'Blue Hammer',
    role: 'Project Manager',
    sessionId: 'blue-hammer-pm-test',
    workspacePath: APP_ROOT,
  }, { workspace: APP_ROOT });

  const match = prompt.match(/Use the coordination CLI at: (.+?\.js)\./);
  assert.ok(match, 'the launch prompt no longer names a coordination CLI path');
  const cliPath = match[1];
  assert.ok(
    fs.existsSync(cliPath),
    `the launch prompt points at a coordination CLI that does not exist: ${cliPath}`
  );
}

// The workspace an agent is registered with must be the project it works on.
// It defaulted to the directory *containing* every project, so an agent could be
// registered against the whole workspace tree.
function assertRegisteredWorkspaceIsTheProjectNotAnAncestor() {
  const registered = path.resolve(registerDaemonAgent.WORKSPACE_ROOT);
  assert.equal(
    registered,
    path.resolve(APP_ROOT),
    `daemon registration defaults to ${registered}, which is not the application root`
  );
  assert.notEqual(
    registered,
    path.dirname(path.resolve(APP_ROOT)),
    'daemon registration defaults to the directory that contains every project'
  );
}

// The class fix, not the seven patches. Modules under system/ live at varying
// depths, so each one that recomputed the root by counting `..` segments was an
// independent chance to get the count wrong -- and seven of them did, all
// landing one level above the repository. project-workspace.APP_ROOT is the one
// place that derives it.
function assertNoModuleDerivesItsOwnAppRoot() {
  const systemDir = path.resolve(__dirname, '..');
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.(js|cjs)$/.test(entry.name)) continue;
      if (full === path.resolve(systemDir, 'core', 'project-workspace.js')) continue;

      const source = fs.readFileSync(full, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (/__dirname\s*,\s*'\.\.'\s*,\s*'\.\.'\s*,\s*'\.\.'/.test(line)
          || /__dirname\s*,\s*'\.\.\/\.\.\/\.\.'/.test(line)) {
          offenders.push(`${path.relative(systemDir, full)}:${index + 1}`);
        }
      });
    }
  };

  walk(systemDir);
  assert.deepEqual(
    offenders,
    [],
    `these modules derive the application root themselves instead of importing APP_ROOT: ${offenders.join(', ')}`
  );
}

// sendPrompt used to fall back to driving the terminal through the clipboard
// and SendKeys for any non-OpenCode agent. It must refuse instead: OpenCode is
// the only supported runtime, and silently typing into whichever window happened
// to accept focus is not a delivery mechanism.
async function assertSendPromptRefusesNonOpencodeAgents() {
  await assert.rejects(
    async () => sessionDispatch.sendPrompt({
      agentName: 'Pixel Circuit',
      role: 'Semi Senior',
      sessionId: 'pixel-circuit-ss-test',
      adapterType: 'generic-shell',
      terminalPid: process.pid,
    }, 'Continue the task.'),
    /only supported runtime/
  );
}

// Seeding is a write. It used to happen lazily inside openDatabase, which the
// read path also goes through, so a plain read could write — and without the
// file lock, since readCoordinationState does not take it.
function assertReadsNeverSeedTheDatabase() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-seed-'));
  try {
    const options = { projectRoot };
    const paths = runtimeStore.resolvePaths(options);
    fs.mkdirSync(path.dirname(paths.tasksPath), { recursive: true });
    fs.writeFileSync(paths.tasksPath, JSON.stringify({
      schemaVersion: 1,
      tasks: [task({ id: 'SEED-001', title: 'Seeded from the JSON mirror' })],
      nextTodo: [],
      history: [],
    }), 'utf8');

    // A read must not import the mirror, and must not create the runs mirror.
    const beforeRead = runtimeStore.readCoordinationState(options);
    assert.equal(beforeRead.tasksStore.tasks.length, 0, 'a plain read seeded the database');
    assert.equal(fs.existsSync(paths.runsPath), false, 'a plain read wrote the runs mirror');

    // Reading again must be just as inert.
    runtimeStore.readCoordinationState(options);
    assert.equal(runtimeStore.readCoordinationState(options).tasksStore.tasks.length, 0);

    // The explicit call is what seeds, and it is idempotent.
    assert.equal(runtimeStore.ensureInitialized(options).seeded, true);
    assert.equal(runtimeStore.readCoordinationState(options).tasksStore.tasks[0].id, 'SEED-001');
    assert.equal(runtimeStore.ensureInitialized(options).seeded, false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// Every world-tick pass called reconcileCoordination, which took
// runtime.db.lock and rewrote all three JSON mirrors even when the
// reconciliation changed nothing. context.md lists that lock as an active risk.
function assertReconcileDoesNotWriteWhenNothingChanged() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-reconcile-'));
  try {
    const options = { projectRoot };
    runtimeStore.ensureInitialized(options);
    runtimeStore.mutateCoordination(options, (state) => {
      state.tasksStore.tasks = [];
      state.registry.agents = [];
    });

    // Settle first: the first pass is allowed to change things.
    runtimeReconcile.reconcileCoordination(options);

    const paths = runtimeStore.resolvePaths(options);
    const before = {
      tasks: fs.statSync(paths.tasksPath).mtimeMs,
      registry: fs.statSync(paths.registryPath).mtimeMs,
      db: fs.statSync(paths.dbPath).mtimeMs,
    };

    for (let i = 0; i < 3; i += 1) {
      assert.equal(runtimeReconcile.reconcileCoordination(options).changed, false);
    }

    assert.equal(fs.statSync(paths.tasksPath).mtimeMs, before.tasks, 'a no-op reconcile rewrote tasks.json');
    assert.equal(fs.statSync(paths.registryPath).mtimeMs, before.registry, 'a no-op reconcile rewrote the registry mirror');
    assert.equal(fs.statSync(paths.dbPath).mtimeMs, before.db, 'a no-op reconcile wrote to runtime.db');
    assert.equal(fs.existsSync(`${paths.dbPath}.lock`), false, 'the reconcile left the db lock behind');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// Runs in a child process on purpose. The guards have to be installed before the
// dashboard is required, because modules that do `const { spawn } = require(...)`
// at load time capture the original function and would slip past a guard
// installed later. Patching in-process only caught store writes and HTTP, which
// is how an unconditional daemon-fleet.json write survived the first version of
// this test.
const BUILD_VIEW_PURITY_PROBE = `'use strict';
const fs = require('fs');
const http = require('http');
const childProcess = require('child_process');
const path = require('path');

const appRoot = process.argv[2];
const projectRoot = process.argv[3];

const { configureProjectWorkspace } = require(path.join(appRoot, 'system', 'core', 'project-workspace'));
const runtimeStore = require(path.join(appRoot, 'system', 'runtime', 'runtime-store'));

// Deliberately does NOT call ensureInitialized: this leaves a database with a
// schema but no bootstrap marker, which is exactly the state that used to make
// a plain read seed and rewrite the JSON mirrors.
configureProjectWorkspace(projectRoot);
runtimeStore.mutateCoordination({ projectRoot }, (state) => {
  state.tasksStore.tasks = [];
  state.registry.agents = [
    {
      sessionId: 'blue-hammer-pm-view',
      agentName: 'Blue Hammer',
      role: 'Project Manager',
      adapterType: 'opencode',
      executionMode: 'manual',
      status: 'available',
      activeTaskId: null,
      terminalPid: process.pid,
      serverHost: '127.0.0.1',
      serverPort: 43102,
    },
  ];
});

function impure(what) {
  console.error('IMPURE: buildView ' + what);
  console.error(new Error('impure call site').stack);
  process.exit(2);
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => impure('spawned a child process via child_process.' + name);
}
for (const name of ['writeFileSync', 'appendFileSync', 'writeFile', 'appendFile', 'createWriteStream', 'unlinkSync', 'rmSync', 'renameSync', 'truncateSync']) {
  fs[name] = () => impure('wrote to disk via fs.' + name);
}
http.request = () => impure('called out over HTTP');
runtimeStore.mutateCoordination = () => impure('wrote to the coordination store');

const dashboardServer = require(path.join(appRoot, 'system', 'dashboard', 'server'));

const view = dashboardServer.buildView();
if (!Array.isArray(view.agents)) {
  console.error('buildView returned no agents array');
  process.exit(3);
}
if (!/tao-view-/.test(String(view.project && view.project.root))) {
  console.error('buildView reported the wrong project root: ' + (view.project && view.project.root));
  process.exit(4);
}
dashboardServer.buildView();
dashboardServer.buildView();
console.log('PURE');
`;

// Finding 01: the render path must be a pure read. No coordination writes, no
// OpenCode traffic, no disk writes, no child processes.
function assertBuildViewPerformsNoWritesOrOpencodeCalls() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-view-'));
  const appRoot = path.resolve(__dirname, '..', '..');
  const probePath = path.join(projectRoot, 'build-view-purity-probe.js');

  try {
    fs.writeFileSync(probePath, BUILD_VIEW_PURITY_PROBE, 'utf8');
    const result = spawnSync(process.execPath, [probePath, appRoot, projectRoot], {
      encoding: 'utf8',
      cwd: appRoot,
    });

    assert.equal(
      result.status,
      0,
      `buildView purity probe failed.\n${String(result.stderr || '').trim()}\n${String(result.stdout || '').trim()}`
    );
    assert.match(String(result.stdout || ''), /PURE/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

async function main() {
  assertArchivedParentIsNotSeniorClaimable();
  assertOnlyReviewNeededParentIsSeniorBatchReview();
  assertDispatchInstructionIncludesIdentityFlags();
  assertTelemetryDetectsDuplicateDispatch();
  assertDaemonDoesNotAutoContinueAssignedStalledAgent();
  assertProjectManagerPromptPreservesUserRequest();
  await assertOpencodeAcceptedPromptIsNotReappendedWhenVerificationFails();
  await assertOpencodeAcceptedPromptIsNotReappendedWhenVerificationThrows();
  await assertWorldTickDoesNotOverlap();
  assertWorldTickScansProcessesAsynchronously();
  assertLaunchIdentityPromptPointsAtTheRealCli();
  assertRegisteredWorkspaceIsTheProjectNotAnAncestor();
  assertNoModuleDerivesItsOwnAppRoot();
  await assertSendPromptRefusesNonOpencodeAgents();
  assertReadsNeverSeedTheDatabase();
  assertReconcileDoesNotWriteWhenNothingChanged();
  // Runs last: it repoints the active project workspace at a temp directory.
  assertBuildViewPerformsNoWritesOrOpencodeCalls();

  console.log('Coordination regression validation passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
