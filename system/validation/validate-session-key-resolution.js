'use strict';

// Fourth instance of the seam problem, found by finishing the sweep.
//
// The state machine is keyed by OpenCode session id, and there were two sources
// for that id:
//
//   consoleState.currentSessionId  - resolved live by the event broker
//   agent.opencodeSessionId        - only written after a prompt is delivered
//
// Session facts (and therefore the UI) read the first. The publication phase,
// the sweep and the watchdog read the second. So an agent whose stream the
// broker had already resolved but which had never been prompted through the
// dashboard had a state in the UI and no state for the scheduler: visibly
// working, permanently unschedulable. And when the two ids diverge, the UI and
// the scheduler read different states for the same agent.
//
// One resolution, used by everything.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtimeStore = require('../runtime/runtime-store');
const { createOpencodeRuntime } = require('../opencode');

function withProject(run) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-key-'));
  try {
    runtimeStore.ensureInitialized({ projectRoot });
    return run({ projectRoot });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function agent(overrides = {}) {
  return {
    sessionId: 'neon-hammer-ss-1',
    agentName: 'Neon Hammer',
    role: 'Semi Senior',
    adapterType: 'opencode',
    hasLiveTerminal: true,
    serverHost: '127.0.0.1',
    serverPort: 43102,
    opencodeSessionId: null,
    ...overrides,
  };
}

// The broker knows the session before the registry does. That must be enough.
function assertBrokerResolutionIsUsedWhenTheRegistryHasNoId() {
  const opencode = createOpencodeRuntime({ cwd: process.cwd() });
  const target = agent();

  // Teach the state machine about a session the registry has never heard of.
  opencode.applySessionEventForTest({
    type: 'session.idle',
    properties: { sessionID: 'ses_live' },
  });
  opencode.setConsoleSessionForTest(target.sessionId, 'ses_live');

  const states = opencode.runtimeStatesFor([target]);
  assert.equal(states.length, 1, 'an agent the broker has resolved must not be skipped');
  assert.equal(states[0].sessionId, 'ses_live');
  assert.equal(states[0].runtimeState, 'idle');
  assert.equal(states[0].agentSessionId, 'neon-hammer-ss-1');
}

// When the two disagree the live one wins, so the UI and the scheduler cannot
// read different states for the same agent.
function assertLiveResolutionWinsOverAStaleRegistryId() {
  const opencode = createOpencodeRuntime({ cwd: process.cwd() });
  const target = agent({ opencodeSessionId: 'ses_old' });

  opencode.applySessionEventForTest({ type: 'session.status', properties: { sessionID: 'ses_old', status: { type: 'idle' } } });
  opencode.applySessionEventForTest({ type: 'session.status', properties: { sessionID: 'ses_new', status: { type: 'busy' } } });
  opencode.setConsoleSessionForTest(target.sessionId, 'ses_new');

  const states = opencode.runtimeStatesFor([target]);
  assert.equal(states[0].sessionId, 'ses_new');
  assert.equal(states[0].runtimeState, 'thinking', 'the stale registry id shadowed the live session');
}

// With no id from either source there is nothing to report, and reporting
// nothing is correct: no verdict is not permission to schedule.
function assertAnAgentWithNoSessionAtAllIsSkipped() {
  const opencode = createOpencodeRuntime({ cwd: process.cwd() });
  assert.deepEqual(opencode.runtimeStatesFor([agent()]), []);
}

// The registry converges on the resolved id, so the two sources stop drifting.
function assertPublishingConvergesTheRegistryId() {
  withProject((options) => {
    runtimeStore.mutateCoordination(options, (state) => {
      state.registry.agents = [{
        sessionId: 'neon-hammer-ss-1',
        agentName: 'Neon Hammer',
        role: 'Semi Senior',
        adapterType: 'opencode',
        opencodeSessionId: null,
      }];
    });

    const result = runtimeStore.publishAgentRuntimeStates(options, [{
      agentSessionId: 'neon-hammer-ss-1',
      sessionId: 'ses_live',
      runtimeState: 'idle',
      lastEventAt: '2026-08-16T00:00:00.000Z',
    }]);
    assert.equal(result.changed, true);

    const stored = runtimeStore.readCoordinationState(options).registry.agents[0];
    assert.equal(stored.runtimeState, 'idle');
    assert.equal(stored.opencodeSessionId, 'ses_live',
      'the registry must converge on the resolved session id or the two sources drift again');
  });
}

function main() {
  assertBrokerResolutionIsUsedWhenTheRegistryHasNoId();
  assertLiveResolutionWinsOverAStaleRegistryId();
  assertAnAgentWithNoSessionAtAllIsSkipped();
  assertPublishingConvergesTheRegistryId();

  console.log('Session key resolution validation passed.');
}

main();
