'use strict';

const {
  coordinationCore,
  VALID_TASK_STATUSES,
  SATISFIED_STATUSES,
  FINISHED_STATUSES,
  requireRole,
  implementationRank,
  readRuntimeState,
  mutateRuntime,
  allTasks,
  activeTasks,
  findTask,
  normalizedTaskRole,
  utcNow,
} = require('./common');
const {
  checkPermission,
  checkTransition,
  requiresSeniorReviewOnComplete,
  isSeniorReviewApproval,
} = require('./policy');
const {
  applyAgentState,
  findAgent,
} = require('./registry-commands');
const contextManager = require('../context/context-manager');
const taskGraphIntegrity = require('../runtime/task-graph-integrity');
const { addInboxItem, createSecretaryQuestion } = require('../core/secretary-inbox');
const agentMemory = require('../core/agent-memory');

function evaluateStructuredTask(task, role, store) {
  return coordinationCore.evaluateStructuredTask(task, role, store);
}

function sortClaimable(a, b) {
  return coordinationCore.sortClaimable(a, b);
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
  return coordinationCore.queryEntry(task);
}

function queryTasks(options) {
  const role = requireRole(options.role);
  if (role === 'Project Manager') {
    throw new Error('query is for implementation roles: SP, SS, or Jr.');
  }

  const snapshot = readRuntimeState(options);
  const store = snapshot.tasksStore;
  const query = coordinationCore.queryTasksForRole(store, role, {
    explainAll: options.explainAll,
    includeNext: options.includeNext,
  });

  return {
    role,
    tasksPath: snapshot.paths.tasksPath,
    claimable: query.claimable.map(queryEntry),
    availableWithOverride: query.availableWithOverride.map(queryEntry),
    unavailable: query.unavailable.map(queryEntry),
    nextTodo: query.nextTodo.map(queryEntry),
  };
}

function chooseAssignableTask(store, role) {
  return coordinationCore.chooseAssignableTask(store, role);
}

function assignTask(options) {
  if (!options.name) throw new Error('--name is required for assign.');
  const role = requireRole(options.role);
  if (role === 'Project Manager') {
    throw new Error('assign is for implementation roles: SP, SS, or Jr.');
  }

  return mutateRuntime(options, (state) => {
    const store = state.tasksStore;
    const task = chooseAssignableTask(store, role);
    if (!task) {
      return {
        assigned: false,
        message: `No claimable active task is available for ${role}.`,
        role,
        tasksPath: state.paths.tasksPath,
      };
    }

    const now = utcNow();
    const isSeniorReview = coordinationCore.isSeniorReviewTask(task) && role === 'Senior Pro';
    if (isSeniorReview) {
      task.reviewClaim = {
        agentName: options.name,
        role,
        claimedAt: now,
        sessionId: options.sessionId || null,
      };
      coordinationCore.setWorkflowState(task, 'senior_review', 'Senior Pro', options.sessionId || null);
    } else {
      task.status = 'CLAIMED';
      task.attentionType = null;
      task.claim = {
        agentName: options.name,
        role,
        claimedAt: now,
      };
      coordinationCore.setWorkflowState(task, 'implementation', role, options.sessionId || null);
    }
    store.updatedAt = now;
    applyAgentState(state.registry, 'claim', options, task.id);

    return {
      assigned: true,
      message: isSeniorReview
        ? `${task.id} assigned to ${options.name} for Senior Pro review.`
        : `${task.id} assigned to ${options.name}.`,
      role,
      tasksPath: state.paths.tasksPath,
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        type: task.type,
        parentId: task.parentId || null,
        recommendedRole: task.recommendedRole || null,
        priority: task.priority || null,
        prerequisites: task.prerequisites || [],
        contextHints: task.contextHints || [],
        claim: task.claim,
      },
    };
  });
}

function requireTaskArgs(options) {
  if (!options.taskId) throw new Error('--task <id> is required.');
  if (!options.name) throw new Error('--name is required.');
  if (!options.role) throw new Error('--role is required.');
}

function applyMutation(options, mutate) {
  requireTaskArgs(options);
  const role = requireRole(options.role);
  return mutateRuntime(options, (state) => {
    const store = state.tasksStore;
    const found = findTask(store, options.taskId);
    if (!found) throw new Error(`${options.taskId} not found.`);
    if (found.collection !== 'tasks') {
      throw new Error(`${options.taskId} is not in active tasks.`);
    }

    const permissionError = checkPermission(options.command, found.task, options.name, role);
    if (permissionError) throw new Error(permissionError);

    const outcome = mutate(state, found, role, options) || {};
    store.updatedAt = utcNow();
    return outcome;
  });
}

function addTaskReport(task, options, role) {
  if (!options.summary && !options.tested && !options.notTested && !options.risks && !options.files) {
    return false;
  }
  if (!Array.isArray(task.reports)) task.reports = [];
  task.reports.push({
    agentName: options.name,
    role,
    taskId: task.id,
    filesChanged: options.files ? options.files.split(',').map((entry) => entry.trim()).filter(Boolean) : [],
    summary: options.summary || '',
    tested: options.tested || '',
    notTested: options.notTested || '',
    risksOrFollowUp: options.risks || '',
    rawText: `Agent: ${options.name}\nRole: ${role}\nTask: ${task.id}\nFiles changed: ${options.files || ''}\nSummary: ${options.summary || ''}\nWhat was tested: ${options.tested || ''}\nWhat was not tested: ${options.notTested || ''}\nRisks or follow-up needed: ${options.risks || ''}`,
  });
  return true;
}

function contextReviewResolved(task) {
  return contextManager.proposalResolved(task && task.contextProposal);
}

function applyContextReview(task, options, role) {
  const proposal = contextManager.buildContextProposal(options, { name: options.name, role });
  if (!proposal) return false;

  task.contextProposal = proposal;
  if (!Array.isArray(task.notes)) task.notes = [];
  task.notes.push({
    kind: proposal.state === 'pending' ? 'context-proposal' : 'context-not-needed',
    text: proposal.state === 'pending'
      ? `Context proposal: ${proposal.operation} "${proposal.target}".`
      : proposal.reason,
    createdAt: proposal.createdAt,
    agentName: options.name,
    role,
  });

  return true;
}

function claimTask(options) {
  return applyMutation(options, (state, found, role, opts) => {
    const { task } = found;
    const transitionError = checkTransition(task.id, task.status, 'CLAIMED');
    if (transitionError) throw new Error(transitionError);

    const evaluation = evaluateStructuredTask(task, role, state.tasksStore);
    if (!evaluation.claimable) {
      throw new Error(`${task.id} is not claimable: ${evaluation.reasons.join(' ')}`);
    }

    task.status = 'CLAIMED';
    task.attentionType = null;
    task.claim = { agentName: opts.name, role, claimedAt: utcNow() };
    coordinationCore.setWorkflowState(task, 'implementation', role, opts.sessionId || null);
    applyAgentState(state.registry, 'claim', opts, task.id);
    return {
      message: `${task.id} claimed.`,
      task: { id: task.id, title: task.title, status: task.status },
    };
  });
}

function startTask(options) {
  return applyMutation(options, (state, found, role, opts) => {
    const { task } = found;
    const transitionError = checkTransition(task.id, task.status, 'IN_PROGRESS');
    if (transitionError) throw new Error(transitionError);

    task.status = 'IN_PROGRESS';
    task.attentionType = null;
    coordinationCore.setWorkflowState(task, 'implementation', role, opts.sessionId || null);
    applyAgentState(state.registry, 'start', opts, task.id);
    return {
      message: `${task.id} started.`,
      task: { id: task.id, title: task.title, status: task.status },
    };
  });
}

function completeTask(options) {
  const result = applyMutation(options, (state, found, role, opts) => {
    const { task } = found;
    const seniorReviewApproval = isSeniorReviewApproval(task, opts.name, role);
    if (opts.contextReviewed && !seniorReviewApproval) {
      throw new Error('--context-reviewed can only be used by Senior Pro while approving a REVIEW_NEEDED task.');
    }
    const targetStatus = seniorReviewApproval
      ? 'DONE'
      : (requiresSeniorReviewOnComplete(task, role) ? 'REVIEW_NEEDED' : 'DONE');
    const transitionError = checkTransition(task.id, task.status, targetStatus);
    if (transitionError) throw new Error(transitionError);

    task.status = targetStatus;
    task.attentionType = targetStatus === 'REVIEW_NEEDED' ? 'senior_closure' : null;
    if (!seniorReviewApproval || !task.completedBy) {
      task.completedBy = opts.name;
    }
    if (!seniorReviewApproval || !task.completedAt) {
      task.completedAt = utcNow();
    }
    if (targetStatus === 'REVIEW_NEEDED') {
      task.reviewClaim = null;
      coordinationCore.setWorkflowState(task, 'senior_review', 'Senior Pro', null);
    } else {
      coordinationCore.setWorkflowState(task, 'user_review', 'User', null);
    }
    if (seniorReviewApproval) {
      if (!Array.isArray(task.notes)) task.notes = [];
      task.notes.push({
        kind: 'senior-review-approved',
        text: opts.note || 'Approved by Senior Pro review.',
        createdAt: utcNow(),
        agentName: opts.name,
        role,
      });
      task.reviewedBy = {
        agentName: opts.name,
        role,
        reviewedAt: utcNow(),
      };
      task.reviewClaim = null;
      applyContextReview(task, opts, role);
      coordinationCore.setWorkflowState(task, 'user_review', 'User', null);
    }
    const reportAdded = addTaskReport(task, opts, role);
    applyAgentState(
      state.registry,
      targetStatus === 'REVIEW_NEEDED' ? 'review' : 'done',
      targetStatus === 'REVIEW_NEEDED'
        ? { ...opts, note: 'Waiting for Senior Pro review' }
        : opts,
      task.id
    );
    return {
      message: targetStatus === 'REVIEW_NEEDED'
        ? `${task.id} completed and sent to Senior Pro review.`
        : `${task.id} completed.`,
      task: { id: task.id, title: task.title, status: task.status },
      reportAdded,
    };
  });

  if (String(options.summary || '').trim()) {
    try {
      const snapshot = readRuntimeState(options);
      const agent = findAgent(snapshot.registry, options);
      if (agent?.cartridgeId) {
        agentMemory.appendTaskMemory({
          projectRoot: snapshot.paths.projectRoot,
          cartridgeId: agent.cartridgeId,
          agentName: agent.agentName,
          role: agent.role,
          taskId: options.taskId,
          summary: options.summary,
          highlights: [options.risks ? `Risks or follow-up: ${options.risks}` : 'No follow-up recorded.'],
        });
        result.memoryUpdated = true;
      }
    } catch (error) {
      result.memoryUpdated = false;
      result.memoryWarning = error.message;
    }
  }
  return result;
}

function blockTask(options) {
  if (!options.reason) throw new Error('--reason is required for block.');
  return applyMutation(options, (state, found, role, opts) => {
    const { task } = found;
    const transitionError = checkTransition(task.id, task.status, 'BLOCKED');
    if (transitionError) throw new Error(transitionError);

    task.status = 'BLOCKED';
    task.attentionType = null;
    coordinationCore.setWorkflowState(task, 'blocked', role, opts.sessionId || null);
    if (!Array.isArray(task.notes)) task.notes = [];
    task.notes.push({ kind: 'blocker', text: opts.reason, createdAt: utcNow(), agentName: opts.name, role });
    applyAgentState(state.registry, 'block', opts, task.id);
    return {
      message: `${task.id} blocked.`,
      task: { id: task.id, title: task.title, status: task.status },
    };
  });
}

function unblockTask(options) {
  return applyMutation(options, (state, found, role, opts) => {
    const { task } = found;
    const transitionError = checkTransition(task.id, task.status, 'IN_PROGRESS');
    if (transitionError) throw new Error(transitionError);

    task.status = 'IN_PROGRESS';
    task.attentionType = null;
    coordinationCore.setWorkflowState(task, 'implementation', role, opts.sessionId || null);
    applyAgentState(state.registry, 'start', opts, task.id);
    return {
      message: `${task.id} unblocked.`,
      task: { id: task.id, title: task.title, status: task.status },
    };
  });
}

function requestReviewTask(options) {
  return applyMutation(options, (state, found, role, opts) => {
    const { task } = found;
    const transitionError = checkTransition(task.id, task.status, 'REVIEW_NEEDED');
    if (transitionError) throw new Error(transitionError);

    task.status = 'REVIEW_NEEDED';
    task.attentionType = 'senior_closure';
    coordinationCore.setWorkflowState(task, 'senior_review', 'Senior Pro', null);
    applyAgentState(state.registry, 'review', opts, task.id);
    return {
      message: `${task.id} marked as review needed.`,
      task: { id: task.id, title: task.title, status: task.status },
    };
  });
}

function pmReviewTask(options) {
  requireTaskArgs(options);
  const role = requireRole(options.role);
  if (role !== 'Project Manager') {
    throw new Error('pm-review is only allowed for Project Manager.');
  }

  return applyMutation(options, (state, found, currentRole, opts) => {
    const { task } = found;
    if (task.status !== 'DONE' && task.status !== 'REVIEW_NEEDED') {
      throw new Error(`${task.id} must be DONE or REVIEW_NEEDED before PM review.`);
    }

    const contextResolved = contextReviewResolved(task);
    const contextApplyResult = contextResolved
      ? contextManager.applyContextProposal(task, { appliedBy: opts.name })
      : null;
    task.status = contextResolved ? 'CONTEXT_UPDATED' : 'PM_REVIEWED';
    task.attentionType = null;
    coordinationCore.setWorkflowState(task, 'pm_closeout', 'Project Manager', opts.sessionId || null);
    if (!Array.isArray(task.notes)) task.notes = [];
    task.notes.push({
      kind: 'pm-review',
      text: opts.note || (contextResolved
        ? `Task approved by user; ${contextApplyResult.summary}`
        : 'Task reviewed by PM.'),
      createdAt: utcNow(),
      agentName: opts.name,
      role: currentRole,
    });
    return {
      message: contextResolved
        ? `${task.id} marked as CONTEXT_UPDATED.`
        : `${task.id} marked as PM_REVIEWED.`,
      task: { id: task.id, title: task.title, status: task.status },
      contextApplyResult,
    };
  });
}

function juniorHelpTask(options) {
  if (!options.issue) throw new Error('--issue is required for junior-help.');
  return applyMutation(options, (state, found, role, opts) => {
    const { task } = found;
    if (task.status === 'DONE') {
      throw new Error(`${task.id} is already DONE.`);
    }

    task.status = 'BLOCKED';
    task.attentionType = 'implementation_help';
    coordinationCore.setWorkflowState(task, 'implementation_help', coordinationCore.nextHigherImplementationRole(role), null);
    if (!Array.isArray(task.notes)) task.notes = [];
    task.notes.push({
      kind: 'junior-help',
      agentName: opts.name,
      role,
      createdAt: utcNow(),
      issue: opts.issue,
      tried: opts.tried || '',
      need: opts.need || '',
      suggest: opts.suggest || '',
      rawText: `Agent: ${opts.name}\nRole: ${role}\nTask: ${task.id}\nIssue: ${opts.issue}\nWhat I tried: ${opts.tried || ''}\nWhat I need help with: ${opts.need || ''}\nSuggested next step: ${opts.suggest || ''}`,
    });
    applyAgentState(state.registry, 'block', { ...opts, reason: opts.issue }, task.id);
    return {
      message: `${task.id} marked blocked with junior help request.`,
      task: { id: task.id, title: task.title, status: task.status },
    };
  });
}

function askUserTask(options) {
  if (!options.question) throw new Error('--question is required for ask-user.');
  return applyMutation(options, (state, found, role, opts) => {
    const { task } = found;
    const agent = findAgent(state.registry, opts);
    if (!agent) {
      throw new Error(`Agent session not found for ${opts.name}. Announce the session before using ask-user.`);
    }

    const question = String(opts.question || '').trim();
    const suggestedAnswers = Array.isArray(opts.optionsList)
      ? opts.optionsList.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];

    if (!Array.isArray(task.notes)) task.notes = [];
    task.notes.push({
      kind: 'user-question',
      createdAt: utcNow(),
      agentName: opts.name,
      role,
      question,
      options: suggestedAnswers,
    });

    agent.attentionRequest = {
      taskId: task.id,
      question,
      options: suggestedAnswers,
      askedAt: utcNow(),
      previousStatus: agent.status || 'working',
      previousNote: agent.note || '',
      source: 'cli',
    };
    agent.status = 'attention';
    agent.activeTaskId = agent.activeTaskId || task.id;
    agent.note = `Waiting for user answer: ${question}`;
    agent.lastSeenAt = utcNow();
    state.registry.updatedAt = utcNow();
    addInboxItem(state.secretaryInbox, createSecretaryQuestion({
      agentName: agent.agentName,
      role: agent.role,
      cartridgeId: agent.cartridgeId || null,
      sessionId: agent.sessionId,
      taskId: task.id,
      body: question,
      options: suggestedAnswers,
    }));

    return {
      message: `${task.id} is waiting for user input.`,
      task: { id: task.id, title: task.title, status: task.status },
      attentionRequest: agent.attentionRequest,
    };
  });
}

function addReportTask(options) {
  return applyMutation(options, (state, found, role, opts) => {
    const { task } = found;
    const reportAdded = addTaskReport(task, opts, role);
    if (!reportAdded) throw new Error('No report content provided.');
    return {
      message: `Report added to ${task.id}.`,
      task: { id: task.id, title: task.title, status: task.status },
      reportAdded: true,
    };
  });
}

function pmStatusTask(options) {
  requireTaskArgs(options);
  const role = requireRole(options.role);
  if (role !== 'Project Manager') {
    throw new Error('pm-status is only allowed for Project Manager.');
  }
  if (!options.status) throw new Error('--status is required for pm-status.');
  if (!VALID_TASK_STATUSES.has(options.status)) {
    throw new Error(`Invalid task status "${options.status}".`);
  }

  return applyMutation(options, (state, found, currentRole, opts) => {
    const { task } = found;
    task.status = opts.status;
    if (opts.status !== 'BLOCKED' && opts.status !== 'REVIEW_NEEDED') {
      task.attentionType = null;
    }
    if (opts.note) {
      if (!Array.isArray(task.notes)) task.notes = [];
      task.notes.push({ kind: 'pm-note', text: opts.note, createdAt: utcNow() });
    }
    return {
      message: `${task.id} status set to ${opts.status}.`,
      task: { id: task.id, title: task.title, status: task.status },
    };
  });
}

function requirePmRole(registry, options) {
  if (!options.name) throw new Error('--name is required. Verify caller identity against agent registry.');
  if (!options.sessionId) throw new Error('--session-id is required for PM-only commands.');

  const pmAgent = (registry.agents || []).find((agent) => (
    agent.sessionId === options.sessionId
    && agent.agentName === options.name
    && agent.role === 'Project Manager'
  ));
  if (!pmAgent) {
    throw new Error(`${options.name} is not registered as Project Manager for session ${options.sessionId}. Only PM can use this command.`);
  }
}

function findRegisteredCaller(registry, options) {
  if (!options.name) throw new Error('--name is required. Verify caller identity against agent registry.');
  if (!options.sessionId) throw new Error('--session-id is required. Verify caller identity against agent registry.');
  return (registry.agents || []).find((agent) => (
    agent.sessionId === options.sessionId
    && agent.agentName === options.name
  )) || null;
}

function requireTaskCreatorRole(state, options) {
  const caller = findRegisteredCaller(state.registry, options);
  if (!caller) {
    throw new Error(`${options.name} is not registered for session ${options.sessionId}.`);
  }

  if (caller.role === 'Project Manager' || caller.role === 'Senior Pro') {
    return caller;
  }

  throw new Error(`${options.name} cannot create tasks. Only Project Manager and Senior Pro can create tasks.`);
}

function buildPlannedTask(options, recommendedRole, section, order, creator = null) {
  const rawPrerequisites = Array.isArray(options.prereq) ? options.prereq : [];
  const task = {
    id: options.taskId,
    parentId: options.parentId || null,
    type: options.parentId ? 'subtask' : 'task',
    section,
    status: 'TODO',
    attentionType: null,
    title: options.title,
    recommendedRole,
    priority: options.priority || 'Medium',
    suggestedOwnerRole: null,
    goal: options.goal || [],
    scope: options.scope || [],
    contextHints: options.contextHints || [],
    prerequisites: rawPrerequisites,
    claim: null,
    completedBy: null,
    completedAt: null,
    reports: [],
    notes: [],
    children: [],
    source: options.source || null,
    createdByAgentName: creator ? creator.agentName : null,
    createdByRole: creator ? creator.role : null,
    createdBySessionId: creator ? creator.sessionId || null : null,
    createdAt: utcNow(),
    order,
  };

  coordinationCore.setWorkflowState(
    task,
    section === 'nextTodo'
      ? 'backlog'
      : (recommendedRole === 'Project Manager' ? 'pm_planning' : 'implementation_queue'),
    recommendedRole,
    null
  );

  return task;
}

function createTask(options) {
  if (!options.taskId) throw new Error('--task <id> is required for create-task.');
  if (!options.title) throw new Error('--title is required for create-task.');
  if (!options.role) throw new Error('--role is required for create-task (the recommended role for the new task).');

  const recommendedRole = requireRole(options.role);
  return mutateRuntime(options, (state) => {
    const creator = requireTaskCreatorRole(state, options);
    const store = state.tasksStore;
    const existing = allTasks(store);
    if (existing.some((task) => task.id === options.taskId)) {
      throw new Error(`${options.taskId} already exists in tasks.json.`);
    }

    const now = utcNow();
    const maxOrder = (store.tasks || []).reduce((max, task) => Math.max(max, task.order || 0), 0);
    const task = buildPlannedTask(options, recommendedRole, 'active', maxOrder + 10, creator);

    if (options.note) {
      task.notes.push({ kind: 'pm-note', text: options.note, createdAt: now });
    }

    if (!Array.isArray(store.tasks)) store.tasks = [];
    store.tasks.push(task);
    if (task.parentId) {
      const parentEntry = findTask(store, task.parentId);
      const parentTask = parentEntry ? parentEntry.task : null;
      if (parentTask) {
        if (!Array.isArray(parentTask.children)) parentTask.children = [];
        if (!parentTask.children.includes(task.id)) parentTask.children.push(task.id);
      }
    }
    store.updatedAt = now;
    taskGraphIntegrity.normalizeTaskGraph(store);
    return {
      message: `${options.taskId} created.`,
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        recommendedRole: task.recommendedRole,
        contextHints: task.contextHints || [],
      },
    };
  });
}

function createNextTodoTask(options) {
  if (!options.taskId) throw new Error('--task <id> is required for create-next-todo.');
  if (!options.title) throw new Error('--title is required for create-next-todo.');
  if (!options.role) throw new Error('--role is required for create-next-todo (the recommended role for the new task).');

  const recommendedRole = requireRole(options.role);
  return mutateRuntime(options, (state) => {
    const creator = requireTaskCreatorRole(state, options);
    const store = state.tasksStore;
    const existing = allTasks(store);
    if (existing.some((task) => task.id === options.taskId)) {
      throw new Error(`${options.taskId} already exists in tasks.json.`);
    }

    const now = utcNow();
    const maxOrder = (store.nextTodo || []).reduce((max, task) => Math.max(max, task.order || 0), 0);
    const task = buildPlannedTask(options, recommendedRole, 'nextTodo', maxOrder + 10, creator);

    if (options.note) {
      task.notes.push({ kind: 'pm-note', text: options.note, createdAt: now });
    }

    if (!Array.isArray(store.nextTodo)) store.nextTodo = [];
    store.nextTodo.push(task);
    store.updatedAt = now;
    taskGraphIntegrity.normalizeTaskGraph(store);
    return {
      message: `${options.taskId} created in Next-Todo.`,
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        recommendedRole: task.recommendedRole,
        contextHints: task.contextHints || [],
      },
    };
  });
}

function promoteTask(options) {
  if (!options.taskId) throw new Error('--task <id> is required for promote.');

  return mutateRuntime(options, (state) => {
    requirePmRole(state.registry, options);
    const store = state.tasksStore;
    const nextTodo = store.nextTodo || [];
    const idx = nextTodo.findIndex((item) => item.id === options.taskId);
    if (idx === -1) {
      const alreadyActive = (store.tasks || []).find((item) => item.id === options.taskId);
      if (alreadyActive) throw new Error(`${options.taskId} is already in active tasks.`);
      throw new Error(`${options.taskId} not found in nextTodo.`);
    }

    const [item] = nextTodo.splice(idx, 1);
    item.section = 'active';
    coordinationCore.setWorkflowState(
      item,
      item.recommendedRole === 'Project Manager' ? 'pm_planning' : 'implementation_queue',
      requireRole(item.recommendedRole),
      null
    );

    if (options.newId) {
      const existing = allTasks(store);
      if (existing.some((task) => task.id === options.newId)) {
        throw new Error(`${options.newId} already exists in tasks.json.`);
      }
      item.id = options.newId;
    }

    const maxOrder = (store.tasks || []).reduce((max, task) => Math.max(max, task.order || 0), 0);
    item.order = maxOrder + 10;
    if (!Array.isArray(store.tasks)) store.tasks = [];
    store.tasks.push(item);
    store.updatedAt = utcNow();
    taskGraphIntegrity.normalizeTaskGraph(store);
    return {
      message: `${item.id} promoted to active tasks.`,
      task: { id: item.id, title: item.title, status: item.status, recommendedRole: item.recommendedRole },
    };
  });
}

module.exports = {
  closestRelevance,
  closestUnavailable,
  queryEntry,
  queryTasks,
  chooseAssignableTask,
  requireTaskArgs,
  applyMutation,
  addTaskReport,
  assignTask,
  claimTask,
  startTask,
  completeTask,
  blockTask,
  unblockTask,
  requestReviewTask,
  pmReviewTask,
  juniorHelpTask,
  askUserTask,
  addReportTask,
  pmStatusTask,
  requirePmRole,
  createTask,
  createNextTodoTask,
  promoteTask,
  sortClaimable,
  evaluateStructuredTask,
};
