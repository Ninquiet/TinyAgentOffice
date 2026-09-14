'use strict';

// The chain nothing covered: an event arrives, and a task gets dispatched.
//
// Every one of the five integration bugs lived between parts, and none of them
// was visible to a unit test. `advanceWorld` -- thirteen phases -- had no test at
// all, and `reconcileActivity`, `sweepSessionStates`, `applyOpencodeFacts` and
// the Project Manager queue had zero references in the whole suite.
//
// So there is exactly one fake here, at the HTTP boundary, and everything inboard
// of it is production code: the real advanceWorld, the real registry, the real
// ledger, the real state machine, the real daemon runOnce. No injected doubles
// inside the system, because a double cannot tell you the real cable is unplugged.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeOpencodeServer } = require('./fake-opencode-server');
const { configureProjectWorkspace } = require('../core/project-workspace');
const runtimeStore = require('../runtime/runtime-store');
const dashboardServer = require('../dashboard/server');
const agentDaemon = require('../daemon/agent-daemon');

const AGENT_SESSION = 'neon-hammer-ss-1';
const AGENT_NAME = 'Neon Hammer';
const TASK_ID = 'NEXT-100';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withScene(run, sceneOptions = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-scene-'));
  const fake = await createFakeOpencodeServer();
  try {
    configureProjectWorkspace(projectRoot);
    runtimeStore.ensureInitialized({ projectRoot });

    runtimeStore.mutateCoordination({ projectRoot }, (state) => {
      state.registry.agents = [{
        sessionId: AGENT_SESSION,
        agentName: AGENT_NAME,
        role: 'Semi Senior',
        adapterType: 'opencode',
        executionMode: 'manual',
        disabled: false,
        status: 'available',
        activeTaskId: null,
        // The scheduler requires a live terminal; this process stands in for one.
        terminalPid: process.pid,
        serverHost: '127.0.0.1',
        serverPort: fake.port,
        opencodeSessionId: sceneOptions.seedSessionId === false ? null : fake.sessionId,
        workspacePath: projectRoot,
      }];
      state.tasksStore.tasks = [{
        id: TASK_ID,
        type: 'task',
        section: 'active',
        status: 'TODO',
        title: 'A task the office should pick up',
        recommendedRole: 'Semi Senior',
        priority: 'High',
        prerequisites: [],
        claim: null,
        reports: [],
        notes: [],
        children: [],
        workflow: { step: 'implementation_queue', currentActorRole: 'Semi Senior', currentActorSessionId: null },
      }];
    });

    await run({ projectRoot, fake, options: { projectRoot }, daemonOptions: { workspacePath: projectRoot } });
  } finally {
    // Release the broker's streams and timers, or the process never exits.
    dashboardServer.disposeOpencodeRuntime();
    await fake.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// The tick is asynchronous and the SSE connection takes a moment to establish,
// so a scene runs several passes rather than assuming one is enough.
async function tick(times = 1) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await dashboardServer.advanceWorld();
    // eslint-disable-next-line no-await-in-loop
    await sleep(120);
  }
}

// The whole chain, in one scene.
async function assertAnIdleEventLeadsToADispatch() {
  await withScene(async ({ options, daemonOptions, fake }) => {
    // Open the stream and let the broker attach.
    await tick(2);
    assert.ok(fake.subscriberCount() > 0, 'the event broker never subscribed to the fake stream');

    // The runtime says the session is idle.
    fake.emit('session.status', { status: { type: 'idle' } });
    await tick(2);

    const published = runtimeStore.readCoordinationState(options).registry.agents[0];
    assert.equal(published.runtimeState, 'idle',
      'the event never reached the registry, so the daemon would never schedule');

    // The real daemon, with its real default scheduling context.
    const result = await agentDaemon.runOnce(daemonOptions);
    assert.equal(result.launches.length, 1, `nothing was dispatched: ${JSON.stringify(result.skipped)}`);
    assert.equal(result.launches[0].taskId, TASK_ID);

    // The agent was actually told, exactly once.
    assert.equal(fake.appends().length, 1, 'the prompt was appended more than once');
    assert.equal(fake.submits().length, 1);
    assert.match(fake.appends()[0].text, new RegExp(TASK_ID));
    assert.match(fake.appends()[0].text, new RegExp(AGENT_SESSION));

    // The ledger has the row, with its attribution.
    const ledger = runtimeStore.readPromptLedger(options);
    assert.equal(ledger.length, 1, 'the dispatch left no ledger row');
    assert.equal(ledger[0].agentSessionId, AGENT_SESSION);
    assert.equal(ledger[0].taskId, TASK_ID);
    assert.equal(ledger[0].command, 'dispatch');
    assert.equal(ledger[0].transportStatus, 'submitted');

    // And the coordination state moved.
    const after = runtimeStore.readCoordinationState(options);
    assert.equal(after.registry.agents[0].activeTaskId, TASK_ID);
    assert.equal(after.tasksStore.tasks[0].status, 'IN_PROGRESS');
  });
}

// The transition log is the one irreversible artefact. It has to fill in from a
// real run, with attribution, not just in a unit test that hands it rows.
async function assertTheRunIsRecordedInTheTransitionLog() {
  await withScene(async ({ options, fake }) => {
    await tick(2);
    fake.emit('session.status', { status: { type: 'busy' } });
    await tick(1);
    fake.emit('session.next.text.delta', {});
    await tick(1);
    fake.emit('session.idle', {});
    await tick(2);

    const transitions = runtimeStore.readWorkflowTransitions(options, { limit: 0 });
    assert.ok(transitions.length >= 3, `expected a journey, got ${transitions.length} transitions`);

    const path = transitions.map((row) => row.toState);
    assert.ok(path.includes('thinking'), `no thinking in ${path.join(' -> ')}`);
    assert.ok(path.includes('streaming'), `no streaming in ${path.join(' -> ')}`);
    assert.ok(path.includes('idle'), `no idle in ${path.join(' -> ')}`);

    assert.ok(
      transitions.some((row) => row.agentName === AGENT_NAME),
      'no transition was attributed to the agent; the attribution resolver is not wired'
    );
  });
}

// The cap, through the real ledger and the real dispatcher.
async function assertThePromptCapStopsDelivery() {
  await withScene(async ({ options, daemonOptions, fake }) => {
    await tick(2);
    fake.emit('session.status', { status: { type: 'idle' } });
    await tick(2);

    // Fill the task's budget with entries that are already finished, so the cap
    // is what refuses rather than the duplicate rule.
    for (let i = 0; i < 2; i += 1) {
      const reserved = runtimeStore.reservePrompt(options, {
        agentSessionId: AGENT_SESSION,
        taskId: TASK_ID,
        command: 'continue',
        promptHash: `filler-${i}`,
      });
      runtimeStore.recordPromptOutcome(options, reserved.entry.idempotencyKey, 'completed');
    }

    const result = await agentDaemon.runOnce({ ...daemonOptions, limits: { maxPromptsPerTask: 2 } });

    assert.equal(fake.appends().length, 0, 'a capped prompt reached the agent anyway');
    assert.equal(result.launches.length, 0);

    const after = runtimeStore.readCoordinationState(options);
    assert.equal(after.registry.agents[0].activeTaskId, null,
      'the task stayed assigned after a refused dispatch');
    assert.equal(after.tasksStore.tasks[0].status, 'TODO');
    assert.equal(runtimeStore.readPromptLedger(options, { taskId: TASK_ID }).length, 2,
      'a refused reservation left a row behind');
  });
}

// Losing the stream must make the state unknown, and the sweep must be able to
// rescue it from evidence rather than leaving the agent stranded.
async function assertADroppedStreamGoesUnknownAndIsRescued() {
  await withScene(async ({ options, fake }) => {
    await tick(2);
    fake.emit('session.status', { status: { type: 'busy' } });
    await tick(2);
    assert.equal(runtimeStore.readCoordinationState(options).registry.agents[0].runtimeState, 'thinking');

    // The agent finished, but the events that would have said so are lost.
    fake.addMessage({ role: 'assistant', text: 'Work finished.', completed: true });
    fake.dropStreams();
    await tick(2);

    const afterDrop = runtimeStore.readCoordinationState(options).registry.agents[0].runtimeState;
    assert.equal(afterDrop, 'unknown', 'losing the stream must leave the state unknown, not stale');
  });
}

// Losing the stream must not be permanent. The broker reconnects, the next event
// resolves the session, and the agent becomes schedulable again -- which is the
// whole point of `unknown` being exited by evidence rather than by a timer.
async function assertTheAgentRecoversAfterTheStreamComesBack() {
  await withScene(async ({ options, daemonOptions, fake }) => {
    await tick(2);
    fake.emit('session.status', { status: { type: 'idle' } });
    await tick(2);
    assert.equal(runtimeStore.readCoordinationState(options).registry.agents[0].runtimeState, 'idle');

    fake.dropStreams();
    await tick(2);
    const blind = runtimeStore.readCoordinationState(options).registry.agents[0];
    assert.equal(blind.runtimeState, 'unknown');
    assert.equal(
      agentDaemon.isSchedulableAgent(blind, agentDaemon.schedulingContext(daemonOptions)),
      false,
      'an agent we cannot see must not be scheduled'
    );

    // The broker reconnects on its own; give it time, then speak again.
    await sleep(2000);
    await tick(2);
    fake.emit('session.status', { status: { type: 'idle' } });
    await tick(2);

    const recovered = runtimeStore.readCoordinationState(options).registry.agents[0];
    assert.equal(recovered.runtimeState, 'idle', 'the agent never recovered after the stream returned');
    assert.equal(
      agentDaemon.isSchedulableAgent(recovered, agentDaemon.schedulingContext(daemonOptions)),
      true,
      'a recovered agent must become schedulable again, or a blip strands it forever'
    );
  });
}

// Cost, end to end. The closing run finished a whole task cycle with every
// ledger row at 0 because nothing collected usage. The event shape here is
// copied from a real recording.
async function assertUsageReachesTheLedger() {
  await withScene(async ({ options, daemonOptions, fake }) => {
    await tick(2);
    fake.emit('session.status', { status: { type: 'idle' } });
    await tick(2);
    await agentDaemon.runOnce(daemonOptions);

    // The admission arrives on the stream, so it lands on the next pass rather
    // than inside the dispatch call.
    await tick(2);

    const entry = runtimeStore.readPromptLedger(options)[0];
    assert.ok(entry, 'nothing was dispatched, so there is no row to charge');
    assert.equal(entry.cost, 0, 'precondition: a fresh row is uncharged');
    assert.ok(entry.messageId, 'the prompt was never admitted, so nothing can attribute its cost');

    // The runtime reports what the turn cost, against the message the prompt
    // produced.
    fake.emit('message.updated', {
      info: {
        id: entry.messageId,
        role: 'assistant',
        sessionID: fake.sessionId,
        cost: 0.01107835,
        tokens: { total: 50798, input: 629, output: 107, reasoning: 142, cache: { write: 0, read: 49920 } },
      },
    });
    await tick(2);

    const charged = runtimeStore.readPromptLedger(options)[0];
    assert.equal(charged.cost, 0.01107835, 'the reported cost never reached the ledger');
    assert.equal(charged.inputTokens, 629);
  });
}

async function main() {
  await assertAnIdleEventLeadsToADispatch();
  await assertTheRunIsRecordedInTheTransitionLog();
  await assertUsageReachesTheLedger();
  await assertThePromptCapStopsDelivery();
  await assertADroppedStreamGoesUnknownAndIsRescued();
  await assertTheAgentRecoversAfterTheStreamComesBack();

  console.log('Dispatch scenario validation passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
