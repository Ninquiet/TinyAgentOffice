'use strict';

// Step 4, fourth slice: the prompt ledger.
//
// Two things it must do, and they are different problems:
//
// - Idempotency stops the SAME prompt going twice. That is what the re-append
//   bug did.
// - The spend cap stops thirteen legitimately DIFFERENT prompts burning a quota.
//   That is what actually happened to Pixel Circuit, and idempotency would not
//   have prevented a single one of them.
//
// Both checks live inside the reservation transaction. A caller that checks
// first and reserves second is two dispatchers each passing their own check.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtimeStore = require('../runtime/runtime-store');

function tempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-ledger-'));
  runtimeStore.ensureInitialized({ projectRoot });
  return projectRoot;
}

function request(overrides = {}) {
  return {
    agentSessionId: 'pixel-circuit-ss-1',
    taskId: 'NEXT-017',
    command: 'dispatch',
    promptHash: 'hash-a',
    ...overrides,
  };
}

function withProject(run) {
  const projectRoot = tempProject();
  try {
    run({ projectRoot });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// The brief is explicit that transport and outcome are two lifecycles and must
// not be collapsed into one status, or `accepted` drifts into meaning different
// things depending on who wrote the code.
function assertTransportAndOutcomeAreSeparateFields() {
  withProject((options) => {
    const reserved = runtimeStore.reservePrompt(options, request());
    assert.equal(reserved.reserved, true);
    assert.equal(reserved.entry.transportStatus, 'created');
    assert.equal(reserved.entry.outcomeStatus, 'pending');
    assert.ok(reserved.entry.idempotencyKey);

    runtimeStore.recordPromptTransport(options, reserved.entry.idempotencyKey, 'submitted');
    runtimeStore.recordPromptOutcome(options, reserved.entry.idempotencyKey, 'admitted', { messageId: 'msg_1' });

    const entry = runtimeStore.readPromptLedgerEntry(options, reserved.entry.idempotencyKey);
    assert.equal(entry.transportStatus, 'submitted');
    assert.equal(entry.outcomeStatus, 'admitted');
    assert.equal(entry.messageId, 'msg_1');
  });
}

// The same prompt must not go twice while the first is still open.
function assertDuplicateNonTerminalKeyIsRefused() {
  withProject((options) => {
    assert.equal(runtimeStore.reservePrompt(options, request()).reserved, true);

    const second = runtimeStore.reservePrompt(options, request());
    assert.equal(second.reserved, false);
    assert.equal(second.reason, 'duplicate');
  });
}

// Failing before the prompt reached OpenCode is safe to retry. Failing after it
// was submitted is not: the agent may already be working on it.
function assertRetryDependsOnHowFarItGot() {
  withProject((options) => {
    const first = runtimeStore.reservePrompt(options, request());
    runtimeStore.recordPromptOutcome(options, first.entry.idempotencyKey, 'failed', { error: 'connection refused' });
    const retry = runtimeStore.reservePrompt(options, request());
    assert.equal(retry.reserved, true, 'a prompt that failed before append may be retried');

    const other = runtimeStore.reservePrompt(options, request({ promptHash: 'hash-b' }));
    runtimeStore.recordPromptTransport(options, other.entry.idempotencyKey, 'submitted');
    runtimeStore.recordPromptOutcome(options, other.entry.idempotencyKey, 'failed', { error: 'verification timed out' });

    const afterSubmit = runtimeStore.reservePrompt(options, request({ promptHash: 'hash-b' }));
    assert.equal(afterSubmit.reserved, false);
    assert.equal(afterSubmit.reason, 'failed-after-submit',
      'a prompt that failed after submit needs manual recovery, not an automatic retry');
  });
}

// The incident, directly. Thirteen different continue prompts against one task
// are thirteen distinct idempotency keys, so only a cap stops them.
function assertPerTaskPromptCapIsEnforced() {
  withProject((options) => {
    const limits = { maxPromptsPerTask: 3 };
    for (let i = 0; i < 3; i += 1) {
      const result = runtimeStore.reservePrompt(options, request({ promptHash: `hash-${i}` }), limits);
      assert.equal(result.reserved, true, `prompt ${i} should have been allowed`);
      runtimeStore.recordPromptOutcome(options, result.entry.idempotencyKey, 'completed');
    }

    const overCap = runtimeStore.reservePrompt(options, request({ promptHash: 'hash-4' }), limits);
    assert.equal(overCap.reserved, false);
    assert.equal(overCap.reason, 'task-prompt-cap');

    // The cap is per task, so a different task is unaffected.
    const otherTask = runtimeStore.reservePrompt(options, request({ taskId: 'NEXT-018', promptHash: 'hash-4' }), limits);
    assert.equal(otherTask.reserved, true);
  });
}

// The spend budget is the same measurement the game's spending mechanic uses.
function assertSessionSpendBudgetIsEnforced() {
  withProject((options) => {
    const limits = { maxSessionCost: 1.0 };
    const first = runtimeStore.reservePrompt(options, request({ promptHash: 'hash-a' }), limits);
    runtimeStore.recordPromptOutcome(options, first.entry.idempotencyKey, 'completed', { cost: 0.75 });

    const second = runtimeStore.reservePrompt(options, request({ promptHash: 'hash-b' }), limits);
    assert.equal(second.reserved, true, 'still under budget');
    runtimeStore.recordPromptOutcome(options, second.entry.idempotencyKey, 'completed', { cost: 0.40 });

    const overBudget = runtimeStore.reservePrompt(options, request({ promptHash: 'hash-c' }), limits);
    assert.equal(overBudget.reserved, false);
    assert.equal(overBudget.reason, 'session-spend-cap');
    assert.equal(runtimeStore.sessionSpend(options, 'pixel-circuit-ss-1').toFixed(2), '1.15');
  });
}

// The caps must be evaluated where the row is written, not by whoever calls.
// Two dispatchers that each check and then reserve both pass their own check.
function assertCapsAreEvaluatedInsideTheReservation() {
  withProject((options) => {
    const limits = { maxPromptsPerTask: 1 };
    // No caller counts anything: reserve is handed the limits and does the
    // counting itself, against the state in the same transaction that inserts.
    const first = runtimeStore.reservePrompt(options, request({ promptHash: 'a' }), limits);
    const second = runtimeStore.reservePrompt(options, request({ promptHash: 'b' }), limits);

    assert.equal(first.reserved, true);
    assert.equal(second.reserved, false);
    assert.equal(second.reason, 'task-prompt-cap');

    const entries = runtimeStore.readPromptLedger(options, { taskId: 'NEXT-017' });
    assert.equal(entries.length, 1, 'a refused reservation must not leave a row behind');
  });
}

// Deduplication depends on the prompt string being stable for the same inputs.
// A timestamp or random id inside a prompt builder would silently switch it off.
function assertPromptBuildersAreDeterministic() {
  const dashboardServer = require('../dashboard/server');
  const build = () => dashboardServer.buildProjectManagerTaskRequestPrompt({
    id: 'user-task-1',
    text: 'Crear juego de ardilla con tres niveles',
    attachments: [],
  });

  assert.equal(build(), build(), 'the prompt builder is not deterministic; deduplication would stop working');

  const sessionDispatch = require('../dispatch/session-dispatch');
  const agent = { agentName: 'Blue Socket', role: 'Senior Pro', sessionId: 'blue-socket-sp-1', workspacePath: 'C:\\x' };
  const task = { id: 'TASK-001', title: 'A task', goal: [], scope: [] };
  assert.equal(
    sessionDispatch.buildDispatchInstruction(agent, task),
    sessionDispatch.buildDispatchInstruction(agent, task)
  );
}

function main() {
  assertTransportAndOutcomeAreSeparateFields();
  assertDuplicateNonTerminalKeyIsRefused();
  assertRetryDependsOnHowFarItGot();
  assertPerTaskPromptCapIsEnforced();
  assertSessionSpendBudgetIsEnforced();
  assertCapsAreEvaluatedInsideTheReservation();
  assertPromptBuildersAreDeterministic();

  console.log('Prompt ledger validation passed.');
}

main();
