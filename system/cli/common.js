'use strict';

const coordinationCore = require('../runtime/coordination-core');
const runtimeStore = require('../runtime/runtime-store');

const ROLE_ALIASES = {
  pm: 'Project Manager',
  sp: 'Senior Pro',
  ss: 'Semi Senior',
  jr: 'Junior',
};

const ROLE_ACRONYMS = coordinationCore.ROLE_ACRONYMS;
const ROLE_RANK = coordinationCore.ROLE_RANK;
const VALID_ROLES = coordinationCore.VALID_ROLES;
const VALID_TASK_STATUSES = coordinationCore.VALID_TASK_STATUSES;
const SATISFIED_STATUSES = coordinationCore.SATISFIED_STATUSES;
const FINISHED_STATUSES = coordinationCore.FINISHED_STATUSES;
const TASKS_JSON_PATH = runtimeStore.DEFAULT_TASKS_PATH;
const REGISTRY_JSON_PATH = runtimeStore.DEFAULT_REGISTRY_PATH;

function utcNow() {
  return new Date().toISOString();
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeRole(role) {
  return coordinationCore.normalizeRole(role);
}

function requireRole(role) {
  return coordinationCore.requireRole(role);
}

function implementationRank(role) {
  return coordinationCore.implementationRank(role);
}

function createEmptyRegistry(resetAt = utcNow()) {
  const registry = runtimeStore.emptyRegistry();
  registry.resetAt = resetAt;
  registry.updatedAt = resetAt;
  return registry;
}

function readRuntimeState(options = {}) {
  return runtimeStore.readCoordinationState(options);
}

function readRegistry(registryPath, options = {}) {
  return readRuntimeState({ ...options, registryPath }).registry;
}

function readTasks(tasksPath, options = {}) {
  return readRuntimeState({ ...options, tasksPath }).tasksStore;
}

function mutateRuntime(options, mutate) {
  return runtimeStore.mutateCoordination(options, mutate);
}

function allTasks(store) {
  return coordinationCore.allTasks(store);
}

function activeTasks(store) {
  return coordinationCore.activeTasks(store);
}

function findTask(store, taskId) {
  for (const collection of ['tasks', 'nextTodo', 'history']) {
    const task = (store[collection] || []).find((entry) => entry.id === taskId);
    if (task) return { task, collection };
  }
  return null;
}

function buildTaskMap(store) {
  return coordinationCore.buildTaskMap(store);
}

function hasOpenSubtasks(task, tasks) {
  return coordinationCore.hasOpenSubtasks(task, tasks);
}

function normalizedTaskRole(task) {
  return coordinationCore.normalizedTaskRole(task);
}

module.exports = {
  coordinationCore,
  runtimeStore,
  ROLE_ALIASES,
  ROLE_ACRONYMS,
  ROLE_RANK,
  VALID_ROLES,
  VALID_TASK_STATUSES,
  SATISFIED_STATUSES,
  FINISHED_STATUSES,
  TASKS_JSON_PATH,
  REGISTRY_JSON_PATH,
  utcNow,
  slugify,
  normalizeRole,
  requireRole,
  implementationRank,
  createEmptyRegistry,
  readRuntimeState,
  readRegistry,
  readTasks,
  mutateRuntime,
  allTasks,
  activeTasks,
  findTask,
  buildTaskMap,
  hasOpenSubtasks,
  normalizedTaskRole,
};
