'use strict';

const coordinationCore = require('../runtime/coordination-core');
const runtimeStore = require('../runtime/runtime-store');
const runtimeReconcile = require('../runtime/runtime-reconcile');
const provider = require('./provider');

const { getPolicy } = require('../runtime/runtime-policy');

function utcNow() {
  return new Date().toISOString();
}

function parseTimeMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// States that mean the assignment is genuinely abandoned.
//
// `unknown` is the real stall signal: the state machine gave up on knowing,
// and the world tick's read-only rescue already had its chance to resolve it.
// `failed` is a terminal runtime error on the session.
//
// Deliberately absent: `rate_limited`, which is waiting to retry rather than
// abandoned, and `waiting_user` / `waiting_permission`, where the work is
// blocked on us and taking the task away would be the system fighting itself.
const ABANDONED_STATES = new Set(['unknown', 'failed']);

// The case those two states cannot express: the turn ended, cleanly as far as
// every state is concerned, but the provider dropped it mid-work. The session
// is `idle` and perfectly healthy; what is stalled is the assignment.
//
// This is evidence, not a clock, and the difference decides a real case. An
// implementer that finished and is waiting on a reviewer is also idle, also
// holding a task, also silent for hours -- a timer cannot tell the two apart
// and would take a finished task away from the agent that did the work, to be
// redone and paid for a second time. Its last turn ended with real tokens and
// a real finish reason, so the evidence can.
function hasDroppedTurn(runtime) {
  return Boolean(runtime && runtime.droppedTurnAt);
}

function releaseNoteText(release) {
  const base = `Released stale assignment from ${release.agentName}`;
  const cause = release.droppedTurnAt
    ? `; the provider dropped the turn at ${release.droppedTurnAt} and the session went idle without finishing`
    : '; no assistant response after the watchdog grace period';

  // The cost of releasing is that the work is redone and paid for twice. What
  // already reached disk does not have to be rediscovered, so it goes on the
  // task and the next attempt starts from it.
  const files = Array.isArray(release.touchedFiles) ? release.touchedFiles : [];
  const produced = files.length > 0
    ? ` ${files.length} file(s) from that attempt are already on disk: ${files.join(', ')}.`
    : '';

  return `${base}${cause}.${produced}`;
}

function taskOwnedByAgent(task, agent) {
  return Boolean(
    task
    && coordinationCore.currentWorkflowActorRole(task) === agent.role
    && task.status !== 'BLOCKED'
  );
}

function shouldInspectAgent(agent) {
  return Boolean(
    agent
    && provider.isOpencodeAgent(agent)
    && agent.activeTaskId
    && Number.isInteger(agent.terminalPid)
    && runtimeReconcile.isPidAlive(agent.terminalPid)
    && agent.status !== 'attention'
    && !agent.attentionRequired
  );
}

// Records the stall mark and the release bookkeeping. It deliberately does NOT
// write agent.runtimeState: the world tick publishes that for every live agent,
// and this only ever sees agents that already own a task. Two writers to one
// field is the pattern this refactor keeps removing.
function applyActivityPatches(options, patches) {
  if (patches.length === 0) return;
  runtimeStore.mutateCoordination(options, (state) => {
    for (const patch of patches) {
      const agent = (state.registry.agents || []).find((entry) => entry.sessionId === patch.agentSessionId);
      if (!agent) continue;
      agent.lastActivityAt = patch.lastEventAt || agent.lastActivityAt || null;
      agent.activityState = patch.activityState;
      if (patch.stalled) {
        agent.stalledSinceAt = agent.stalledSinceAt || patch.at;
        agent.note = patch.droppedTurnAt
          ? `The provider dropped the turn on ${patch.taskId}; the session finished nothing and went idle.`
          : `No usable session state for ${patch.taskId}; waiting for recovery.`;
      } else {
        // Cleared only when the agent is genuinely usable again, not merely
        // when its state is outside ABANDONED_STATES. That weaker test reset
        // the clock on every pass for an idle session, so the grace period
        // could never elapse and the release could never happen.
        agent.stalledSinceAt = null;
        agent.lastWatchdogPingAt = null;
        agent.watchdogPingCount = 0;
        agent.watchdogEscalatedAt = null;
      }
    }
    state.registry.updatedAt = utcNow();
  });
}
function releaseStalledAssignments(options, releases) {
  if (releases.length === 0) return;
  const closures = [];
  runtimeStore.mutateCoordination(options, (state) => {
    for (const release of releases) {
      const agent = (state.registry.agents || []).find((entry) => entry.sessionId === release.agentSessionId);
      const task = (state.tasksStore.tasks || []).find((entry) => entry.id === release.taskId);

      if (task && task.status === 'IN_PROGRESS' && task.claim && task.claim.agentName === release.agentName && task.claim.role === release.role) {
        task.status = 'TODO';
        task.claim = null;
        task.attentionType = null;
        // A new attempt, not a repeat of the last one. The prompt ledger keys
        // on this: without it the re-dispatch is byte-identical to the prompt
        // that was already sent and gets refused as `already-completed`, which
        // is what happened the first time a task was released by hand.
        task.attempt = (Number(task.attempt) || 0) + 1;
        coordinationCore.setWorkflowState(
          task,
          coordinationCore.normalizedTaskRole(task) === 'Project Manager' ? 'pm_planning' : 'implementation_queue',
          coordinationCore.normalizedTaskRole(task),
          null
        );
        if (!Array.isArray(task.notes)) task.notes = [];
        task.notes.push({
          kind: 'watchdog-release',
          text: releaseNoteText(release),
          touchedFiles: Array.isArray(release.touchedFiles) ? release.touchedFiles : [],
          droppedTurnAt: release.droppedTurnAt || null,
          attempt: task.attempt,
          createdAt: utcNow(),
          agentName: release.agentName,
          role: release.role,
          sessionId: release.agentSessionId,
        });
      }

      if (
        task
        && task.status === 'REVIEW_NEEDED'
        && task.reviewClaim
        && task.reviewClaim.agentName === release.agentName
        && task.reviewClaim.role === release.role
      ) {
        task.reviewClaim = null;
        task.attentionType = 'senior_closure';
        coordinationCore.setWorkflowState(task, 'senior_review', 'Senior Pro', null);
        if (!Array.isArray(task.notes)) task.notes = [];
        task.notes.push({
          kind: 'watchdog-release',
          text: `Released stale Senior Pro review claim from ${release.agentName}; no assistant response after watchdog grace period.`,
          createdAt: utcNow(),
          agentName: release.agentName,
          role: release.role,
          sessionId: release.agentSessionId,
        });
      }

      // The moment the system declares that prompt dead: the task is going
      // back, so whatever was sent to this session will never be answered.
      // Leaving the entry open would make the agent unschedulable forever.
      closures.push({ agentSessionId: release.agentSessionId, taskId: release.taskId });

      if (agent && agent.activeTaskId === release.taskId) {
        agent.status = 'available';
        agent.activeTaskId = null;
        agent.attentionRequired = false;
        agent.operationalStatus = null;
        agent.operationalError = null;
        agent.note = `Released stale assignment for ${release.taskId}; available to retry.`;
        agent.lastSeenAt = utcNow();
        agent.watchdogEscalatedAt = agent.watchdogEscalatedAt || utcNow();
      }
    }
    state.tasksStore.updatedAt = utcNow();
    state.registry.updatedAt = utcNow();
  });

  for (const closure of closures) {
    runtimeStore.closeOpenPromptEntries(options, {
      ...closure,
      outcome: 'failed',
      reason: 'assignment released after the session became unrecoverable',
    });
  }
}

// The watchdog's own job, and now its only one: hand the task back when the
// session that owned it is not coming back. Whether it is coming back is the
// state machine's call, not a second timestamp heuristic living here.
async function reconcileOpencodeActivity(options = {}, dependencies = {}) {
  const sessionStateFor = typeof dependencies.sessionStateFor === 'function'
    ? dependencies.sessionStateFor
    : () => null;
  const now = Number.isFinite(dependencies.now) ? dependencies.now : Date.now();

  const snapshot = runtimeStore.readCoordinationState(options);
  const tasksById = new Map((snapshot.tasksStore.tasks || []).map((task) => [task.id, task]));
  const patches = [];
  const releases = [];

  for (const agent of snapshot.registry.agents || []) {
    if (!shouldInspectAgent(agent)) continue;
    const task = tasksById.get(agent.activeTaskId);
    if (!taskOwnedByAgent(task, agent)) continue;

    const runtime = sessionStateFor(agent) || {};
    const state = runtime.state || 'unknown';
    const droppedTurnAt = hasDroppedTurn(runtime) ? runtime.droppedTurnAt : null;
    const stalled = ABANDONED_STATES.has(state) || Boolean(droppedTurnAt);

    patches.push({
      agentSessionId: agent.sessionId,
      runtimeState: state,
      lastEventAt: runtime.lastEventAt || null,
      activityState: stalled ? 'stalled' : 'working',
      stalled,
      droppedTurnAt,
      taskId: task.id,
      at: new Date(now).toISOString(),
    });

    if (!stalled) continue;

    // First pass marks; the release only happens if it is still abandoned once
    // the grace period has passed.
    const stalledSinceMs = parseTimeMs(agent.stalledSinceAt);
    if (stalledSinceMs != null && (now - stalledSinceMs) >= getPolicy().releaseGraceMs) {
      releases.push({
        agentSessionId: agent.sessionId,
        agentName: agent.agentName,
        role: agent.role,
        taskId: task.id,
        droppedTurnAt,
        touchedFiles: Array.isArray(runtime.touchedFiles) ? runtime.touchedFiles : [],
      });
    }
  }

  applyActivityPatches(options, patches);
  releaseStalledAssignments(options, releases);

  return {
    inspected: patches.length,
    marked: patches.filter((patch) => patch.stalled).length,
    released: releases.length,
  };
}
module.exports = {
  reconcileOpencodeActivity,
};
