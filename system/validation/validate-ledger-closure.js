'use strict';

// Every condition that blocks needs a defined way to unblock. This is the third
// time the same shape has come up -- `unknown` had no exit, then failed and
// rate_limited had none, and now an open ledger entry would be the third.
//
// Two journeys have to end with the entry closed:
//
// 1. The happy one. A prompt is delivered, the agent works, the turn ends. If
//    nothing closes the entry, the FIRST prompt to every agent leaves an open
//    row forever and the scheduler's "no open entry" condition locks the whole
//    office. This is not the abandoned case; it is the normal one.
// 2. The abandoned one. The agent never answers, the sweep degrades the session
//    to unknown, the watchdog hands the task back. The prompt is dead and the
//    entry must say so.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtimeStore = require('../runtime/runtime-store');
const { createMemoryPromptLedger } = require('../runtime/memory-prompt-ledger');

function withProject(run) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-closure-'));
  try {
    runtimeStore.ensureInitialized({ projectRoot });
    return run({ projectRoot });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function reserved(options, overrides = {}) {
  const result = runtimeStore.reservePrompt(options, {
    agentSessionId: 'pixel-circuit-ss-1',
    taskId: 'NEXT-017',
    command: 'dispatch',
    promptHash: 'hash-a',
    ...overrides,
  });
  assert.equal(result.reserved, true);
  return result.entry.idempotencyKey;
}

// A delivered prompt is not a finished one. `admitted` means OpenCode took it,
// not that the turn is over, so it must not be terminal -- but something has to
// finish it.
function assertAdmittedIsNotTerminalButIsClosable() {
  withProject((options) => {
    const key = reserved(options);
    runtimeStore.recordPromptTransport(options, key, 'submitted');
    runtimeStore.recordPromptOutcome(options, key, 'admitted', { messageId: 'msg_1' });

    assert.equal(runtimeStore.openPromptEntries(options, { agentSessionId: 'pixel-circuit-ss-1' }).length, 1);

    // The turn ending is what finishes it.
    const closed = runtimeStore.closeOpenPromptEntries(options, {
      agentSessionId: 'pixel-circuit-ss-1',
      outcome: 'completed',
      reason: 'session returned to idle',
    });

    assert.equal(closed.closed, 1);
    assert.equal(runtimeStore.openPromptEntries(options, { agentSessionId: 'pixel-circuit-ss-1' }).length, 0);
    assert.equal(runtimeStore.readPromptLedgerEntry(options, key).outcomeStatus, 'completed');
  });
}

// The happy path in full: the same agent must be able to take a second prompt.
// Without closure the first delivery locks it out permanently.
function assertAgentCanBePromptedAgainAfterATurnEnds() {
  withProject((options) => {
    const first = reserved(options);
    runtimeStore.recordPromptTransport(options, first, 'submitted');
    runtimeStore.recordPromptOutcome(options, first, 'admitted');
    runtimeStore.closeOpenPromptEntries(options, { agentSessionId: 'pixel-circuit-ss-1', outcome: 'completed' });

    const second = runtimeStore.reservePrompt(options, {
      agentSessionId: 'pixel-circuit-ss-1',
      taskId: 'NEXT-017',
      command: 'continue',
      promptHash: 'hash-b',
    });
    assert.equal(second.reserved, true, 'a closed entry must not block the next prompt');
    assert.equal(runtimeStore.openPromptEntries(options, { agentSessionId: 'pixel-circuit-ss-1' }).length, 1);
  });
}

// The abandoned journey, end to end. Releasing the task is the moment the system
// declares that prompt dead.
function assertReleasingATaskClosesItsOpenPrompt() {
  withProject((options) => {
    const key = reserved(options);
    runtimeStore.recordPromptTransport(options, key, 'submitted');
    runtimeStore.recordPromptOutcome(options, key, 'admitted');

    const closed = runtimeStore.closeOpenPromptEntries(options, {
      agentSessionId: 'pixel-circuit-ss-1',
      taskId: 'NEXT-017',
      outcome: 'failed',
      reason: 'assignment released after the session became unrecoverable',
    });

    assert.equal(closed.closed, 1);
    const entry = runtimeStore.readPromptLedgerEntry(options, key);
    assert.equal(entry.outcomeStatus, 'failed');
    assert.match(entry.lastError, /unrecoverable/);
  });
}

// Closing must not disturb what is already finished, or a completed prompt could
// be rewritten as failed by a later sweep.
function assertClosingLeavesTerminalEntriesAlone() {
  withProject((options) => {
    const done = reserved(options, { promptHash: 'hash-done' });
    runtimeStore.recordPromptOutcome(options, done, 'completed', { cost: 0.2 });

    const closed = runtimeStore.closeOpenPromptEntries(options, {
      agentSessionId: 'pixel-circuit-ss-1',
      outcome: 'failed',
      reason: 'should not apply',
    });

    assert.equal(closed.closed, 0);
    const entry = runtimeStore.readPromptLedgerEntry(options, done);
    assert.equal(entry.outcomeStatus, 'completed');
    assert.equal(entry.cost, 0.2, 'closing must not disturb recorded spend');
  });
}

// Closing is scoped: one agent's recovery must not close another's open prompts.
function assertClosingIsScopedToTheAgent() {
  withProject((options) => {
    reserved(options, { agentSessionId: 'pixel-circuit-ss-1', promptHash: 'h1' });
    reserved(options, { agentSessionId: 'blue-hammer-pm-1', promptHash: 'h2' });

    runtimeStore.closeOpenPromptEntries(options, { agentSessionId: 'pixel-circuit-ss-1', outcome: 'completed' });

    assert.equal(runtimeStore.openPromptEntries(options, { agentSessionId: 'pixel-circuit-ss-1' }).length, 0);
    assert.equal(runtimeStore.openPromptEntries(options, { agentSessionId: 'blue-hammer-pm-1' }).length, 1);
  });
}

// A test double that disagrees with the real thing is worse than no double:
// the suite stays green while production behaves differently. The two ledgers
// share their lifecycle rules, and this drives the same sequence through both
// and asserts they reach the same decisions.
function assertBothLedgersAgree() {
  withProject((options) => {
    const memory = createMemoryPromptLedger();
    const request = {
      agentSessionId: 'pixel-circuit-ss-1',
      taskId: 'NEXT-017',
      command: 'dispatch',
      promptHash: 'hash-a',
    };

    const decisions = [];
    const step = (label, real, stub) => decisions.push({ label, real, stub });

    step('first reserve',
      runtimeStore.reservePrompt(options, request).reserved,
      memory.reserve(request).reserved);

    step('duplicate while open',
      runtimeStore.reservePrompt(options, request).reason,
      memory.reserve(request).reason);

    const key = runtimeStore.promptIdempotencyKey(request);
    runtimeStore.recordPromptTransport(options, key, 'submitted');
    runtimeStore.recordPromptOutcome(options, key, 'failed', { error: 'x' });
    memory.recordTransport(key, 'submitted');
    memory.recordOutcome(key, 'failed', { error: 'x' });

    step('retry after failing post-submit',
      runtimeStore.reservePrompt(options, request).reason,
      memory.reserve(request).reason);

    for (const decision of decisions) {
      assert.deepEqual(decision.real, decision.stub,
        `the ledgers disagree on "${decision.label}": real=${decision.real} stub=${decision.stub}`);
    }
  });
}

function main() {
  assertAdmittedIsNotTerminalButIsClosable();
  assertAgentCanBePromptedAgainAfterATurnEnds();
  assertReleasingATaskClosesItsOpenPrompt();
  assertClosingLeavesTerminalEntriesAlone();
  assertClosingIsScopedToTheAgent();
  assertBothLedgersAgree();

  console.log('Ledger closure validation passed.');
}

main();
