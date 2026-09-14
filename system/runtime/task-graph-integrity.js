'use strict';

const coordinationCore = require('./coordination-core');

function utcNow() {
  return new Date().toISOString();
}

function addIntegrityNote(task, text, extra = {}) {
  if (!task || typeof task !== 'object') return false;
  if (!Array.isArray(task.notes)) task.notes = [];
  if (task.notes.some((note) => note && note.kind === 'task-graph-integrity' && note.text === text)) {
    return false;
  }
  task.notes.push({
    kind: 'task-graph-integrity',
    text,
    createdAt: utcNow(),
    ...extra,
  });
  return true;
}

function taskMap(store) {
  return coordinationCore.buildTaskMap(store || {});
}

function ancestorIdsFor(task, map) {
  const ancestors = [];
  const seen = new Set();
  let current = task;

  while (current && current.parentId) {
    const parentId = current.parentId;
    if (seen.has(parentId)) break;
    seen.add(parentId);
    ancestors.push(parentId);
    current = map.get(parentId);
  }

  return ancestors;
}

function normalizeTaskPrerequisites(task, map) {
  if (!task || !Array.isArray(task.prerequisites)) return false;

  const forbidden = new Set([task.id, ...ancestorIdsFor(task, map)]);
  const original = task.prerequisites;
  const normalized = [];
  const removed = [];

  for (const prereqId of original) {
    if (!prereqId) continue;
    if (forbidden.has(prereqId)) {
      removed.push(prereqId);
      continue;
    }
    if (!normalized.includes(prereqId)) normalized.push(prereqId);
  }

  const changed = normalized.length !== original.length
    || normalized.some((entry, index) => entry !== original[index]);

  if (!changed) return false;

  task.prerequisites = normalized;
  addIntegrityNote(
    task,
    `Removed invalid prerequisite(s): ${removed.join(', ')}. A task cannot wait on itself, its parent, or an ancestor.`,
    { removedPrerequisites: removed }
  );
  return true;
}

function prerequisiteCycleFrom(task, map) {
  const visiting = new Set();
  const visited = new Set();

  function visit(current, path) {
    if (!current || visited.has(current.id)) return null;
    if (visiting.has(current.id)) {
      const start = path.indexOf(current.id);
      return start >= 0 ? path.slice(start).concat(current.id) : path.concat(current.id);
    }

    visiting.add(current.id);
    const nextPath = path.concat(current.id);
    for (const prereqId of current.prerequisites || []) {
      const cycle = visit(map.get(prereqId), nextPath);
      if (cycle) return cycle;
    }
    visiting.delete(current.id);
    visited.add(current.id);
    return null;
  }

  return visit(task, []);
}

function annotatePrerequisiteCycles(store, map) {
  let changed = false;
  for (const task of coordinationCore.allTasks(store || {})) {
    const cycle = prerequisiteCycleFrom(task, map);
    if (!cycle) continue;
    changed = addIntegrityNote(
      task,
      `Prerequisite cycle detected: ${cycle.join(' -> ')}. Manual task graph repair is required.`,
      { cycle }
    ) || changed;
  }
  return changed;
}

function normalizeTaskGraph(store) {
  const map = taskMap(store);
  let changed = false;

  for (const task of coordinationCore.allTasks(store || {})) {
    changed = normalizeTaskPrerequisites(task, map) || changed;
  }

  changed = annotatePrerequisiteCycles(store, map) || changed;

  if (changed && store) store.updatedAt = utcNow();
  return changed;
}

module.exports = {
  ancestorIdsFor,
  normalizeTaskGraph,
  normalizeTaskPrerequisites,
  prerequisiteCycleFrom,
};
