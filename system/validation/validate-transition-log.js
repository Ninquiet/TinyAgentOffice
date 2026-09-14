'use strict';

// Step 4, third slice: the append-only workflow transition log.
//
// The brief calls this the one irreversible decision in the refactor. What
// cannot be recovered later is not the storage medium -- a file can always be
// migrated into a table -- but the fields captured at the moment of writing. An
// agent's activeTaskId changes, so a transition that records only a session id
// cannot be attributed to a task afterwards: that information stops existing.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtimeStore = require('../runtime/runtime-store');
const { createTransitionBuffer } = require('../runtime/transition-buffer');

function tempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-translog-'));
  runtimeStore.ensureInitialized({ projectRoot });
  return projectRoot;
}

function transition(overrides = {}) {
  return {
    sessionId: 'ses_1',
    from: 'thinking',
    to: 'idle',
    eventType: 'session.idle',
    at: '2026-08-16T00:00:00.000Z',
    ...overrides,
  };
}

// The whole point: attribution captured at write time, not inferred later.
function assertTransitionsRecordTheirTaskAndActor() {
  const projectRoot = tempProject();
  try {
    const options = { projectRoot };
    runtimeStore.appendWorkflowTransitions(options, [{
      ...transition(),
      agentSessionId: 'pixel-circuit-ss-1',
      agentName: 'Pixel Circuit',
      role: 'Semi Senior',
      taskId: 'NEXT-017',
      reason: null,
    }]);

    const rows = runtimeStore.readWorkflowTransitions(options);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.sessionId, 'ses_1');
    assert.equal(row.agentSessionId, 'pixel-circuit-ss-1');
    assert.equal(row.agentName, 'Pixel Circuit');
    assert.equal(row.role, 'Semi Senior');
    assert.equal(row.taskId, 'NEXT-017');
    assert.equal(row.fromState, 'thinking');
    assert.equal(row.toState, 'idle');
    assert.equal(row.eventType, 'session.idle');
    assert.equal(row.at, '2026-08-16T00:00:00.000Z');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// Grouping by task is the reason this exists: the task journey visualisation
// needs every transition that happened while a session owned a given task.
function assertTransitionsCanBeGroupedByTask() {
  const projectRoot = tempProject();
  try {
    const options = { projectRoot };
    runtimeStore.appendWorkflowTransitions(options, [
      { ...transition({ to: 'thinking', at: '2026-08-16T00:00:01.000Z' }), taskId: 'NEXT-017', agentName: 'Pixel Circuit', role: 'Semi Senior' },
      { ...transition({ at: '2026-08-16T00:00:02.000Z' }), taskId: 'NEXT-017', agentName: 'Pixel Circuit', role: 'Semi Senior' },
      { ...transition({ at: '2026-08-16T00:00:03.000Z' }), taskId: 'NEXT-018', agentName: 'Blue Hammer', role: 'Project Manager' },
    ]);

    assert.equal(runtimeStore.readWorkflowTransitions(options, { taskId: 'NEXT-017' }).length, 2);
    assert.equal(runtimeStore.readWorkflowTransitions(options, { taskId: 'NEXT-018' }).length, 1);
    assert.equal(runtimeStore.readWorkflowTransitions(options).length, 3);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// Append-only. Writing more must never disturb what is already there, and the
// order transitions happened in has to survive.
function assertTheLogIsAppendOnlyAndOrdered() {
  const projectRoot = tempProject();
  try {
    const options = { projectRoot };
    for (let i = 1; i <= 3; i += 1) {
      runtimeStore.appendWorkflowTransitions(options, [transition({ at: `2026-08-16T00:00:0${i}.000Z`, to: `state-${i}` })]);
    }
    const rows = runtimeStore.readWorkflowTransitions(options);
    assert.deepEqual(rows.map((row) => row.toState), ['state-1', 'state-2', 'state-3']);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// The narrow write path. Going through mutateCoordination would rewrite all
// three JSON mirrors on every tick, undoing the step 1 performance work.
function assertAppendingDoesNotRewriteTheJsonMirrors() {
  const projectRoot = tempProject();
  try {
    const options = { projectRoot };
    runtimeStore.mutateCoordination(options, (state) => {
      state.tasksStore.tasks = [];
      state.registry.agents = [];
    });

    const paths = runtimeStore.resolvePaths(options);
    const before = {
      tasks: fs.statSync(paths.tasksPath).mtimeMs,
      registry: fs.statSync(paths.registryPath).mtimeMs,
    };

    for (let i = 0; i < 5; i += 1) {
      runtimeStore.appendWorkflowTransitions(options, [transition({ at: `2026-08-16T00:00:0${i}.000Z` })]);
    }

    assert.equal(fs.statSync(paths.tasksPath).mtimeMs, before.tasks, 'appending rewrote tasks.json');
    assert.equal(fs.statSync(paths.registryPath).mtimeMs, before.registry, 'appending rewrote the registry mirror');
    assert.equal(fs.existsSync(`${paths.dbPath}.lock`), false, 'the append left the db lock behind');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// This log is the accumulation layer the game is missing: employee history and
// task journeys are built from it. Throwing it away by default would discard the
// progression before it is built.
function assertNothingIsPrunedByDefault() {
  const projectRoot = tempProject();
  try {
    const options = { projectRoot };
    const rows = [];
    for (let i = 0; i < 200; i += 1) {
      rows.push(transition({ at: new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString() }));
    }
    runtimeStore.appendWorkflowTransitions(options, rows);
    assert.equal(runtimeStore.readWorkflowTransitions(options, { limit: 0 }).length, 200,
      'transitions were pruned; this log is the game\'s accumulation layer and must not expire by default');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// The buffer is what the reducer's onTransition feeds. Attribution is resolved
// at flush time from live registry state, because that is the last moment the
// answer still exists.
function assertBufferEnrichesWithAttributionAtFlushTime() {
  const written = [];
  const buffer = createTransitionBuffer({
    resolveContext: (sessionId) => (sessionId === 'ses_1'
      ? { agentSessionId: 'pixel-circuit-ss-1', agentName: 'Pixel Circuit', role: 'Semi Senior', taskId: 'NEXT-017' }
      : null),
    write: (rows) => written.push(...rows),
  });

  buffer.record(transition());
  buffer.record(transition({ sessionId: 'ses_unknown' }));
  assert.equal(buffer.size(), 2);

  buffer.flush();

  assert.equal(written.length, 2);
  assert.equal(written[0].taskId, 'NEXT-017');
  assert.equal(written[0].agentName, 'Pixel Circuit');
  assert.equal(written[0].role, 'Semi Senior');
  // An unattributable transition is still recorded: losing it would be worse
  // than recording it with nulls.
  assert.equal(written[1].taskId, null);
  assert.equal(written[1].sessionId, 'ses_unknown');
  assert.equal(buffer.size(), 0, 'a successful flush empties the buffer');
}

// The accepted crash tradeoff is losing at most one tick of transitions. A
// failed write is not a crash, so those rows must survive to the next flush.
function assertAFailedFlushKeepsTheRows() {
  let attempts = 0;
  const buffer = createTransitionBuffer({
    resolveContext: () => null,
    write: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('db locked');
    },
  });

  buffer.record(transition());
  buffer.flush();
  assert.equal(buffer.size(), 1, 'a failed write must not drop the transitions');

  buffer.flush();
  assert.equal(attempts, 2);
  assert.equal(buffer.size(), 0);
}

function assertFlushingAnEmptyBufferDoesNotWrite() {
  let calls = 0;
  const buffer = createTransitionBuffer({ resolveContext: () => null, write: () => { calls += 1; } });
  buffer.flush();
  assert.equal(calls, 0);
}

function main() {
  assertTransitionsRecordTheirTaskAndActor();
  assertTransitionsCanBeGroupedByTask();
  assertTheLogIsAppendOnlyAndOrdered();
  assertAppendingDoesNotRewriteTheJsonMirrors();
  assertNothingIsPrunedByDefault();
  assertBufferEnrichesWithAttributionAtFlushTime();
  assertAFailedFlushKeepsTheRows();
  assertFlushingAnEmptyBufferDoesNotWrite();

  console.log('Transition log validation passed.');
}

main();
