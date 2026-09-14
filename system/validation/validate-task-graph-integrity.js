'use strict';

const assert = require('assert');
const coordinationCore = require('../runtime/coordination-core');
const runtimeReconcile = require('../runtime/runtime-reconcile');

const state = {
  runs: [],
  daemonStatus: { running: false },
  registry: { agents: [] },
  tasksStore: {
    tasks: [
      {
        id: 'NEXT-011',
        parentId: null,
        type: 'task',
        section: 'active',
        status: 'TODO',
        title: 'Parent tracking task',
        recommendedRole: 'Semi Senior',
        prerequisites: [],
        children: ['NEXT-011.1'],
        notes: [],
      },
      {
        id: 'NEXT-011.1',
        parentId: 'NEXT-011',
        type: 'subtask',
        section: 'active',
        status: 'TODO',
        title: 'Child implementation task',
        recommendedRole: 'Semi Senior',
        prerequisites: ['NEXT-011'],
        children: [],
        notes: [],
      },
    ],
  },
};

const result = runtimeReconcile.reconcileSnapshot(state);
const child = state.tasksStore.tasks.find((task) => task.id === 'NEXT-011.1');
const query = coordinationCore.queryTasksForRole(state.tasksStore, 'Semi Senior', {});

assert.strictEqual(result.changed, true, 'Invalid parent prerequisite should be repaired.');
assert.deepStrictEqual(child.prerequisites, [], 'Child task must not keep its parent as prerequisite.');
assert.ok(
  child.notes.some((note) => note.kind === 'task-graph-integrity' && note.removedPrerequisites.includes('NEXT-011')),
  'Repair note should identify the removed parent prerequisite.',
);
assert.ok(
  query.claimable.some((task) => task.id === 'NEXT-011.1'),
  'The repaired child subtask should become claimable for Semi Senior.',
);
assert.ok(
  query.unavailable.some((task) => task.id === 'NEXT-011' && task.reasons.includes('Open subtasks exist. Claim the unlocked subtask instead.')),
  'Parent tracking task should remain unavailable while the child is open.',
);

console.log('Task graph integrity validation passed.');
