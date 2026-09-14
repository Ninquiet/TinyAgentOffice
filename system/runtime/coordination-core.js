'use strict';

const ROLE_ALIASES = {
  pm: 'Project Manager',
  sp: 'Senior Pro',
  ss: 'Semi Senior',
  jr: 'Junior',
};

const ROLE_ACRONYMS = {
  'Project Manager': 'PM',
  'Senior Pro': 'SP',
  'Semi Senior': 'SS',
  Junior: 'Jr',
};

const ROLE_RANK = {
  Junior: 0,
  'Semi Senior': 1,
  'Senior Pro': 2,
};

const ROLES = ['Project Manager', 'Senior Pro', 'Semi Senior', 'Junior'];

const VALID_ROLES = new Set(Object.keys(ROLE_ACRONYMS));
const VALID_TASK_STATUSES = new Set([
  'TODO',
  'CLAIMED',
  'IN_PROGRESS',
  'BLOCKED',
  'REVIEW_NEEDED',
  'DONE',
  'PM_REVIEWED',
  'CONTEXT_UPDATED',
  'ARCHIVED',
  'CANCELLED',
]);

const SATISFIED_STATUSES = new Set([
  'DONE',
  'PM_REVIEWED',
  'CONTEXT_UPDATED',
  'ARCHIVED',
]);

const FINISHED_STATUSES = new Set([
  'DONE',
  'PM_REVIEWED',
  'CONTEXT_UPDATED',
  'ARCHIVED',
  'CANCELLED',
]);

function normalizeRole(role) {
  if (!role) return null;
  const alias = ROLE_ALIASES[String(role).toLowerCase()];
  const normalized = alias || role;
  return VALID_ROLES.has(normalized) ? normalized : null;
}

function requireRole(role) {
  const normalized = normalizeRole(role);
  if (!normalized) throw new Error(`Unknown role: ${role}`);
  return normalized;
}

function implementationRank(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, role) ? ROLE_RANK[role] : null;
}

function allTasks(store) {
  return [
    ...(store.tasks || []),
    ...(store.nextTodo || []),
    ...(store.history || []),
  ];
}

function activeTasks(store) {
  return store.tasks || [];
}

function buildTaskMap(store) {
  return new Map(allTasks(store).map((task) => [task.id, task]));
}

function normalizedTaskRole(task) {
  return normalizeRole(task.recommendedRole) || task.recommendedRole || null;
}

function nextHigherImplementationRole(role) {
  if (role === 'Junior') return 'Semi Senior';
  if (role === 'Semi Senior') return 'Senior Pro';
  if (role === 'Senior Pro') return 'Senior Pro';
  return 'Project Manager';
}

function workflowRoleForTask(task) {
  const recommendedRole = normalizedTaskRole(task);
  return recommendedRole || null;
}

function deriveWorkflowState(task) {
  const recommendedRole = workflowRoleForTask(task);
  if (!task) {
    return {
      step: 'idle',
      currentActorRole: null,
      currentActorSessionId: null,
    };
  }

  if (task.workflow && typeof task.workflow === 'object') {
    return {
      step: task.workflow.step || 'idle',
      currentActorRole: task.workflow.currentActorRole || null,
      currentActorSessionId: task.workflow.currentActorSessionId || null,
    };
  }

  if (task.status === 'TODO') {
    return {
      step: recommendedRole === 'Project Manager' ? 'pm_planning' : 'implementation_queue',
      currentActorRole: recommendedRole,
      currentActorSessionId: null,
    };
  }

  if (task.status === 'CLAIMED' || task.status === 'IN_PROGRESS') {
    return {
      step: 'implementation',
      currentActorRole: task.claim && task.claim.role ? task.claim.role : recommendedRole,
      currentActorSessionId: null,
    };
  }

  if (task.status === 'BLOCKED') {
    return {
      step: task.attentionType === 'implementation_help' ? 'implementation_help' : 'blocked',
      currentActorRole: task.attentionType === 'implementation_help'
        ? nextHigherImplementationRole(task.claim && task.claim.role ? task.claim.role : recommendedRole)
        : (task.claim && task.claim.role ? task.claim.role : recommendedRole),
      currentActorSessionId: null,
    };
  }

  if (task.status === 'REVIEW_NEEDED') {
    if (task.attentionType === 'senior_closure') {
      return {
        step: 'senior_review',
        currentActorRole: 'Senior Pro',
        currentActorSessionId: task.reviewClaim && task.reviewClaim.sessionId ? task.reviewClaim.sessionId : null,
      };
    }
    return {
      step: 'review',
      currentActorRole: recommendedRole,
      currentActorSessionId: null,
    };
  }

  if (task.status === 'DONE') {
    return {
      step: 'user_review',
      currentActorRole: 'User',
      currentActorSessionId: null,
    };
  }

  if (task.status === 'PM_REVIEWED' || task.status === 'CONTEXT_UPDATED') {
    return {
      step: 'pm_closeout',
      currentActorRole: 'Project Manager',
      currentActorSessionId: null,
    };
  }

  if (task.status === 'ARCHIVED' || task.status === 'CANCELLED') {
    return {
      step: 'closed',
      currentActorRole: null,
      currentActorSessionId: null,
    };
  }

  return {
    step: 'idle',
    currentActorRole: null,
    currentActorSessionId: null,
  };
}

function currentWorkflowActorRole(task) {
  return deriveWorkflowState(task).currentActorRole;
}

function currentWorkflowStep(task) {
  return deriveWorkflowState(task).step;
}

function setWorkflowState(task, step, currentActorRole, currentActorSessionId = null) {
  if (!task || typeof task !== 'object') return;
  task.workflow = {
    step,
    currentActorRole: currentActorRole || null,
    currentActorSessionId: currentActorSessionId || null,
  };
}

function isSeniorReviewTask(task) {
  return Boolean(
    task
    && task.status === 'REVIEW_NEEDED'
    && task.attentionType === 'senior_closure'
    && (
      normalizedTaskRole(task) !== 'Project Manager'
      || (task.workflow && task.workflow.currentActorRole === 'Senior Pro')
      || (task.reviewClaim && task.reviewClaim.role === 'Senior Pro')
    )
  );
}

function latestTaskNote(task, kind) {
  if (!task || !Array.isArray(task.notes)) return null;
  for (let index = task.notes.length - 1; index >= 0; index -= 1) {
    const note = task.notes[index];
    if (note && note.kind === kind) return note;
  }
  return null;
}

function taskSource(task) {
  return task && task.source && typeof task.source === 'object' ? task.source : null;
}

function isUserDeclineFollowUpTask(task) {
  const source = taskSource(task);
  return Boolean(source && source.kind === 'user-decline-follow-up' && source.sourceTaskId);
}

function userDeclineRecord(task) {
  return task && task.userReview && task.userReview.state === 'declined'
    ? task.userReview
    : null;
}

function hasUserDecline(task) {
  if (userDeclineRecord(task)) return true;
  return Array.isArray(task && task.notes)
    && task.notes.some((note) => note && note.kind === 'user-decline');
}

function followUpTaskForDeclinedTask(task, store) {
  const decline = userDeclineRecord(task);
  if (!decline || !decline.followUpTaskId) return null;
  const map = buildTaskMap(store);
  return map.get(decline.followUpTaskId) || null;
}

function latestChildFollowUpTask(task, store) {
  const children = childTasks(task, store).filter((child) => child.status !== 'CANCELLED');
  if (children.length === 0) return null;
  children.sort((a, b) => sortClaimable(b, a));
  return children[0] || null;
}

function supersedingFollowUpTask(task, store) {
  if (!hasUserDecline(task)) return null;
  return followUpTaskForDeclinedTask(task, store) || latestChildFollowUpTask(task, store);
}

function hasSupersedingFollowUp(task, store) {
  return Boolean(supersedingFollowUpTask(task, store));
}

function pendingFollowUpTask(task, store) {
  const explicitFollowUp = followUpTaskForDeclinedTask(task, store);
  if (explicitFollowUp && !FINISHED_STATUSES.has(explicitFollowUp.status)) {
    return explicitFollowUp;
  }
  const pendingChild = childTasks(task, store).find((child) => !FINISHED_STATUSES.has(child.status));
  return pendingChild || null;
}

function hasPendingFollowUp(task, store) {
  return Boolean(pendingFollowUpTask(task, store));
}

function childTasks(task, store) {
  if (!task) return [];
  return activeTasks(store).filter((candidate) => candidate.parentId === task.id);
}

function isPmBatchParentTask(task, store) {
  return Boolean(
    task
    && normalizedTaskRole(task) === 'Project Manager'
    && task.type === 'task'
    && childTasks(task, store).length > 0
  );
}

function allChildTasksFinished(task, store) {
  const children = childTasks(task, store);
  return children.length > 0 && children.every((child) => FINISHED_STATUSES.has(child.status));
}

function isPmBatchReadyForSeniorReview(task, store) {
  return Boolean(
    isPmBatchParentTask(task, store)
    && task.status === 'REVIEW_NEEDED'
    && allChildTasksFinished(task, store)
    && !task.reviewedBy
  );
}

function isPmBatchAwaitingUserReview(task, store) {
  return Boolean(
    isPmBatchParentTask(task, store)
    && task.status === 'DONE'
    && task.reviewedBy
  );
}

function isPmBatchReadyForCloseout(task, store) {
  return Boolean(
    isPmBatchParentTask(task, store)
    && task.status === 'PM_REVIEWED'
  );
}

function hasOpenSubtasks(task, tasks) {
  return tasks.some((candidate) => (
    candidate.parentId === task.id && !FINISHED_STATUSES.has(candidate.status)
  ));
}

function hasSubtasks(task, store) {
  return childTasks(task, store).length > 0;
}

function sortClaimable(a, b) {
  if (a.type === 'subtask' && b.type !== 'subtask') return -1;
  if (a.type !== 'subtask' && b.type === 'subtask') return 1;
  const aPriority = a.priority === 'High' ? 0 : a.priority === 'Medium' ? 1 : 2;
  const bPriority = b.priority === 'High' ? 0 : b.priority === 'Medium' ? 1 : 2;
  if (aPriority !== bPriority) return aPriority - bPriority;
  return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
}

function evaluateStructuredTask(task, role, store) {
  const reasons = [];
  const tasks = activeTasks(store);
  const map = buildTaskMap(store);
  const recommendedRole = normalizedTaskRole(task);
  if (recommendedRole && task.recommendedRole !== recommendedRole) {
    task.recommendedRole = recommendedRole;
  }

  if (!VALID_TASK_STATUSES.has(task.status)) {
    reasons.push(`Unknown status "${task.status}". Manual review required.`);
    return { claimable: false, reasons };
  }

  if ((task.status === 'DONE' || task.status === 'REVIEW_NEEDED') && hasPendingFollowUp(task, store)) {
    const followUpTask = pendingFollowUpTask(task, store);
    reasons.push(`Waiting for follow-up ${followUpTask ? followUpTask.id : 'task'} before this task can continue.`);
    return { claimable: false, reasons };
  }

  if (role === 'Senior Pro' && isSeniorReviewTask(task)) {
    if (task.reviewClaim && task.reviewClaim.agentName) {
      reasons.push(`Already under Senior Pro review by ${task.reviewClaim.agentName}.`);
      return { claimable: false, reasons };
    }
    reasons.push('Awaiting Senior Pro review approval.');
    return { claimable: true, reasons, isSeniorReview: true };
  }

  if (role === 'Senior Pro' && isPmBatchReadyForSeniorReview(task, store)) {
    if (task.reviewClaim && task.reviewClaim.agentName) {
      reasons.push(`Already under Senior Pro final review by ${task.reviewClaim.agentName}.`);
      return { claimable: false, reasons };
    }
    reasons.push('All implementation subtasks are complete. Awaiting Senior Pro final batch review.');
    return { claimable: true, reasons, isSeniorReview: true, isPmBatchReview: true };
  }

  if (role === 'Project Manager' && isPmBatchReadyForCloseout(task, store)) {
    reasons.push('User approved. Ready for PM administrative closeout.');
    return { claimable: true, reasons, isPmCloseout: true };
  }

  if (task.status !== 'TODO') {
    reasons.push(`Status is ${task.status}, not TODO.`);
    return { claimable: false, reasons };
  }

  if (task.type === 'task' && hasSubtasks(task, store)) {
    if (hasOpenSubtasks(task, tasks)) {
      reasons.push('Open subtasks exist. Claim the unlocked subtask instead.');
    } else {
      reasons.push('Tracking parent is complete at subtask level. It must move through Senior Pro review.');
    }
    return { claimable: false, reasons };
  }

  if (!recommendedRole) {
    reasons.push('No recommended role specified. Manual review required.');
    return { claimable: false, reasons };
  }

  if (!VALID_ROLES.has(recommendedRole)) {
    reasons.push(`Unknown recommended role "${task.recommendedRole}". Manual review required.`);
    return { claimable: false, reasons };
  }

  const requestedRank = implementationRank(role);
  const recommendedRank = implementationRank(recommendedRole);
  if (requestedRank === null || recommendedRank === null) {
    reasons.push(`${role} is not an implementation role.`);
    return { claimable: false, reasons };
  }

  if (role === 'Junior' && recommendedRole !== 'Junior') {
    reasons.push(`Recommended role is ${recommendedRole} - above Junior.`);
    return { claimable: false, reasons };
  }

  if (role === 'Semi Senior' && recommendedRank > requestedRank) {
    reasons.push(`Recommended role is ${recommendedRole} - above Semi Senior.`);
    return { claimable: false, reasons };
  }

  let lowerRole = false;
  if (recommendedRank < requestedRank) {
    if (role === 'Senior Pro') {
      lowerRole = true;
    } else if (role !== 'Semi Senior') {
      reasons.push(`Recommended role "${recommendedRole}" does not match "${role}".`);
      return { claimable: false, reasons };
    }
  } else if (recommendedRole !== role) {
    reasons.push(`Recommended role "${recommendedRole}" does not match "${role}".`);
    return { claimable: false, reasons };
  }

  for (const prereqId of task.prerequisites || []) {
    const prerequisite = map.get(prereqId);
    if (!prerequisite) {
      reasons.push(`Prerequisite ${prereqId} was not found.`);
    } else if (prerequisite.status === 'CANCELLED') {
      reasons.push(`Prerequisite ${prereqId} is CANCELLED and needs PM clarification.`);
    } else if (!SATISFIED_STATUSES.has(prerequisite.status)) {
      reasons.push(`Prerequisite ${prereqId} is ${prerequisite.status}.`);
    }
  }

  if (reasons.length > 0) return { claimable: false, reasons };

  if (lowerRole) {
    reasons.push('Available with role override - explicit user clearance recommended.');
  } else {
    reasons.push('Role matches and all prerequisites are satisfied.');
  }

  return { claimable: true, reasons, lowerRole };
}

function closestRelevance(task, role) {
  let score = 0;
  if (task.recommendedRole === role) score += 100;
  if (!FINISHED_STATUSES.has(task.status)) score += 60;
  if ((task.reasons || []).some((reason) => reason.includes('Open subtasks'))) score += 30;
  if ((task.reasons || []).some((reason) => reason.includes('Prerequisite'))) score += 20;
  if (task.status === 'IN_PROGRESS') score += 10;
  if (task.status === 'CLAIMED') score += 5;
  return score;
}

function closestUnavailable(unavailable, role) {
  return unavailable
    .filter((task) => !FINISHED_STATUSES.has(task.status))
    .map((task) => ({ task, score: closestRelevance(task, role) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => entry.task);
}

function queryEntry(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    attentionType: task.attentionType || null,
    type: task.type,
    parentId: task.parentId || null,
    recommendedRole: task.recommendedRole || null,
    priority: task.priority || null,
    prerequisites: task.prerequisites || [],
    contextHints: task.contextHints || [],
    contextProposal: task.contextProposal || null,
    reasons: task.reasons || [],
  };
}

function tasksByAttention(tasksStore, status, attentionType) {
  return activeTasks(tasksStore)
    .filter((task) => task.status === status && (task.attentionType || null) === attentionType)
    .sort(sortClaimable);
}

function visibleNextTodo(tasksStore) {
  return (tasksStore.nextTodo || []).filter((task) => task.status === 'TODO');
}

function activeTaskStatusReason(task, store) {
  if (task.status === 'TODO') {
    if (task.type === 'task' && hasSubtasks(task, store)) {
      if (hasOpenSubtasks(task, activeTasks(store))) {
        return 'Tracking task. Work its open subtasks first.';
      }
      return 'Tracking task. Waiting for Senior Pro review of completed subtasks.';
    }
    const role = normalizedTaskRole(task);
    return role ? `Waiting for ${role}.` : 'Waiting for role assignment.';
  }
  if (task.status === 'CLAIMED' || task.status === 'IN_PROGRESS') {
    return task.claim && task.claim.agentName
      ? `Claimed by ${task.claim.agentName}.`
      : 'Claimed by an agent.';
  }
  if (task.status === 'BLOCKED') {
    return task.blockedReason || task.reason || 'Blocked.';
  }
  if (task.status === 'REVIEW_NEEDED') {
    const role = currentWorkflowActorRole(task);
    return role ? `Waiting for ${role} review.` : 'Waiting for review.';
  }
  return task.reason || '';
}

function activeTaskQueue(tasksStore) {
  return activeTasks(tasksStore)
    .filter((task) => !FINISHED_STATUSES.has(task.status))
    .map((task) => ({
      id: task.id,
      title: task.title,
      claimableRole: currentWorkflowActorRole(task) || normalizedTaskRole(task) || null,
      recommendedRole: task.recommendedRole || null,
      priority: task.priority || null,
      status: task.status,
      attentionType: task.attentionType || null,
      followUpTaskId: task.userReview && task.userReview.followUpTaskId ? task.userReview.followUpTaskId : null,
      reason: activeTaskStatusReason(task, tasksStore),
      parentId: task.parentId || null,
      claim: task.claim || null,
      createdByAgentName: task.createdByAgentName || null,
      createdByRole: task.createdByRole || null,
      createdBySessionId: task.createdBySessionId || null,
      contextHints: task.contextHints || [],
      contextProposal: task.contextProposal || null,
    }))
    .sort(sortClaimable);
}

function queryPmTasks(store) {
  const tasks = activeTasks(store);
  const map = buildTaskMap(store);
  const claimable = [];
  const unavailable = [];

  for (const task of tasks) {
    const reasons = [];
    const recommendedRole = normalizedTaskRole(task);
    if (recommendedRole !== 'Project Manager') continue;
    if (currentWorkflowActorRole(task) && currentWorkflowActorRole(task) !== 'Project Manager') {
      reasons.push(`Waiting for ${currentWorkflowActorRole(task)}.`);
    }

    if (!VALID_TASK_STATUSES.has(task.status)) {
      reasons.push(`Unknown status "${task.status}". Manual review required.`);
    } else if (task.status !== 'TODO') {
      reasons.push(`Status is ${task.status}, not TODO.`);
    }

    if (task.type === 'task' && hasOpenSubtasks(task, tasks)) {
      reasons.push('Open subtasks exist. Claim the unlocked subtask instead.');
    }

    for (const prereqId of task.prerequisites || []) {
      const prerequisite = map.get(prereqId);
      if (!prerequisite) {
        reasons.push(`Prerequisite ${prereqId} was not found.`);
      } else if (prerequisite.status === 'CANCELLED') {
        reasons.push(`Prerequisite ${prereqId} is CANCELLED and needs PM clarification.`);
      } else if (!SATISFIED_STATUSES.has(prerequisite.status)) {
        reasons.push(`Prerequisite ${prereqId} is ${prerequisite.status}.`);
      }
    }

    const entry = { ...task, reasons };
    if (reasons.length === 0) {
      entry.reasons = ['Ready for PM planning work.'];
      claimable.push(entry);
    } else {
      unavailable.push(entry);
    }
  }

  claimable.sort(sortClaimable);
  unavailable.sort(sortClaimable);
  return { claimable, unavailable };
}

function claimableTasksForRole(store, role) {
  return role === 'Project Manager'
    ? queryPmTasks(store).claimable
    : queryTasksForRole(store, role, {}).claimable;
}

function queryTasksForRole(store, role, options = {}) {
  const claimable = [];
  const availableWithOverride = [];
  const unavailable = [];

  for (const task of activeTasks(store)) {
    const result = evaluateStructuredTask(task, role, store);
    const entry = { ...task, reasons: result.reasons, isSeniorReview: Boolean(result.isSeniorReview) };
    if (result.claimable && result.lowerRole) {
      availableWithOverride.push(entry);
    } else if (result.claimable) {
      claimable.push(entry);
    } else {
      unavailable.push(entry);
    }
  }

  claimable.sort((a, b) => {
    if (a.isSeniorReview && !b.isSeniorReview) return -1;
    if (!a.isSeniorReview && b.isSeniorReview) return 1;
    return sortClaimable(a, b);
  });
  availableWithOverride.sort(sortClaimable);

  return {
    claimable,
    availableWithOverride,
    unavailable: options.explainAll ? unavailable : closestUnavailable(unavailable, role),
    nextTodo: options.includeNext
      ? visibleNextTodo(store).map((task) => ({
          ...task,
          reasons: ['Not active. PM must promote before it can be claimed.'],
        }))
      : [],
  };
}

function chooseAssignableTask(store, role) {
  const claimable = [];
  for (const task of activeTasks(store)) {
    const result = evaluateStructuredTask(task, role, store);
    if (result.claimable && !result.lowerRole) {
      claimable.push({ task, isSeniorReview: Boolean(result.isSeniorReview) });
    }
  }
  claimable.sort((a, b) => {
    if (a.isSeniorReview && !b.isSeniorReview) return -1;
    if (!a.isSeniorReview && b.isSeniorReview) return 1;
    return sortClaimable(a.task, b.task);
  });
  return claimable[0] ? claimable[0].task : null;
}

function reconcileRegistryWithTasks(tasksStore, registry) {
  const tasks = activeTasks(tasksStore);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const reconciled = JSON.parse(JSON.stringify(registry || { agents: [] }));

  for (const agent of reconciled.agents || []) {
    if (!agent.activeTaskId) continue;
    const task = taskMap.get(agent.activeTaskId);

    if (!task || FINISHED_STATUSES.has(task.status)) {
      agent.activeTaskId = null;
      agent.status = 'available';
      agent.availableForWork = true;
      agent.attentionRequest = null;
    } else if (hasStaleLifecycleState(task)) {
      agent.activeTaskId = null;
      agent.status = 'waiting';
      agent.availableForWork = true;
      agent.attentionRequest = null;
      agent.note = 'Task state is stale and needs cleanup';
    } else if (task.status === 'BLOCKED') {
      if (agent.status !== 'attention') agent.status = 'blocked';
      agent.availableForWork = false;
    } else if (task.status === 'CLAIMED' || task.status === 'IN_PROGRESS') {
      if (currentWorkflowActorRole(task) !== agent.role) {
        agent.activeTaskId = null;
        agent.status = 'available';
        agent.availableForWork = true;
      } else if (agent.status !== 'attention') {
        agent.status = 'working';
        agent.availableForWork = false;
      }
    } else if (task.status === 'REVIEW_NEEDED') {
      if (hasPendingFollowUp(task, tasksStore)) {
        agent.activeTaskId = null;
        agent.status = 'available';
        agent.availableForWork = true;
        agent.note = 'Available while parent task waits on follow-up.';
      } else if (currentWorkflowActorRole(task) !== agent.role) {
        agent.activeTaskId = null;
        agent.status = 'available';
        agent.availableForWork = true;
      } else if (agent.status !== 'attention') {
        agent.status = 'working';
        agent.availableForWork = false;
      }
    }
  }

  return reconciled;
}

function hasOwnedReviewTask(agent, tasksStore) {
  return activeTasks(tasksStore).some((task) => (
    task.status === 'REVIEW_NEEDED'
    && currentWorkflowActorRole(task) === agent.role
    && task.reviewClaim
    && task.reviewClaim.agentName === agent.agentName
    && task.reviewClaim.role === agent.role
  ));
}

function hasStaleLifecycleState(task) {
  return Boolean(
    task
    && (task.status === 'CLAIMED' || task.status === 'IN_PROGRESS')
    && task.completedBy
    && task.completedAt
  );
}

// The runtime's verdict on whether this agent is working, as published by the
// watchdog from the state machine.
//
// This used to be computed here instead, from message timestamps and a five
// minute window, while the watchdog decided the same thing from OpenCode's
// events. Two definitions of stalled that disagreed: observed live on Copper
// Circuit, where the screen said STALLED for an hour and a half while the
// registry said working -- and the half that could act was the half that saw
// nothing wrong.
//
// No verdict yet is not the same as working. An agent whose session has never
// been inspected is `assigned`: it holds a task and nothing has confirmed what
// it is doing.
function executionActivityState(agent) {
  if (!agent || typeof agent !== 'object') return 'assigned';
  const published = agent.activityState;
  return published === 'working' || published === 'stalled' ? published : 'assigned';
}

function findActiveTaskForAgent(agent, tasksStore) {
  if (!agent || !agent.activeTaskId) return null;
  return activeTasks(tasksStore).find((task) => task.id === agent.activeTaskId) || null;
}

function isPmTrackingTask(task) {
  return Boolean(
    task
    && normalizedTaskRole(task) === 'Project Manager'
    && task.type === 'task'
  );
}

function pmTrackingNote(task, tasksStore) {
  const children = activeTasks(tasksStore).filter((candidate) => candidate.parentId === task.id);
  if (children.length === 0) return 'Tracking delegated implementation work';
  const openChildren = children.filter((child) => !FINISHED_STATUSES.has(child.status));
  if (openChildren.length > 0) {
    return `Tracking delegated work (${openChildren.length} open subtask${openChildren.length === 1 ? '' : 's'})`;
  }
  return 'Waiting for PM closeout on completed subtasks';
}

function visibleAgentStatus(agent, tasksStore) {
  if (agent.status === 'attention') return 'attention';
  const activeTask = findActiveTaskForAgent(agent, tasksStore);
  if (hasStaleLifecycleState(activeTask)) {
    return 'waiting';
  }
  if (agent.role === 'Project Manager' && isPmTrackingTask(activeTask)) {
    return 'waiting';
  }
  const claimable = claimableTasksForRole(tasksStore, agent.role || '');
  if (agent.activeTaskId) {
    if (currentWorkflowActorRole(activeTask) === agent.role) {
      if (activeTask.status === 'BLOCKED') return 'blocked';
      return executionActivityState(agent);
    }
    return claimable.length > 0 ? 'available' : 'no-tasks';
  }
  if (agent.status === 'blocked') return 'blocked';
  if (agent.status === 'waiting' && hasOwnedReviewTask(agent, tasksStore)) return 'waiting';
  if (claimable.length > 0) return 'available';
  return 'no-tasks';
}

function visibleAgentNote(agent, tasksStore) {
  if (agent.status === 'attention') {
    return agent.note || 'Waiting for user attention';
  }
  const activeTask = findActiveTaskForAgent(agent, tasksStore);
  if (hasStaleLifecycleState(activeTask)) {
    return `Task ${activeTask.id} has completion metadata but is still ${activeTask.status}. PM cleanup is required.`;
  }
  if (agent.role === 'Project Manager' && isPmTrackingTask(activeTask)) {
    return pmTrackingNote(activeTask, tasksStore);
  }
  const activityState = activeTask && currentWorkflowActorRole(activeTask) === agent.role
    ? executionActivityState(agent)
    : null;
  if (activityState === 'stalled') {
    if (agent.lastWatchdogPingAt) {
      return 'No recent agent activity. Watchdog ping sent; waiting for status update.';
    }
    return 'No recent agent activity on the assigned task.';
  }
  if (activityState === 'assigned') {
    return 'Task is assigned. Waiting for fresh agent activity.';
  }
  if (visibleAgentStatus(agent, tasksStore) === 'no-tasks') {
    return 'No claimable task for this role';
  }
  return agent.note || '';
}

function reviewNeededTasks(tasksStore) {
  return activeTasks(tasksStore).filter((task) => task.status === 'REVIEW_NEEDED');
}

function pmReviewTasks(tasksStore) {
  return activeTasks(tasksStore)
    .filter((task) => (
      (task.status === 'DONE' && !hasPendingFollowUp(task, tasksStore) && !hasSupersedingFollowUp(task, tasksStore))
      || (
        task.status === 'REVIEW_NEEDED'
        && normalizedTaskRole(task) === 'Project Manager'
        && !hasPendingFollowUp(task, tasksStore)
        && !hasSupersedingFollowUp(task, tasksStore)
      )
    ))
    .sort(sortClaimable);
}

function followUpWaitTasks(tasksStore) {
  return activeTasks(tasksStore)
    .filter((task) => task.status === 'DONE' || task.status === 'REVIEW_NEEDED')
    .map((task) => ({ task, followUpTask: pendingFollowUpTask(task, tasksStore) }))
    .filter((entry) => entry.followUpTask)
    .sort((a, b) => sortClaimable(a.task, b.task));
}

function supersededByFollowUpTasks(tasksStore) {
  return activeTasks(tasksStore)
    .filter((task) => task.status === 'DONE' || task.status === 'REVIEW_NEEDED')
    .map((task) => ({ task, followUpTask: supersedingFollowUpTask(task, tasksStore) }))
    .filter((entry) => entry.followUpTask && !pendingFollowUpTask(entry.task, tasksStore))
    .sort((a, b) => sortClaimable(a.task, b.task));
}

function hasSessionLostNote(task) {
  return Array.isArray(task.notes) && task.notes.some((note) => (
    note
    && note.kind === 'daemon-reconcile'
    && typeof note.text === 'string'
    && note.text.includes('lost its terminal')
  ));
}

function deriveDashboardState(tasksStore, registry) {
  const reconciledRegistry = reconcileRegistryWithTasks(tasksStore, registry);
  const pmPlanning = queryPmTasks(tasksStore);
  const pmReviewQueue = pmReviewTasks(tasksStore);
  const pmBlockedPlanning = activeTasks(tasksStore)
    .filter((task) => normalizedTaskRole(task) === 'Project Manager' && task.status === 'BLOCKED')
    .sort(sortClaimable);
  const agents = (reconciledRegistry.agents || []).map((agent) => ({
    sessionId: agent.sessionId || null,
    agentName: agent.agentName,
    role: agent.role,
    roleAcronym: agent.roleAcronym || ROLE_ACRONYMS[agent.role] || agent.role,
    status: visibleAgentStatus(agent, tasksStore),
    activeTaskId: agent.activeTaskId || null,
    activeTaskStatus: findActiveTaskForAgent(agent, tasksStore)?.status || null,
    lastSeenAt: agent.lastSeenAt || null,
    attentionRequired: agent.status === 'attention' || Boolean(agent.attentionRequest),
    attentionRequest: agent.attentionRequest || null,
    executionMode: agent.executionMode || 'manual',
    adapterType: agent.adapterType || null,
    disabled: Boolean(agent.disabled),
    note: visibleAgentNote(agent, tasksStore),
    terminalPid: Number.isInteger(agent.terminalPid) ? agent.terminalPid : null,
    terminalHostPid: Number.isInteger(agent.terminalHostPid) ? agent.terminalHostPid : null,
    terminalWindowHandle: Number.isInteger(agent.terminalWindowHandle) ? agent.terminalWindowHandle : null,
    terminalHostProcessName: agent.terminalHostProcessName || null,
    terminalWindowTitle: agent.terminalWindowTitle || null,
    serverHost: agent.serverHost || null,
    serverPort: Number.isInteger(agent.serverPort) ? agent.serverPort : null,
    lastPromptSentAt: agent.lastPromptSentAt || null,
    lastActivityAt: agent.lastActivityAt || null,
    lastAgentResponseAt: agent.lastAgentResponseAt || null,
    activityState: agent.activityState || null,
    lastWatchdogPingAt: agent.lastWatchdogPingAt || null,
  }));

  const roles = ROLES.map((role) => {
    const roleAgents = agents.filter((agent) => agent.role === role);
    const claimableTasks = role === 'Project Manager'
      ? pmPlanning.claimable
      : claimableTasksForRole(tasksStore, role);
    const workingAgents = roleAgents.filter((agent) => agent.status === 'working');
    const stalledAgents = roleAgents.filter((agent) => agent.status === 'stalled');
    const blockedAgents = roleAgents.filter((agent) => agent.status === 'blocked');
    const attentionAgents = roleAgents.filter((agent) => agent.status === 'attention' || agent.attentionRequired);
    const availableAgents = roleAgents.filter((agent) => agent.status === 'available');

    let label = 'unavailable';
    let detail = 'No registered session and no open task.';
    if (attentionAgents.length > 0) {
      label = 'attention';
      detail = `${attentionAgents.length} session(s) waiting for user attention.`;
    } else if (stalledAgents.length > 0) {
      label = 'stalled';
      detail = `${stalledAgents.length} session(s) assigned but inactive, ${claimableTasks.length} claimable task(s).`;
    } else if (blockedAgents.length > 0) {
      label = 'blocked';
      detail = `${blockedAgents.length} blocked registered session(s), ${claimableTasks.length} claimable task(s).`;
    } else if (workingAgents.length > 0) {
      label = 'working';
      detail = `${workingAgents.length} working registered session(s), ${claimableTasks.length} claimable task(s).`;
    } else if (availableAgents.length > 0 && claimableTasks.length > 0) {
      label = 'available';
      detail = `${availableAgents.length} available registered session(s), ${claimableTasks.length} claimable task(s).`;
    } else if (claimableTasks.length > 0) {
      label = 'waiting';
      detail = `${claimableTasks.length} claimable task(s), no available registered session.`;
    } else if (roleAgents.length > 0) {
      label = 'no-tasks';
      detail = `${roleAgents.length} registered session(s), no claimable task.`;
    }

    return {
      role,
      label,
      detail,
      registeredSessions: roleAgents.length,
      claimableTasks: claimableTasks.length,
    };
  });

  const availableWork = [];
  for (const role of ROLES) {
    if (role === 'Project Manager') continue;
    const query = queryTasksForRole(tasksStore, role, {});
    for (const task of query.claimable) {
      availableWork.push({
        id: task.id,
        title: task.title,
        claimableRole: role,
        recommendedRole: task.recommendedRole,
        priority: task.priority,
        status: task.status,
        reason: task.reasons[0] || '',
      });
    }
  }
  availableWork.sort((a, b) => sortClaimable(a, b));

  const planningQueue = pmPlanning.claimable.map((task) => ({
    id: task.id,
    title: task.title,
    claimableRole: 'Project Manager',
    recommendedRole: task.recommendedRole || null,
    priority: task.priority || null,
    status: task.status,
    reason: task.reasons[0] || '',
    reviveEligible: false,
  })).concat(pmBlockedPlanning.map((task) => ({
    id: task.id,
    title: task.title,
    claimableRole: 'Project Manager',
    recommendedRole: task.recommendedRole || null,
    priority: task.priority || null,
    status: task.status,
    reason: hasSessionLostNote(task)
      ? 'Blocked because the PM session was lost. You can revive this task on a new session.'
      : 'Blocked PM planning task. Reopen or reassign from the PM flow.',
    reviveEligible: hasSessionLostNote(task),
  })));

  const helpQueue = tasksByAttention(tasksStore, 'BLOCKED', 'implementation_help')
    .filter((task) => normalizedTaskRole(task) !== 'Project Manager')
    .map((task) => ({
      id: task.id,
      title: task.title,
      claimableRole: normalizedTaskRole(task) || null,
      recommendedRole: task.recommendedRole || null,
      priority: task.priority || null,
      status: task.status,
      attentionType: task.attentionType || null,
      reviveEligible: hasSessionLostNote(task),
    }));

  const seniorReviewQueue = tasksByAttention(tasksStore, 'REVIEW_NEEDED', 'senior_closure')
    .filter((task) => !hasPendingFollowUp(task, tasksStore))
    .map((task) => ({
    id: task.id,
    title: task.title,
    claimableRole: 'Senior Pro',
    recommendedRole: task.recommendedRole || null,
    priority: task.priority || null,
    status: task.status,
    attentionType: task.attentionType || null,
    claim: task.claim || null,
  }));

  const followUpWaitQueue = followUpWaitTasks(tasksStore).map(({ task, followUpTask }) => ({
    id: task.id,
    title: task.title,
    claimableRole: null,
    recommendedRole: task.recommendedRole || null,
    priority: task.priority || null,
    status: task.status,
    attentionType: task.attentionType || null,
    followUpTaskId: followUpTask.id,
    reason: `Waiting for follow-up ${followUpTask.id} (${followUpTask.status}) before this task can return to review.`,
    claim: task.claim || null,
  }));

  const supersededReviewQueue = supersededByFollowUpTasks(tasksStore).map(({ task, followUpTask }) => ({
    id: task.id,
    title: task.title,
    claimableRole: null,
    recommendedRole: task.recommendedRole || null,
    priority: task.priority || null,
    status: task.status,
    attentionType: task.attentionType || null,
    followUpTaskId: followUpTask.id,
    reason: `Superseded by follow-up ${followUpTask.id}. Review the follow-up instead.`,
    claim: task.claim || null,
  }));

  const pmReviewItems = pmReviewQueue.map((task) => ({
    id: task.id,
    title: task.title,
    claimableRole: 'Project Manager',
    recommendedRole: task.recommendedRole || null,
    priority: task.priority || null,
    status: task.status,
    attentionType: task.attentionType || null,
    userReview: task.userReview || null,
    followUpTaskId: task.userReview && task.userReview.followUpTaskId ? task.userReview.followUpTaskId : null,
    reason: task.status === 'DONE'
      ? 'Completed task awaiting user approval.'
      : 'Project Manager task was sent to implementation review. Resolve it through user approval.',
    claim: task.claim || null,
  }));

  const alerts = [];
  for (const agent of agents.filter((entry) => entry.status === 'blocked')) {
    alerts.push(`${agent.agentName} is blocked${agent.activeTaskId ? ` on ${agent.activeTaskId}` : ''}.`);
  }
  for (const agent of agents.filter((entry) => entry.status === 'stalled')) {
    alerts.push(`${agent.agentName} is stalled${agent.activeTaskId ? ` on ${agent.activeTaskId}` : ''}.`);
  }
  for (const agent of agents.filter((entry) => entry.status === 'attention' || entry.attentionRequired)) {
    alerts.push(`${agent.agentName} is waiting for user attention${agent.activeTaskId ? ` on ${agent.activeTaskId}` : ''}.`);
  }

  for (const task of reviewNeededTasks(tasksStore)) {
    const pendingFollowUp = pendingFollowUpTask(task, tasksStore);
    if (pendingFollowUp) {
      alerts.push(`${task.id} is waiting for follow-up ${pendingFollowUp.id}: ${pendingFollowUp.title}`);
      continue;
    }
    if (normalizedTaskRole(task) === 'Project Manager') {
      alerts.push(`${task.id} needs user review recovery: ${task.title}`);
    } else {
      alerts.push(`${task.id} requires review: ${task.title}`);
    }
  }

  for (const task of pmReviewQueue) {
    if (task.status === 'DONE') {
      alerts.push(`${task.id} awaits user review: ${task.title}`);
    }
  }

  for (const task of activeTasks(tasksStore)) {
    if (hasStaleLifecycleState(task)) {
      alerts.push(`${task.id} has stale lifecycle data: ${task.status} but already has completion metadata.`);
    }
  }

  for (const task of activeTasks(tasksStore).filter((entry) => entry.status === 'DONE')) {
    if (!hasPendingFollowUp(task, tasksStore)) continue;
    const followUpTask = followUpTaskForDeclinedTask(task, tasksStore);
    const pendingFollowUp = followUpTask || pendingFollowUpTask(task, tasksStore);
    if (!pendingFollowUp) continue;
    alerts.push(`${task.id} is waiting for follow-up ${pendingFollowUp.id}: ${pendingFollowUp.status}.`);
  }

  for (const roleEntry of roles) {
    if (roleEntry.claimableTasks > 0 && !agents.some((agent) => agent.role === roleEntry.role && agent.status === 'available')) {
      alerts.push(`${roleEntry.role} has ${roleEntry.claimableTasks} open task(s) and no available announced agent.`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    tasksStore,
    registry: reconciledRegistry,
    summary: {
      activeAgents: agents.length,
      openTasks: activeTasks(tasksStore).filter((task) => task.status === 'TODO').length,
      blockedAgents: agents.filter((agent) => agent.status === 'blocked').length,
      reviewNeeded: seniorReviewQueue.length + pmReviewItems.length,
    },
    roles,
    agents,
    alerts,
    activeTaskQueue: activeTaskQueue(tasksStore),
    planningQueue,
    availableWork,
    helpQueue,
    followUpWaitQueue,
    supersededReviewQueue,
    pmReviewQueue: pmReviewItems,
    seniorReviewQueue,
    nextTodo: visibleNextTodo(tasksStore),
  };
}

module.exports = {
  ROLE_ACRONYMS,
  ROLE_RANK,
  ROLES,
  VALID_ROLES,
  VALID_TASK_STATUSES,
  SATISFIED_STATUSES,
  FINISHED_STATUSES,
  normalizeRole,
  requireRole,
  implementationRank,
  allTasks,
  activeTasks,
  activeTaskQueue,
  buildTaskMap,
  normalizedTaskRole,
  nextHigherImplementationRole,
  deriveWorkflowState,
  currentWorkflowActorRole,
  currentWorkflowStep,
  setWorkflowState,
  isSeniorReviewTask,
  hasOpenSubtasks,
  sortClaimable,
  evaluateStructuredTask,
  queryEntry,
  queryTasksForRole,
  chooseAssignableTask,
  tasksByAttention,
  visibleNextTodo,
  queryPmTasks,
  claimableTasksForRole,
  reconcileRegistryWithTasks,
  visibleAgentStatus,
  visibleAgentNote,
  hasStaleLifecycleState,
  deriveDashboardState,
  hasSessionLostNote,
  pmReviewTasks,
  followUpWaitTasks,
  supersededByFollowUpTasks,
  latestTaskNote,
  taskSource,
  isUserDeclineFollowUpTask,
  userDeclineRecord,
  hasUserDecline,
  followUpTaskForDeclinedTask,
  supersedingFollowUpTask,
  hasSupersedingFollowUp,
  pendingFollowUpTask,
  hasPendingFollowUp,
};
