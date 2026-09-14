'use strict';

const path = require('path');
const coordinationCore = require('./coordination-core');
const runtimeStore = require('./runtime-store');
const taskGraphIntegrity = require('./task-graph-integrity');
const { getActiveProjectWorkspace } = require('../core/project-workspace');

function utcNow() {
  return new Date().toISOString();
}

function isPmPlanningTask(task) {
  return coordinationCore.normalizedTaskRole(task) === 'Project Manager';
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function addTaskNote(task, text, extra = {}) {
  if (!Array.isArray(task.notes)) task.notes = [];
  const last = task.notes[task.notes.length - 1];
  if (last && last.kind === 'daemon-reconcile' && last.text === text) {
    return false;
  }
  task.notes.push({
    kind: 'daemon-reconcile',
    text,
    createdAt: utcNow(),
    ...extra,
  });
  return true;
}

function pickNewestRun(current, candidate) {
  if (!current) return candidate;
  const currentMs = Date.parse(current.updatedAt || current.startedAt || 0);
  const candidateMs = Date.parse(candidate.updatedAt || candidate.startedAt || 0);
  return candidateMs >= currentMs ? candidate : current;
}

function buildLiveRunMap(runs) {
  const liveBySession = new Map();
  for (const run of runs || []) {
    if (run.status !== 'running') continue;
    if (!isPidAlive(run.workerPid)) continue;
    liveBySession.set(run.agentSessionId, pickNewestRun(liveBySession.get(run.agentSessionId), run));
  }
  return liveBySession;
}

function reconcileOrphanedRuns(state) {
  const now = utcNow();
  const taskMap = new Map((state.tasksStore.tasks || []).map((task) => [task.id, task]));
  const agentMap = new Map((state.registry.agents || []).map((agent) => [agent.sessionId, agent]));
  let changed = false;

  for (const run of state.runs || []) {
    if (run.status !== 'running') continue;
    if (isPidAlive(run.workerPid)) continue;

    run.status = 'orphaned';
    run.finishedAt = now;
    run.updatedAt = now;
    if (!run.stderr) {
      run.stderr = run.workerPid
        ? `Worker process ${run.workerPid} is no longer alive. Reconciled by runtime.`
        : 'Legacy running record had no workerPid metadata. Reconciled by runtime.';
    }
    changed = true;

    const task = taskMap.get(run.taskId);
    if (task && task.claim && task.claim.agentName === run.agentName && (task.status === 'CLAIMED' || task.status === 'IN_PROGRESS')) {
      task.status = 'BLOCKED';
      addTaskNote(task, `Daemon-managed run ${run.runId} ended unexpectedly and was reconciled as orphaned.`, {
        agentName: run.agentName,
        role: run.role || null,
        runId: run.runId,
      });
      changed = true;
    }

    const agent = agentMap.get(run.agentSessionId);
    if (agent && agent.executionMode === 'daemon') {
      if (agent.activeTaskId === run.taskId || agent.status === 'working') {
        agent.activeTaskId = null;
        agent.status = 'waiting';
        agent.note = 'Previous daemon-managed run ended unexpectedly.';
        agent.lastSeenAt = now;
        changed = true;
      }
    }
  }

  return changed;
}

function reconcileDaemonStatus(state) {
  if (!state.daemonStatus || !state.daemonStatus.running) return false;
  if (isPidAlive(state.daemonStatus.pid)) return false;

  state.daemonStatus = {
    ...state.daemonStatus,
    running: false,
    pid: null,
    intervalMs: null,
    lastError: state.daemonStatus.lastError || 'Daemon process is no longer alive.',
    updatedAt: utcNow(),
  };
  return true;
}

function reconcileDaemonRegistry(state, liveRunMap) {
  let changed = false;
  for (const agent of state.registry.agents || []) {
    if (agent.executionMode !== 'daemon') continue;

    const liveRun = liveRunMap.get(agent.sessionId);
    if (liveRun) {
      if (agent.status !== 'working' || agent.activeTaskId !== liveRun.taskId) {
        agent.status = 'working';
        agent.activeTaskId = liveRun.taskId || null;
        agent.note = '';
        changed = true;
      }
      continue;
    }

    if (agent.status === 'working' && !agent.activeTaskId) {
      agent.status = 'available';
      agent.note = '';
      changed = true;
    }
  }
  return changed;
}

function reconcileManualRegistry(state) {
  const now = utcNow();
  const taskMap = new Map((state.tasksStore.tasks || []).map((task) => [task.id, task]));
  const keptAgents = [];
  let changed = false;

  for (const agent of state.registry.agents || []) {
    if (agent.executionMode !== 'manual' || !Number.isInteger(agent.terminalPid)) {
      keptAgents.push(agent);
      continue;
    }

    if (isPidAlive(agent.terminalPid)) {
      if (agent.status === 'attention') {
        keptAgents.push(agent);
        continue;
      }

      const task = agent.activeTaskId ? taskMap.get(agent.activeTaskId) : null;
      if (!task || coordinationCore.FINISHED_STATUSES.has(task.status)) {
        if (agent.activeTaskId || agent.status !== 'available') {
          agent.activeTaskId = null;
          agent.status = 'available';
          agent.note = 'Available for next task';
          agent.lastSeenAt = now;
          changed = true;
        }
      } else if (coordinationCore.currentWorkflowActorRole(task) !== agent.role) {
        agent.activeTaskId = null;
        agent.status = 'available';
        agent.note = 'Available for next task';
        agent.lastSeenAt = now;
        changed = true;
      }
      keptAgents.push(agent);
      continue;
    }

    changed = true;
    const task = agent.activeTaskId ? taskMap.get(agent.activeTaskId) : null;
    if (
      task
      && task.claim
      && task.claim.agentName === agent.agentName
      && task.claim.role === agent.role
      && (task.status === 'CLAIMED' || task.status === 'IN_PROGRESS')
    ) {
      task.status = 'BLOCKED';
      addTaskNote(task, `Manual session ${agent.agentName} lost its terminal and was removed from the active registry.`, {
        agentName: agent.agentName,
        role: agent.role,
        sessionId: agent.sessionId || null,
      });
    }

    if (task && task.status === 'BLOCKED' && !task.attentionType && !isPmPlanningTask(task)) {
      task.attentionType = 'implementation_help';
    }
  }

  if (changed) {
    state.registry.agents = keptAgents;
    state.registry.updatedAt = now;
    state.tasksStore.updatedAt = now;
  }

  return changed;
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function projectRootFromState(state) {
  if (state && state.paths && state.paths.projectRoot) {
    return state.paths.projectRoot;
  }

  if (state && state.paths && state.paths.tasksPath) {
    const coordinationDir = path.dirname(state.paths.tasksPath);
    const officeDir = path.dirname(coordinationDir);
    return path.dirname(officeDir);
  }

  return getActiveProjectWorkspace().projectRoot;
}

function reconcileWrongWorkspaceAgents(state) {
  const projectRoot = projectRootFromState(state);
  const agents = state.registry.agents || [];
  const keptAgents = [];
  let changed = false;

  for (const agent of agents) {
    if (!agent.workspacePath || samePath(agent.workspacePath, projectRoot)) {
      keptAgents.push(agent);
      continue;
    }

    if (Number.isInteger(agent.terminalPid) && isPidAlive(agent.terminalPid)) {
      agent.status = 'attention';
      agent.activeTaskId = null;
      agent.note = `Live terminal is attached to ${agent.workspacePath}, but this project is ${projectRoot}.`;
      agent.lastSeenAt = utcNow();
      keptAgents.push(agent);
      changed = true;
      continue;
    }

    changed = true;
  }

  if (!changed) return false;

  state.registry.agents = keptAgents;
  state.registry.updatedAt = utcNow();
  return true;
}

function reconcileReviewsWaitingOnFollowUps(state) {
  const now = utcNow();
  const agents = state.registry.agents || [];
  let changed = false;

  for (const task of state.tasksStore.tasks || []) {
    if (task.status !== 'DONE' && task.status !== 'REVIEW_NEEDED') continue;
    const pendingFollowUp = coordinationCore.pendingFollowUpTask(task, state.tasksStore);
    if (!pendingFollowUp || !task.reviewClaim) continue;

    const reviewClaim = task.reviewClaim;
    task.reviewClaim = null;
    coordinationCore.setWorkflowState(task, 'follow_up_wait', null, null);
    addTaskNote(task, `Review claim released while waiting for follow-up ${pendingFollowUp.id}.`, {
      agentName: reviewClaim.agentName || null,
      role: reviewClaim.role || null,
      followUpTaskId: pendingFollowUp.id,
    });
    changed = true;

    const agent = agents.find((entry) => (
      (reviewClaim.sessionId && entry.sessionId === reviewClaim.sessionId)
      || (
        entry.agentName === reviewClaim.agentName
        && entry.role === reviewClaim.role
      )
    ));
    if (agent && agent.activeTaskId === task.id) {
      agent.activeTaskId = null;
      agent.status = 'available';
      agent.note = `Available for follow-up ${pendingFollowUp.id}.`;
      agent.lastSeenAt = now;
      changed = true;
    }
  }

  if (changed) {
    state.registry.updatedAt = now;
    state.tasksStore.updatedAt = now;
  }

  return changed;
}

function childTasks(task, store) {
  if (!task) return [];
  return (store.tasks || []).filter((candidate) => candidate.parentId === task.id);
}

function releaseAgentFromTask(registry, task, note) {
  for (const agent of registry.agents || []) {
    const ownsBySession = task.workflow
      && task.workflow.currentActorSessionId
      && agent.sessionId === task.workflow.currentActorSessionId;
    const ownsByClaim = task.claim
      && agent.agentName === task.claim.agentName
      && agent.role === task.claim.role;
    if (agent.activeTaskId !== task.id && !ownsBySession && !ownsByClaim) continue;
    agent.activeTaskId = null;
    agent.status = 'available';
    agent.note = note;
    agent.lastSeenAt = utcNow();
  }
}

function reconcileStaleDispatchReservations(state) {
  const now = utcNow();
  const nowMs = Date.parse(now);
  let changed = false;
  const staleAfterMs = 45 * 1000;

  for (const task of state.tasksStore.tasks || []) {
    if (task.status !== 'CLAIMED') continue;
    const claimedAtMs = task.claim && task.claim.claimedAt ? Date.parse(task.claim.claimedAt) : null;
    if (!Number.isFinite(claimedAtMs) || nowMs - claimedAtMs < staleAfterMs) continue;

    const agent = (state.registry.agents || []).find((entry) => (
      task.workflow
      && task.workflow.currentActorSessionId
      && entry.sessionId === task.workflow.currentActorSessionId
    )) || (state.registry.agents || []).find((entry) => (
      task.claim
      && entry.agentName === task.claim.agentName
      && entry.role === task.claim.role
    ));

    if (agent && agent.activeTaskId === task.id && agent.lastPromptSentAt) continue;

    const ownerName = task.claim && task.claim.agentName ? task.claim.agentName : 'unknown agent';
    task.status = 'TODO';
    task.claim = null;
    task.attentionType = null;
    coordinationCore.setWorkflowState(
      task,
      coordinationCore.normalizedTaskRole(task) === 'Project Manager' ? 'pm_planning' : 'implementation_queue',
      coordinationCore.normalizedTaskRole(task),
      null
    );
    addTaskNote(task, `Released stale dispatch reservation for ${ownerName}; prompt delivery was not confirmed.`, {
      kind: 'stale-dispatch-reservation',
    });

    if (agent && agent.activeTaskId === task.id) {
      agent.activeTaskId = null;
      agent.status = 'attention';
      agent.attentionRequired = true;
      agent.operationalStatus = 'error';
      agent.operationalError = `Prompt delivery for ${task.id} was not confirmed.`;
      agent.note = `Prompt delivery for ${task.id} was not confirmed; task returned to queue.`;
      agent.lastSeenAt = now;
    }

    changed = true;
  }

  if (changed) {
    state.tasksStore.updatedAt = now;
    state.registry.updatedAt = now;
  }

  return changed;
}

function reconcileImplementationTrackingParents(state) {
  const now = utcNow();
  let changed = false;

  for (const task of state.tasksStore.tasks || []) {
    const children = childTasks(task, state.tasksStore);
    if (children.length === 0) continue;
    if (isPmPlanningTask(task)) continue;
    if (coordinationCore.FINISHED_STATUSES.has(task.status)) continue;

    const unfinishedChildren = children.filter((child) => !coordinationCore.FINISHED_STATUSES.has(child.status));
    if (unfinishedChildren.length > 0) {
      if (task.status === 'CLAIMED' || task.status === 'IN_PROGRESS' || task.claim) {
        task.status = 'TODO';
        task.attentionType = null;
        task.claim = null;
        task.reviewClaim = null;
        coordinationCore.setWorkflowState(task, 'implementation_queue', coordinationCore.normalizedTaskRole(task), null);
        addTaskNote(task, `Released tracking parent claim. Open subtasks remain: ${unfinishedChildren.map((child) => child.id).join(', ')}.`, {
          createdAt: now,
        });
        releaseAgentFromTask(state.registry, task, 'Tracking parent released; open subtasks remain.');
        changed = true;
      }
      continue;
    }

    if (task.status === 'TODO' || task.status === 'CLAIMED' || task.status === 'IN_PROGRESS' || task.status === 'BLOCKED' || task.claim) {
      task.status = 'REVIEW_NEEDED';
      task.attentionType = 'senior_closure';
      task.claim = null;
      task.reviewClaim = null;
      coordinationCore.setWorkflowState(task, 'senior_review', 'Senior Pro', null);
      addTaskNote(task, 'All subtasks are finished. Tracking parent moved to Senior Pro review.', {
        createdAt: now,
      });
      releaseAgentFromTask(state.registry, task, 'Tracking parent moved to Senior Pro review.');
      changed = true;
    }
  }

  if (changed) {
    state.tasksStore.updatedAt = now;
    state.registry.updatedAt = now;
  }

  return changed;
}

function reconcileSupersededReviews(state) {
  let changed = false;
  const entries = coordinationCore.supersededByFollowUpTasks(state.tasksStore);

  for (const { task, followUpTask } of entries) {
    if (!task || !followUpTask) continue;
    if (task.status === 'ARCHIVED' || task.status === 'CANCELLED') continue;

    task.status = 'ARCHIVED';
    task.attentionType = null;
    task.reviewClaim = null;
    coordinationCore.setWorkflowState(task, 'closed', null, null);
    addTaskNote(task, `Task archived because it was superseded by follow-up ${followUpTask.id}. Review ${followUpTask.id} instead.`, {
      kind: 'superseded-archive',
      followUpTaskId: followUpTask.id,
      followUpStatus: followUpTask.status || null,
    });
    changed = true;
  }

  if (changed) {
    state.tasksStore.updatedAt = utcNow();
  }

  return changed;
}

function reconcileSnapshot(state) {
  let changed = false;
  changed = taskGraphIntegrity.normalizeTaskGraph(state.tasksStore) || changed;
  changed = reconcileOrphanedRuns(state) || changed;
  changed = reconcileDaemonStatus(state) || changed;
  changed = reconcileReviewsWaitingOnFollowUps(state) || changed;
  changed = reconcileStaleDispatchReservations(state) || changed;
  changed = reconcileImplementationTrackingParents(state) || changed;
  changed = reconcileSupersededReviews(state) || changed;
  changed = reconcileWrongWorkspaceAgents(state) || changed;
  const liveRunMap = buildLiveRunMap(state.runs || []);
  changed = reconcileDaemonRegistry(state, liveRunMap) || changed;
  changed = reconcileManualRegistry(state) || changed;
  return {
    changed,
    liveRunMap,
  };
}

function reconcileCoordination(options = {}) {
  // Dry run first, on the state as read. mutateCoordination takes
  // runtime.db.lock and rewrites all three JSON mirrors whether or not anything
  // changed, and this runs on every world-tick pass: doing that when the
  // reconciliation is a no-op is pure lock contention against the daemon.
  //
  // The probe reads with runLimit null so it sees exactly the state
  // mutateCoordination would build. reconcileSnapshot mutates the copy it is
  // given, which is a throwaway object, and the real pass re-runs it under the
  // lock, so a state change racing between the two is still handled correctly.
  const probeState = runtimeStore.readCoordinationState({ ...options, runLimit: null });
  const probe = reconcileSnapshot(probeState);
  if (!probe.changed) {
    return {
      changed: false,
      daemonStatus: probeState.daemonStatus,
      runCount: (probeState.runs || []).length,
    };
  }

  return runtimeStore.mutateCoordination(options, (state) => {
    const result = reconcileSnapshot(state);
    return {
      changed: result.changed,
      daemonStatus: state.daemonStatus,
      runCount: (state.runs || []).length,
    };
  });
}

module.exports = {
  isPidAlive,
  buildLiveRunMap,
  projectRootFromState,
  reconcileSnapshot,
  reconcileCoordination,
};
