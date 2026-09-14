'use strict';

// Step 4, last slice: the scheduler decides from the state machine and the
// ledger instead of from inferred status fields.
//
// Three conditions gate a dispatch, and each one has a defined way to unblock,
// which is the thing that took three attempts to get right:
//
//   runtimeState === 'idle'   -> events, the read-only rescue, or markStale
//   activeTaskId === null     -> the watchdog releasing after the grace period
//   no open ledger entry      -> closed on idle, or closed when a task is released
//
// The checks here are advisory. The real gates are transactional: the ledger
// reservation and the task reservation each decide atomically. So a refusal is
// a normal outcome that moves on to the next agent, never an error.

const assert = require('assert');
const agentDaemon = require('../daemon/agent-daemon');

function agent(overrides = {}) {
  return {
    sessionId: 'pixel-circuit-ss-1',
    agentName: 'Pixel Circuit',
    role: 'Semi Senior',
    executionMode: 'manual',
    disabled: false,
    terminalPid: process.pid,
    status: 'available',
    activeTaskId: null,
    attentionRequired: false,
    operationalStatus: null,
    opencodeSessionId: 'ses_1',
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    runtimeStateFor: () => ({ state: 'idle' }),
    hasOpenPromptEntry: () => false,
    ...overrides,
  };
}

// Only idle schedules, and it comes from the state machine rather than from a
// status string somebody wrote earlier.
function assertOnlyIdleRuntimeStateSchedules() {
  const scheduled = [];
  for (const state of ['idle', 'thinking', 'streaming', 'submitted', 'prompt_queued',
    'waiting_user', 'waiting_permission', 'rate_limited', 'failed', 'unknown']) {
    if (agentDaemon.isSchedulableAgent(agent(), context({ runtimeStateFor: () => ({ state }) }))) {
      scheduled.push(state);
    }
  }
  assert.deepEqual(scheduled, ['idle']);
}

// An agent that already owns a task is never scheduled. This is the rule the
// whole incident came down to and it must survive everything else changing.
function assertAgentOwningATaskIsNeverScheduled() {
  assert.equal(agentDaemon.isSchedulableAgent(agent({ activeTaskId: 'NEXT-017' }), context()), false);
}

// An open ledger entry means a prompt is still in flight for that agent.
function assertOpenLedgerEntryBlocks() {
  assert.equal(
    agentDaemon.isSchedulableAgent(agent(), context({ hasOpenPromptEntry: () => true })),
    false
  );
  assert.equal(agentDaemon.isSchedulableAgent(agent(), context()), true);
}

// Without a state machine verdict we know nothing, and knowing nothing is not
// permission to send.
function assertMissingRuntimeStateIsNotSchedulable() {
  assert.equal(agentDaemon.isSchedulableAgent(agent(), context({ runtimeStateFor: () => null })), false);
  assert.equal(agentDaemon.isSchedulableAgent(agent({ opencodeSessionId: null }), context()), false);
}

// The pre-existing guards still hold: they are cheap and they fail safe.
function assertOperationalGuardsStillApply() {
  const cases = [
    ['disabled', { disabled: true }],
    ['not manual', { executionMode: 'daemon' }],
    ['dead terminal', { terminalPid: 999999999 }],
    ['attention required', { attentionRequired: true }],
    ['operational error', { operationalStatus: 'error' }],
    ['blocked', { status: 'blocked' }],
  ];
  for (const [label, overrides] of cases) {
    assert.equal(agentDaemon.isSchedulableAgent(agent(overrides), context()), false, `${label} was scheduled`);
  }
}

// Every blocking condition has a way out. If one of these ever stops unblocking,
// the office silently stops dispatching and the tests would otherwise stay green.
function assertEveryBlockingConditionCanBeUnblocked() {
  // Blocked on runtime state -> resolved by the state machine reaching idle.
  const stuck = agent();
  assert.equal(agentDaemon.isSchedulableAgent(stuck, context({ runtimeStateFor: () => ({ state: 'unknown' }) })), false);
  assert.equal(agentDaemon.isSchedulableAgent(stuck, context({ runtimeStateFor: () => ({ state: 'idle' }) })), true);

  // Blocked on task ownership -> resolved when the watchdog releases it.
  assert.equal(agentDaemon.isSchedulableAgent(agent({ activeTaskId: 'NEXT-017' }), context()), false);
  assert.equal(agentDaemon.isSchedulableAgent(agent({ activeTaskId: null }), context()), true);

  // Blocked on an open prompt -> resolved when the entry is closed.
  let open = true;
  const ledgerContext = context({ hasOpenPromptEntry: () => open });
  assert.equal(agentDaemon.isSchedulableAgent(agent(), ledgerContext), false);
  open = false;
  assert.equal(agentDaemon.isSchedulableAgent(agent(), ledgerContext), true);
}

function main() {
  assertOnlyIdleRuntimeStateSchedules();
  assertAgentOwningATaskIsNeverScheduled();
  assertOpenLedgerEntryBlocks();
  assertMissingRuntimeStateIsNotSchedulable();
  assertOperationalGuardsStillApply();
  assertEveryBlockingConditionCanBeUnblocked();

  console.log('Scheduler validation passed.');
}

main();
