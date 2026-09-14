'use strict';

const {
  coordinationCore,
  implementationRank,
  normalizedTaskRole,
} = require('./common');

const TRANSITIONS = {
  TODO: ['CLAIMED'],
  CLAIMED: ['IN_PROGRESS', 'BLOCKED', 'DONE', 'REVIEW_NEEDED'],
  IN_PROGRESS: ['DONE', 'BLOCKED', 'REVIEW_NEEDED'],
  BLOCKED: ['IN_PROGRESS'],
  DONE: ['REVIEW_NEEDED'],
  REVIEW_NEEDED: ['DONE', 'PM_REVIEWED'],
  PM_REVIEWED: ['CONTEXT_UPDATED'],
  CONTEXT_UPDATED: ['ARCHIVED'],
};

function isOwnTask(task, agentName, role) {
  return Boolean(task.claim && task.claim.agentName === agentName && task.claim.role === role);
}

function isReviewOwner(task, agentName, role) {
  return Boolean(task.reviewClaim && task.reviewClaim.agentName === agentName && task.reviewClaim.role === role);
}

function requiresSeniorReviewOnComplete(task, role) {
  return (
    (role === 'Junior' || role === 'Semi Senior')
    && normalizedTaskRole(task) !== 'Project Manager'
  );
}

function isSeniorReviewApproval(task, agentName, role) {
  return (
    role === 'Senior Pro'
    && coordinationCore.isSeniorReviewTask(task)
    && isReviewOwner(task, agentName, role)
  );
}

function checkTransition(taskId, currentStatus, targetStatus) {
  if (currentStatus === targetStatus) {
    return `${taskId} is already ${currentStatus}.`;
  }
  const allowed = TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    return `${taskId} cannot transition from ${currentStatus} to ${targetStatus}.`;
  }
  return null;
}

function checkPermission(command, task, agentName, role) {
  if (role === 'Project Manager') return null;

  const own = isOwnTask(task, agentName, role);
  const reviewOwn = isSeniorReviewApproval(task, agentName, role);
  const recommendedRole = normalizedTaskRole(task);
  if (recommendedRole && task.recommendedRole !== recommendedRole) {
    task.recommendedRole = recommendedRole;
  }

  switch (command) {
    case 'claim': {
      if (!recommendedRole) return null;
      const taskRank = implementationRank(recommendedRole);
      const agentRank = implementationRank(role);
      if (role === 'Junior' && recommendedRole !== 'Junior') {
        return `${task.id} recommended role is ${task.recommendedRole} - above Junior.`;
      }
      if (role === 'Semi Senior' && taskRank !== null && agentRank !== null && taskRank > agentRank) {
        return `${task.id} recommended role is ${task.recommendedRole} - above Semi Senior.`;
      }
      return null;
    }
    case 'start':
    case 'block':
    case 'unblock':
      if (!own) {
        return `${task.id} was claimed by ${task.claim ? task.claim.agentName : 'unknown'}. Only the claiming agent can ${command}.`;
      }
      return null;
    case 'complete':
    case 'add-report':
      if (!own && !reviewOwn) {
        if (coordinationCore.isSeniorReviewTask(task)) {
          return `${task.id} is under Senior Pro review${task.reviewClaim && task.reviewClaim.agentName ? ` by ${task.reviewClaim.agentName}` : ''}. Only the assigned reviewer can ${command}.`;
        }
        return `${task.id} was claimed by ${task.claim ? task.claim.agentName : 'unknown'}. Only the claiming agent can ${command}.`;
      }
      if (command === 'complete' && role === 'Junior' && task.type !== 'subtask') {
        return `${command} for main tasks is not allowed for Junior.`;
      }
      return null;
    case 'request-review':
      if (role === 'Junior' || role === 'Project Manager') {
        return `request-review is not allowed for ${role}.`;
      }
      if (normalizedTaskRole(task) === 'Project Manager') {
        return `${task.id} is a Project Manager workflow task. Use PM review flow instead of request-review.`;
      }
      if (!own) {
        return `${task.id} was claimed by ${task.claim ? task.claim.agentName : 'unknown'}. Only the claiming agent can request-review.`;
      }
      return null;
    case 'ask-user':
      if (!own && !reviewOwn) {
        if (coordinationCore.isSeniorReviewTask(task)) {
          return `${task.id} is under Senior Pro review${task.reviewClaim && task.reviewClaim.agentName ? ` by ${task.reviewClaim.agentName}` : ''}. Only the assigned reviewer can ${command}.`;
        }
        return `${task.id} was claimed by ${task.claim ? task.claim.agentName : 'unknown'}. Only the claiming agent can ${command}.`;
      }
      return null;
    case 'pm-review':
      if (role !== 'Project Manager') return 'pm-review is only allowed for Project Manager.';
      return null;
    case 'junior-help':
      if (role !== 'Junior') return 'junior-help is only allowed for Junior.';
      if (!own) {
        return `${task.id} was claimed by ${task.claim ? task.claim.agentName : 'unknown'}. Only the claiming agent can use junior-help.`;
      }
      return null;
    case 'pm-status':
      return 'pm-status is only allowed for Project Manager.';
    default:
      return null;
  }
}

module.exports = {
  TRANSITIONS,
  isOwnTask,
  isReviewOwner,
  requiresSeniorReviewOnComplete,
  isSeniorReviewApproval,
  checkTransition,
  checkPermission,
};
