'use strict';

// The seam between the state machine and the daemon.
//
// The daemon is a separate process: it cannot read the dashboard's in-memory
// state store, so it reads `agent.runtimeState` from the registry. That makes
// publishing the state into the registry a load-bearing step, not bookkeeping.
//
// The bug this was written for: the only writer of runtimeState was the activity
// watchdog, and it only inspects agents that already own a task. Idle agents --
// exactly the ones the scheduler needs a verdict for -- never got the field at
// all, so `runtimeState === 'idle'` was never true and the daemon would never
// have dispatched anything. Every piece worked in isolation and the whole thing
// was deadlocked.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtimeStore = require('../runtime/runtime-store');
const agentDaemon = require('../daemon/agent-daemon');

function withProject(run) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-publish-'));
  try {
    runtimeStore.ensureInitialized({ projectRoot });
    return run({ projectRoot });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function seedIdleAgent(options) {
  runtimeStore.mutateCoordination(options, (state) => {
    state.registry.agents = [{
      sessionId: 'pixel-circuit-ss-1',
      agentName: 'Pixel Circuit',
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
    }];
  });
}

// An idle agent needs a published verdict, or the scheduler can never act on it.
function assertIdleAgentsGetTheirRuntimeStatePublished() {
  withProject((options) => {
    seedIdleAgent(options);

    const before = runtimeStore.readCoordinationState(options).registry.agents[0];
    assert.equal(before.runtimeState, undefined, 'precondition: nothing has published a state yet');

    const result = runtimeStore.publishAgentRuntimeStates(options, [{
      sessionId: 'pixel-circuit-ss-1',
      runtimeState: 'idle',
      lastEventAt: '2026-08-16T00:00:00.000Z',
    }]);
    assert.equal(result.changed, true);

    const after = runtimeStore.readCoordinationState(options).registry.agents[0];
    assert.equal(after.runtimeState, 'idle');
    assert.equal(after.lastRuntimeEventAt, '2026-08-16T00:00:00.000Z');
  });
}

// The seam itself: with the state published, the daemon's own default context
// must find the agent schedulable. This is what was deadlocked.
function assertThePublishedStateReachesTheScheduler() {
  withProject((options) => {
    seedIdleAgent(options);
    const daemonOptions = { workspacePath: options.projectRoot };

    const beforeAgent = runtimeStore.readCoordinationState(options).registry.agents[0];
    assert.equal(
      agentDaemon.isSchedulableAgent(beforeAgent, agentDaemon.schedulingContext(daemonOptions)),
      false,
      'without a published state the daemon must not schedule'
    );

    runtimeStore.publishAgentRuntimeStates(options, [{
      sessionId: 'pixel-circuit-ss-1',
      runtimeState: 'idle',
      lastEventAt: new Date().toISOString(),
    }]);

    const afterAgent = runtimeStore.readCoordinationState(options).registry.agents[0];
    assert.equal(
      agentDaemon.isSchedulableAgent(afterAgent, agentDaemon.schedulingContext(daemonOptions)),
      true,
      'a published idle state must make the agent schedulable; otherwise the office never dispatches'
    );
  });
}

// Publishing is on the world tick, so it must not write when nothing changed --
// the same rule the reconcile pass follows.
function assertPublishingIsANoOpWhenNothingChanged() {
  withProject((options) => {
    seedIdleAgent(options);
    runtimeStore.publishAgentRuntimeStates(options, [{
      sessionId: 'pixel-circuit-ss-1',
      runtimeState: 'idle',
      lastEventAt: '2026-08-16T00:00:00.000Z',
    }]);

    const paths = runtimeStore.resolvePaths(options);
    const before = fs.statSync(paths.registryPath).mtimeMs;

    for (let i = 0; i < 3; i += 1) {
      const repeat = runtimeStore.publishAgentRuntimeStates(options, [{
        sessionId: 'pixel-circuit-ss-1',
        runtimeState: 'idle',
        lastEventAt: '2026-08-16T00:00:00.000Z',
      }]);
      assert.equal(repeat.changed, false);
    }

    assert.equal(fs.statSync(paths.registryPath).mtimeMs, before,
      'republishing an unchanged state rewrote the registry mirror');
  });
}

// A real state change must get through.
function assertAChangedStateIsWritten() {
  withProject((options) => {
    seedIdleAgent(options);
    runtimeStore.publishAgentRuntimeStates(options, [{ sessionId: 'pixel-circuit-ss-1', runtimeState: 'idle' }]);
    const changed = runtimeStore.publishAgentRuntimeStates(options, [{ sessionId: 'pixel-circuit-ss-1', runtimeState: 'thinking' }]);
    assert.equal(changed.changed, true);
    assert.equal(runtimeStore.readCoordinationState(options).registry.agents[0].runtimeState, 'thinking');
  });
}

// Unknown sessions must not create phantom registry entries.
function assertUnknownSessionsAreIgnored() {
  withProject((options) => {
    seedIdleAgent(options);
    const result = runtimeStore.publishAgentRuntimeStates(options, [{ sessionId: 'ses_nobody', runtimeState: 'idle' }]);
    assert.equal(result.changed, false);
    assert.equal(runtimeStore.readCoordinationState(options).registry.agents.length, 1);
  });
}

function assertRateLimitsReachTheSecretaryOncePerIncident() {
  withProject((options) => {
    seedIdleAgent(options);
    const firstIncident = {
      sessionId: 'pixel-circuit-ss-1',
      runtimeState: 'rate_limited',
      lastEventAt: '2026-08-16T00:00:03.000Z',
      rateLimitStartedAt: '2026-08-16T00:00:01.000Z',
      lastError: 'Weekly usage limit reached. It will reset in 2 days.',
      retry: { attempt: 1, nextAt: 1770000000000 },
    };

    runtimeStore.publishAgentRuntimeStates(options, [firstIncident]);
    let state = runtimeStore.readCoordinationState(options);
    assert.equal(state.secretaryInbox.items.length, 1,
      'a published rate limit must create a secretary message');
    assert.match(state.secretaryInbox.items[0].body, /Weekly usage limit reached/i);
    assert.equal(state.secretaryInbox.items[0].agentName, 'Pixel Circuit');

    const repeat = runtimeStore.publishAgentRuntimeStates(options, [{
      ...firstIncident,
      lastEventAt: '2026-08-16T00:00:04.000Z',
      retry: { attempt: 2, nextAt: 1770000005000 },
    }]);
    state = runtimeStore.readCoordinationState(options);
    assert.equal(state.secretaryInbox.items.length, 1,
      'retry events within one rate-limit incident must not flood the secretary');
    assert.equal(repeat.notified, 0);

    const firstId = state.secretaryInbox.items[0].id;
    runtimeStore.mutateCoordination(options, (draft) => {
      const inbox = require('../core/secretary-inbox');
      inbox.dismissInboxMessage(draft.secretaryInbox, firstId);
    });
    runtimeStore.publishAgentRuntimeStates(options, [{ ...firstIncident, lastEventAt: '2026-08-16T00:00:05.000Z' }]);
    state = runtimeStore.readCoordinationState(options);
    assert.equal(state.secretaryInbox.items.length, 0,
      'dismissing an incident must not make the world tick recreate it');

    runtimeStore.publishAgentRuntimeStates(options, [{
      sessionId: 'pixel-circuit-ss-1', runtimeState: 'idle', lastEventAt: '2026-08-17T00:00:00.000Z',
    }]);
    runtimeStore.publishAgentRuntimeStates(options, [{
      ...firstIncident,
      lastEventAt: '2026-08-20T00:00:03.000Z',
      rateLimitStartedAt: '2026-08-20T00:00:01.000Z',
    }]);
    state = runtimeStore.readCoordinationState(options);
    assert.equal(state.secretaryInbox.items.length, 1,
      'a later, distinct rate-limit incident must notify again');
    assert.notEqual(state.secretaryInbox.items[0].id, firstId);
  });
}

function main() {
  assertIdleAgentsGetTheirRuntimeStatePublished();
  assertThePublishedStateReachesTheScheduler();
  assertPublishingIsANoOpWhenNothingChanged();
  assertAChangedStateIsWritten();
  assertUnknownSessionsAreIgnored();
  assertRateLimitsReachTheSecretaryOncePerIncident();

  console.log('Runtime state publication validation passed.');
}

main();
