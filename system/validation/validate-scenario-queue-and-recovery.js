'use strict';

// The seams the first scenario suite left uncovered, now that the fake exists.
//
// Three paths where a failure would be invisible or would look like something
// else:
//
// - The Project Manager queue. This is the path a user's own request takes, and
//   the one place a refusal was once recorded as "sent", so the request vanished
//   with no explanation.
// - The watchdog releasing an assignment. It runs in the other suite but nothing
//   ever forced it to actually hand a task back.
// - applyOpencodeFacts, the single mapping layer between OpenCode's facts and
//   the dashboard's view model, which had no test at all.
//
// Same rule as the other scenario suite: one fake at the HTTP boundary, real
// wiring inboard. The stall windows come from runtime-policy, which is policy
// rather than a test knob -- the same distinction that made the prompt caps
// reachable in the first place.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeOpencodeServer } = require('./fake-opencode-server');
const { configureProjectWorkspace } = require('../core/project-workspace');
const runtimeStore = require('../runtime/runtime-store');
const runtimePolicy = require('../runtime/runtime-policy');
const dashboardServer = require('../dashboard/server');
const agentDaemon = require('../daemon/agent-daemon');

const PM_SESSION = 'blue-hammer-pm-1';
const PM_NAME = 'Blue Hammer';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick(times = 1) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await dashboardServer.advanceWorld();
    // eslint-disable-next-line no-await-in-loop
    await sleep(120);
  }
}

async function withScene(run, sceneOptions = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-queue-'));
  const fake = await createFakeOpencodeServer();
  runtimePolicy.resetPolicy();
  if (sceneOptions.policy) runtimePolicy.setPolicy(sceneOptions.policy);

  try {
    configureProjectWorkspace(projectRoot);
    runtimeStore.ensureInitialized({ projectRoot });
    runtimeStore.mutateCoordination({ projectRoot }, (state) => {
      state.registry.agents = [{
        sessionId: PM_SESSION,
        agentName: PM_NAME,
        role: 'Project Manager',
        adapterType: 'opencode',
        executionMode: 'manual',
        disabled: false,
        status: 'available',
        activeTaskId: null,
        terminalPid: process.pid,
        serverHost: '127.0.0.1',
        serverPort: fake.port,
        opencodeSessionId: fake.sessionId,
        workspacePath: projectRoot,
      }];
      state.tasksStore.tasks = sceneOptions.tasks || [];
    });

    await run({ projectRoot, fake, options: { projectRoot } });
  } finally {
    runtimePolicy.resetPolicy();
    dashboardServer.disposeOpencodeRuntime();
    await fake.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// A user submits a request and the office delivers it to the Project Manager.
async function assertAQueuedUserRequestReachesTheProjectManager() {
  await withScene(async ({ options, fake }) => {
    await tick(2);
    fake.emit('session.status', { status: { type: 'idle' } });
    await tick(2);

    dashboardServer.queueProjectManagerTaskRequest({ text: 'Build a squirrel game with three levels.' });
    await tick(3);

    assert.equal(fake.appends().length, 1, 'the user request never reached the Project Manager');
    assert.match(fake.appends()[0].text, /squirrel game/);

    const queue = runtimeStore.readCoordinationState(options).userTaskQueue;
    const record = queue.inFlight || (queue.history || [])[0];
    assert.ok(record, 'the request left no trace in the queue');
    assert.notEqual(record.status, 'failed', `the request failed: ${record.error}`);

    const ledger = runtimeStore.readPromptLedger(options);
    assert.equal(ledger.length, 1, 'the delivered request left no ledger row');
    assert.equal(ledger[0].agentSessionId, PM_SESSION);
  });
}

// The path where a refusal was once reported as sent. A capped request must be
// recorded as failed with its reason, and the Project Manager must not be
// branded broken for a budget decision.
async function assertACappedUserRequestIsRecordedAsFailedNotSent() {
  await withScene(async ({ options, fake }) => {
    await tick(2);
    fake.emit('session.status', { status: { type: 'idle' } });
    await tick(2);

    // Session budget already spent, so the reservation refuses.
    const spent = runtimeStore.reservePrompt(options, {
      agentSessionId: PM_SESSION,
      taskId: null,
      command: 'message',
      promptHash: 'already-spent',
    });
    runtimeStore.recordPromptOutcome(options, spent.entry.idempotencyKey, 'completed', { cost: 5 });
    runtimePolicy.setPolicy({ maxSessionCost: 1 });

    dashboardServer.queueProjectManagerTaskRequest({ text: 'Another request that must not vanish.' });
    await tick(3);

    assert.equal(fake.appends().length, 0, 'a capped request reached the agent anyway');

    const state = runtimeStore.readCoordinationState(options);
    const failed = (state.userTaskQueue.history || [])[0];
    assert.ok(failed, 'the refused request vanished instead of being recorded');
    assert.equal(failed.status, 'failed');
    assert.match(String(failed.error), /refus/i, `the reason is not readable: ${failed.error}`);

    const pm = state.registry.agents[0];
    assert.notEqual(pm.operationalStatus, 'error',
      'a budget decision branded the Project Manager as broken');
  });
}

// The watchdog handing a task back, driven all the way from a lost stream.
async function assertTheWatchdogReleasesAnAbandonedAssignment() {
  const task = {
    id: 'NEXT-200',
    type: 'task',
    section: 'active',
    status: 'IN_PROGRESS',
    title: 'Work that gets abandoned',
    recommendedRole: 'Project Manager',
    priority: 'High',
    prerequisites: [],
    claim: { agentName: PM_NAME, role: 'Project Manager' },
    reports: [],
    notes: [],
    children: [],
    workflow: { step: 'pm_planning', currentActorRole: 'Project Manager', currentActorSessionId: PM_SESSION },
  };

  await withScene(async ({ options, fake }) => {
    runtimeStore.mutateCoordination(options, (state) => {
      state.registry.agents[0].activeTaskId = 'NEXT-200';
      state.registry.agents[0].status = 'working';
    });

    await tick(2);
    fake.emit('session.status', { status: { type: 'busy' } });
    await tick(2);

    // The session dies mid-task and never comes back.
    fake.dropStreams();
    await tick(3);
    assert.equal(
      runtimeStore.readCoordinationState(options).registry.agents[0].runtimeState,
      'unknown',
      'losing the stream did not make the state unknown'
    );

    // Still inside the grace period: marked, not released.
    assert.equal(
      runtimeStore.readCoordinationState(options).registry.agents[0].activeTaskId,
      'NEXT-200',
      'the task was released before the grace period expired'
    );

    // Policy, not a test knob: no grace at all.
    runtimePolicy.setPolicy({ releaseGraceMs: 0 });
    await tick(2);

    const after = runtimeStore.readCoordinationState(options);
    assert.equal(after.registry.agents[0].activeTaskId, null, 'the abandoned task was never handed back');
    assert.equal(after.tasksStore.tasks[0].status, 'TODO');
    assert.ok(
      (after.tasksStore.tasks[0].notes || []).some((note) => note.kind === 'watchdog-release'),
      'the release left no explanation on the task'
    );
  }, { tasks: [task], policy: { staleAfterMs: 200 } });
}

// The retry loop, and whether it is bounded.
//
// Releasing a task after a dropped turn creates a cycle the system did not have
// before: release -> re-dispatch -> drop -> release. Each pass advances the
// task's attempt, which by design gives it a fresh ledger key, so the duplicate
// rule that stops every other repeat cannot stop this one. That is worth a test
// on its own terms: the incident this whole refactor came from was a retry loop
// that put fourteen prompts on one task, and this is a retry mechanism added
// back into the same system by a different door.
//
// What is supposed to bound it is maxPromptsPerTask, which counts ledger rows
// per task_id and therefore counts attempts. The end state is the right one:
// the agent goes to `attention`, which both the daemon's scheduler and the
// watchdog's inspection exclude, so the office stops and asks a human instead
// of burning quota forever.
//
// Driven through the real daemon, the real dispatcher and the real ledger, with
// the cap at its shipped default so what is proved bounded is what actually
// ships.
async function assertRepeatedDroppedTurnsStopAtTheCap() {
  const CAP = runtimePolicy.getPolicy().maxPromptsPerTask;
  const TASK_ID = 'NEXT-300';

  const task = {
    id: TASK_ID,
    type: 'task',
    section: 'active',
    status: 'TODO',
    title: 'Work whose turns keep getting dropped',
    recommendedRole: 'Semi Senior',
    priority: 'High',
    prerequisites: [],
    claim: null,
    reports: [],
    notes: [],
    children: [],
    workflow: { step: 'implementation_queue', currentActorRole: 'Semi Senior', currentActorSessionId: null },
  };

  await withScene(async ({ projectRoot, options, fake }) => {
    const daemonOptions = { workspacePath: projectRoot };

    // An implementer rather than the scene's default Project Manager: PM
    // planning work is claimed through its own path, and what is under test
    // here is the ordinary dispatch loop.
    runtimeStore.mutateCoordination(options, (state) => {
      state.registry.agents[0].role = 'Semi Senior';
      state.registry.agents[0].roleAcronym = 'SS';
    });

    // A turn the provider let go of, in the shape captured from the live
    // session: completed, no finish reason, nothing spent.
    const dropTheTurn = () => {
      fake.emit('message.updated', {
        info: {
          id: `msg_dropped_${Math.random().toString(36).slice(2, 10)}`,
          sessionID: fake.sessionId,
          role: 'assistant',
          time: { created: Date.now() - 1000, completed: Date.now() },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: 'unknown',
        },
      });
      fake.emit('session.idle', {});
    };

    await tick(2);

    let dispatches = 0;
    let refused = null;

    // Generously more rounds than the cap allows. If the loop is unbounded this
    // runs them all and the assertions below fail on the counts; the bound is
    // what has to stop it, not the range of this loop.
    for (let round = 0; round < CAP + 5; round += 1) {
      fake.emit('session.status', { status: { type: 'idle' } });
      // eslint-disable-next-line no-await-in-loop
      await tick(1);

      // eslint-disable-next-line no-await-in-loop
      const result = await agentDaemon.runOnce(daemonOptions);
      if (result.launches.length > 0) {
        dispatches += 1;
        dropTheTurn();
        // eslint-disable-next-line no-await-in-loop
        await tick(2);
        continue;
      }

      const skipped = (result.skipped || []).map((entry) => entry.message).join('; ');
      if (/task-prompt-cap/.test(skipped)) refused = skipped;
      if (refused) break;
      // eslint-disable-next-line no-await-in-loop
      await tick(1);
    }

    assert.ok(refused, `the retry loop never hit the cap after ${dispatches} dispatches`);
    assert.equal(dispatches, CAP, `expected exactly ${CAP} dispatches before the cap, got ${dispatches}`);

    // The cap counts attempts, which is the property the attempt key could have
    // broken: a fresh key per attempt must still land in the same task's budget.
    const ledger = runtimeStore.readPromptLedger(options, { taskId: TASK_ID });
    assert.equal(ledger.length, CAP, 'a refused reservation left a row behind, or attempts escaped the budget');
    assert.equal(new Set(ledger.map((row) => row.idempotencyKey)).size, CAP, 'attempts must not collide');
    assert.equal(fake.appends().length, CAP, 'a prompt reached the agent after the cap refused it');

    // And the office stops in the state that asks a human, rather than idling
    // in a way something else might pick up and start the cycle again.
    const after = runtimeStore.readCoordinationState(options);
    const agent = after.registry.agents[0];
    assert.equal(agent.status, 'attention', 'the capped agent must end up asking for a human');
    assert.equal(agent.attentionRequired, true);
    assert.equal(agent.activeTaskId, null, 'a capped agent must not keep holding the task');
    assert.match(String(agent.note || ''), /task-prompt-cap/, 'the reason must survive to the user');
    assert.equal(after.tasksStore.tasks[0].status, 'TODO');

    // The watchdog must not restart the cycle: an agent in attention is outside
    // what it inspects, so it cannot mark or release its way back into it.
    await tick(3);
    const settled = runtimeStore.readCoordinationState(options);
    assert.equal(settled.registry.agents[0].status, 'attention', 'the watchdog restarted a capped agent');
    assert.equal(
      runtimeStore.readPromptLedger(options, { taskId: TASK_ID }).length,
      CAP,
      'something kept spending after the cap'
    );
  }, { tasks: [task], policy: { staleAfterMs: 200, releaseGraceMs: 0 } });
}

// The mapping layer between OpenCode's facts and the dashboard's view model,
// exercised through the real buildView rather than called directly.
async function assertTheViewReflectsWhatOpencodeReports() {
  await withScene(async ({ fake }) => {
    await tick(2);
    fake.emit('session.status', { status: { type: 'busy' } });
    await tick(2);

    const working = dashboardServer.buildView().agents.find((agent) => agent.sessionId === PM_SESSION);
    assert.ok(working, 'the agent disappeared from the view');
    assert.equal(working.runtimeState, 'thinking', 'the view does not show the runtime verdict');
    assert.equal(working.operationalStatus, 'ok');

    // A pending question is the attention path that actually fires today.
    fake.setQuestions([{ questions: [{ question: 'Which database should I use?' }] }]);
    await tick(2);

    const view = dashboardServer.buildView();
    const waiting = view.agents.find((agent) => agent.sessionId === PM_SESSION);
    assert.equal(waiting.attentionRequired, true, 'a pending question did not raise attention');
    assert.equal(waiting.pendingQuestions, 1);
    assert.match(String(waiting.note), /database/i, 'the question text never reached the view');
    assert.ok(
      (view.alerts || []).some((alert) => /attention pending/i.test(alert)),
      'no alert was composed for a waiting agent'
    );
  });
}

async function main() {
  await assertAQueuedUserRequestReachesTheProjectManager();
  await assertACappedUserRequestIsRecordedAsFailedNotSent();
  await assertTheWatchdogReleasesAnAbandonedAssignment();
  await assertRepeatedDroppedTurnsStopAtTheCap();
  await assertTheViewReflectsWhatOpencodeReports();

  console.log('Queue and recovery scenario validation passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
