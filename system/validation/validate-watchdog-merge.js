'use strict';

// Step 4, fifth slice: one definition of "this session is not usable".
//
// The watchdog derived its own staleness from message timestamps
// (deriveExecutionActivityState, a 5 minute window) while the state machine
// derived the same conclusion from OpenCode's events. Two mechanisms deciding
// the same thing diverge: one marks stalled, the other does not, and the
// dashboard shows one thing while the scheduler believes another. With the
// scheduler about to read the state machine, that divergence would decide task
// ownership.
//
// After the merge the watchdog consumes the state and keeps what is actually
// its job: releasing the assignment.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtimeStore = require('../runtime/runtime-store');
const activityWatchdog = require('../opencode/activity-watchdog');
const coordinationCore = require('../runtime/coordination-core');

function tempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-watchdog-'));
  runtimeStore.ensureInitialized({ projectRoot });
  return projectRoot;
}

function seed(options, { agent = {}, task = {} } = {}) {
  runtimeStore.mutateCoordination(options, (state) => {
    state.registry.agents = [{
      sessionId: 'pixel-circuit-ss-1',
      agentName: 'Pixel Circuit',
      role: 'Semi Senior',
      adapterType: 'opencode',
      opencodeSessionId: 'ses_1',
      status: 'working',
      activeTaskId: 'NEXT-017',
      terminalPid: process.pid,
      serverHost: '127.0.0.1',
      serverPort: 43102,
      attentionRequired: false,
      ...agent,
    }];
    state.tasksStore.tasks = [{
      id: 'NEXT-017',
      type: 'task',
      section: 'active',
      status: 'IN_PROGRESS',
      title: 'A task',
      recommendedRole: 'Semi Senior',
      prerequisites: [],
      claim: { agentName: 'Pixel Circuit', role: 'Semi Senior' },
      reports: [],
      notes: [],
      children: [],
      workflow: { step: 'implementation', currentActorRole: 'Semi Senior', currentActorSessionId: 'pixel-circuit-ss-1' },
      ...task,
    }];
  });
}

// Must await: returning the promise from inside try/finally would delete the
// project out from under the test while it is still running.
async function withProject(run) {
  const projectRoot = tempProject();
  try {
    return await run({ projectRoot });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// The double read is gone: the watchdog no longer lists sessions or messages.
// The state machine already knows, and the sweep already reads the few sessions
// that need reading.
async function assertWatchdogPerformsNoOpencodeReads() {
  await withProject(async (options) => {
    seed(options);
    let reads = 0;
    const resolver = {
      listSessions: async () => { reads += 1; return []; },
      listMessages: async () => { reads += 1; return []; },
      findSessionByDashboardIdentity: async () => { reads += 1; return null; },
      extractMessageText: () => '',
    };

    await activityWatchdog.reconcileOpencodeActivity(options, {
      sessionStateFor: () => ({ state: 'thinking', lastEventAt: new Date().toISOString() }),
      resolver,
    });

    assert.equal(reads, 0, 'the watchdog must not read OpenCode; it consumes the state machine');
  });
}

// A working agent keeps its task. This is the case that must never regress.
async function assertWorkingAgentIsNeverReleased() {
  await withProject(async (options) => {
    seed(options);
    const result = await activityWatchdog.reconcileOpencodeActivity(options, {
      sessionStateFor: () => ({ state: 'streaming', lastEventAt: new Date().toISOString() }),
    });

    assert.equal(result.released, 0);
    const after = runtimeStore.readCoordinationState(options);
    assert.equal(after.registry.agents[0].activeTaskId, 'NEXT-017');
    assert.equal(after.tasksStore.tasks[0].status, 'IN_PROGRESS');
  });
}

// A rate limited session is not stalled: it is waiting to retry. Releasing its
// task would be the system fighting the runtime.
async function assertRateLimitedAgentIsNotReleased() {
  await withProject(async (options) => {
    seed(options);
    const result = await activityWatchdog.reconcileOpencodeActivity(options, {
      sessionStateFor: () => ({ state: 'rate_limited', lastEventAt: new Date(Date.now() - 3600000).toISOString() }),
    });
    assert.equal(result.released, 0);
    assert.equal(runtimeStore.readCoordinationState(options).registry.agents[0].activeTaskId, 'NEXT-017');
  });
}

// A session waiting on a user question keeps its task too: the work is not
// abandoned, it is blocked on us.
async function assertWaitingOnUserIsNotReleased() {
  await withProject(async (options) => {
    seed(options);
    const result = await activityWatchdog.reconcileOpencodeActivity(options, {
      sessionStateFor: () => ({ state: 'waiting_user', lastEventAt: new Date(Date.now() - 3600000).toISOString() }),
    });
    assert.equal(result.released, 0);
  });
}

// `unknown` after the sweep failed to resolve it is the real stall signal: the
// state machine gave up, and the read-only rescue already had its chance.
async function assertUnknownSessionIsMarkedThenReleased() {
  await withProject(async (options) => {
    seed(options);
    const stale = { state: 'unknown', lastEventAt: new Date(Date.now() - 3600000).toISOString() };

    const first = await activityWatchdog.reconcileOpencodeActivity(options, { sessionStateFor: () => stale });
    assert.equal(first.marked, 1, 'the first pass marks, it does not release');
    assert.equal(first.released, 0);
    assert.equal(runtimeStore.readCoordinationState(options).registry.agents[0].activeTaskId, 'NEXT-017');

    // Still unknown once the grace period has passed: give the task back.
    const second = await activityWatchdog.reconcileOpencodeActivity(options, {
      sessionStateFor: () => stale,
      now: Date.now() + 10 * 60 * 1000,
    });
    assert.equal(second.released, 1);

    const after = runtimeStore.readCoordinationState(options);
    assert.equal(after.registry.agents[0].activeTaskId, null);
    assert.equal(after.tasksStore.tasks[0].status, 'TODO');
    assert.equal(after.tasksStore.tasks[0].claim, null);
    assert.ok(after.tasksStore.tasks[0].notes.some((note) => note.kind === 'watchdog-release'));
  });
}

// Recovering before the grace period expires cancels the release entirely.
async function assertRecoveryClearsTheMark() {
  await withProject(async (options) => {
    seed(options);
    const stale = { state: 'unknown', lastEventAt: new Date(Date.now() - 3600000).toISOString() };
    await activityWatchdog.reconcileOpencodeActivity(options, { sessionStateFor: () => stale });

    const recovered = await activityWatchdog.reconcileOpencodeActivity(options, {
      sessionStateFor: () => ({ state: 'streaming', lastEventAt: new Date().toISOString() }),
      now: Date.now() + 10 * 60 * 1000,
    });

    assert.equal(recovered.released, 0, 'an agent that came back must keep its task');
    const after = runtimeStore.readCoordinationState(options);
    assert.equal(after.registry.agents[0].activeTaskId, 'NEXT-017');
    assert.equal(after.registry.agents[0].stalledSinceAt, null, 'the stall mark must be cleared on recovery');
  });
}

// The other half of that merge, which was left unfinished: the view kept its
// own timestamp heuristic (deriveExecutionActivityState, a 5 minute window) and
// called it from visibleAgentStatus. So the screen said STALLED while the
// registry said working -- observed live on Copper Circuit. Two definitions of
// stalled, and the one the user can see is the one that cannot act.
//
// The view must render the verdict, not compute a second one.
function assertViewRendersTheWatchdogVerdict() {
  assert.equal(
    typeof coordinationCore.deriveExecutionActivityState,
    'undefined',
    'the view must not export a second definition of stalled'
  );

  const registry = {
    agents: [{
      sessionId: 'a-1',
      agentName: 'Copper Circuit',
      role: 'Semi Senior',
      status: 'working',
      activeTaskId: 'NEXT-017',
      terminalPid: process.pid,
      // Silent for an hour. Under the old heuristic this alone said "stalled".
      lastActivityAt: new Date(Date.now() - 3600000).toISOString(),
      lastPromptSentAt: new Date(Date.now() - 3600000).toISOString(),
      activityState: 'working',
    }],
  };
  const tasksStore = {
    tasks: [{
      id: 'NEXT-017',
      type: 'task',
      section: 'active',
      status: 'IN_PROGRESS',
      title: 'A task',
      recommendedRole: 'Semi Senior',
      prerequisites: [],
      claim: { agentName: 'Copper Circuit', role: 'Semi Senior' },
      reports: [],
      notes: [],
      children: [],
      workflow: { step: 'implementation', currentActorRole: 'Semi Senior', currentActorSessionId: 'a-1' },
    }],
  };

  const working = coordinationCore.deriveDashboardState(tasksStore, registry).agents[0];
  assert.equal(working.status, 'working', 'an old timestamp must not override the runtime verdict');

  registry.agents[0].activityState = 'stalled';
  const stalled = coordinationCore.deriveDashboardState(tasksStore, registry).agents[0];
  assert.equal(stalled.status, 'stalled', 'and the verdict is what the screen shows');

  // No verdict yet is its own honest answer, not an invented one.
  registry.agents[0].activityState = null;
  const unverified = coordinationCore.deriveDashboardState(tasksStore, registry).agents[0];
  assert.equal(unverified.status, 'assigned', 'with no verdict the agent is assigned, not stalled');
}

async function main() {
  assertViewRendersTheWatchdogVerdict();
  await assertWatchdogPerformsNoOpencodeReads();
  await assertWorkingAgentIsNeverReleased();
  await assertRateLimitedAgentIsNotReleased();
  await assertWaitingOnUserIsNotReleased();
  await assertUnknownSessionIsMarkedThenReleased();
  await assertRecoveryClearsTheMark();

  console.log('Watchdog merge validation passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
