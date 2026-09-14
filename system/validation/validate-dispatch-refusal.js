'use strict';

// The other loose seam between the ledger and the dispatcher.
//
// dispatchNextTask reserves the task, then sends the prompt, and it discarded the
// send result. A ledger refusal returns `{ delivered: false }` rather than
// throwing -- correctly, since hitting a cap is a normal outcome -- so the
// dispatcher sailed past it: the task stayed CLAIMED, the agent was marked
// working with an activeTaskId, and nobody had told the agent anything.
//
// The agent then owns a task it was never given, which makes it unschedulable
// until the watchdog's grace period releases it. The cap firing would look like
// the office hanging.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtimeStore = require('../runtime/runtime-store');
const sessionDispatch = require('../dispatch/session-dispatch');

// Must await. Returning the promise from inside try/finally deletes the project
// while the async body is still using it -- a mistake worth only making twice.
async function withProject(run) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-refusal-'));
  try {
    runtimeStore.ensureInitialized({ projectRoot });
    return await run({ projectRoot, workspacePath: projectRoot });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function seed(options) {
  runtimeStore.mutateCoordination(options, (state) => {
    state.registry.agents = [{
      sessionId: 'neon-hammer-ss-1',
      agentName: 'Neon Hammer',
      role: 'Semi Senior',
      adapterType: 'opencode',
      opencodeSessionId: 'ses_1',
      executionMode: 'manual',
      disabled: false,
      status: 'available',
      activeTaskId: null,
      terminalPid: process.pid,
      serverHost: '127.0.0.1',
      serverPort: 43102,
      workspacePath: options.projectRoot,
    }];
    state.tasksStore.tasks = [{
      id: 'NEXT-020',
      type: 'task',
      section: 'active',
      status: 'TODO',
      title: 'A dispatchable task',
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
}

// A refused prompt must leave the task exactly as it was. Reserving work for an
// agent that was never told about it is worse than not dispatching.
async function assertARefusedPromptDoesNotLeaveTheTaskClaimed() {
  await withProject(async (options) => {
    seed(options);

    const refusingLedger = {
      reserve: () => ({ reserved: false, reason: 'task-prompt-cap' }),
      recordTransport: () => {},
      recordOutcome: () => {},
    };

    const result = await sessionDispatch.dispatchNextTask(options, 'neon-hammer-ss-1', {
      ledger: refusingLedger,
      httpJsonRequest: async () => ({ healthy: true }),
      sleep: async () => {},
    });

    assert.equal(result.delivered, false, 'the refusal must reach the caller');
    assert.equal(result.refusedReason, 'task-prompt-cap');

    const after = runtimeStore.readCoordinationState(options);
    const agent = after.registry.agents[0];
    const task = after.tasksStore.tasks[0];

    assert.equal(agent.activeTaskId, null, 'the agent was left owning a task it was never sent');
    assert.notEqual(agent.status, 'working');
    assert.equal(task.status, 'TODO', 'the task stayed claimed after a refused dispatch');
    assert.equal(task.claim, null);
  });
}

// A refused dispatch must not be recorded as a dispatch, or the telemetry says
// work was handed out that never was.
async function assertARefusedPromptRecordsNoRun() {
  await withProject(async (options) => {
    seed(options);

    await sessionDispatch.dispatchNextTask(options, 'neon-hammer-ss-1', {
      ledger: {
        reserve: () => ({ reserved: false, reason: 'session-spend-cap' }),
        recordTransport: () => {},
        recordOutcome: () => {},
      },
      httpJsonRequest: async () => ({ healthy: true }),
      sleep: async () => {},
    });

    const runs = runtimeStore.readCoordinationState(options).runs || [];
    assert.equal(runs.length, 0, 'a refused dispatch was recorded as a run');
  });
}

async function main() {
  await assertARefusedPromptDoesNotLeaveTheTaskClaimed();
  await assertARefusedPromptRecordsNoRun();

  console.log('Dispatch refusal validation passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
