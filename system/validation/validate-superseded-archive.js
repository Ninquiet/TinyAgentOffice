'use strict';

const assert = require('assert');
const runtimeReconcile = require('../runtime/runtime-reconcile');

const state = {
  runs: [],
  daemonStatus: { running: false },
  registry: { agents: [] },
  tasksStore: {
    tasks: [
      {
        id: 'TASK-A',
        type: 'task',
        section: 'active',
        status: 'DONE',
        title: 'Original task',
        recommendedRole: 'Semi Senior',
        userReview: {
          state: 'declined',
          followUpTaskId: 'TASK-B',
        },
        workflow: {
          step: 'user_review',
          currentActorRole: 'User',
          currentActorSessionId: null,
        },
        notes: [],
      },
      {
        id: 'TASK-B',
        parentId: 'TASK-A',
        type: 'subtask',
        section: 'active',
        status: 'DONE',
        title: 'Follow-up task',
        recommendedRole: 'Semi Senior',
        workflow: {
          step: 'user_review',
          currentActorRole: 'User',
          currentActorSessionId: null,
        },
        notes: [],
      },
    ],
  },
};

const result = runtimeReconcile.reconcileSnapshot(state);
const original = state.tasksStore.tasks.find((task) => task.id === 'TASK-A');
const followUp = state.tasksStore.tasks.find((task) => task.id === 'TASK-B');

assert.strictEqual(result.changed, true, 'Superseded review should change state.');
assert.strictEqual(original.status, 'ARCHIVED', 'Superseded task should be archived.');
assert.strictEqual(original.workflow.step, 'closed', 'Archived superseded task should be closed.');
assert.ok(
  original.notes.some((note) => note.kind === 'superseded-archive' && note.followUpTaskId === 'TASK-B'),
  'Superseded archive note should identify the follow-up task.',
);
assert.strictEqual(followUp.status, 'DONE', 'Follow-up task should not be modified.');

const pendingState = {
  runs: [],
  daemonStatus: { running: false },
  registry: { agents: [] },
  tasksStore: {
    tasks: [
      {
        id: 'TASK-C',
        type: 'task',
        section: 'active',
        status: 'DONE',
        title: 'Original task with pending follow-up',
        recommendedRole: 'Semi Senior',
        userReview: {
          state: 'declined',
          followUpTaskId: 'TASK-D',
        },
        workflow: {
          step: 'follow_up_wait',
          currentActorRole: null,
          currentActorSessionId: null,
        },
        notes: [],
      },
      {
        id: 'TASK-D',
        parentId: 'TASK-C',
        type: 'subtask',
        section: 'active',
        status: 'TODO',
        title: 'Pending follow-up task',
        recommendedRole: 'Semi Senior',
        workflow: {
          step: 'implementation',
          currentActorRole: 'Semi Senior',
          currentActorSessionId: null,
        },
        notes: [],
      },
    ],
  },
};

const pendingResult = runtimeReconcile.reconcileSnapshot(pendingState);
const pendingOriginal = pendingState.tasksStore.tasks.find((task) => task.id === 'TASK-C');

assert.strictEqual(pendingResult.changed, false, 'Pending follow-up should not archive original task.');
assert.strictEqual(pendingOriginal.status, 'DONE', 'Original task should stay open while follow-up is pending.');

console.log('Superseded archive validation passed.');
