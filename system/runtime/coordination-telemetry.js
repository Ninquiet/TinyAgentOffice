'use strict';

const fs = require('fs');
const path = require('path');
const runtimeStore = require('./runtime-store');

const ROLE_ORDER = ['Project Manager', 'Senior Pro', 'Semi Senior', 'Junior'];

function utcNow() {
  return new Date().toISOString();
}

function parseTimeMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function telemetryPath(paths) {
  return path.join(path.dirname(paths.dbPath), 'telemetry.json');
}

function readTelemetryState(paths) {
  const fallback = {
    schemaVersion: 1,
    resetAt: null,
    updatedAt: null,
  };
  try {
    if (!fs.existsSync(telemetryPath(paths))) return fallback;
    const parsed = JSON.parse(fs.readFileSync(telemetryPath(paths), 'utf8'));
    return {
      ...fallback,
      ...parsed,
    };
  } catch (_) {
    return fallback;
  }
}

function writeTelemetryState(paths, state) {
  fs.mkdirSync(path.dirname(telemetryPath(paths)), { recursive: true });
  fs.writeFileSync(telemetryPath(paths), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function ensureRole(metrics, role) {
  if (!metrics.roles[role]) {
    metrics.roles[role] = {
      role,
      dispatches: 0,
      completions: 0,
      reviews: 0,
      reports: 0,
      prompts: 0,
      duplicateDispatches: 0,
      lastActivityAt: null,
    };
  }
  return metrics.roles[role];
}

function isAfterReset(iso, resetMs) {
  if (resetMs == null) return true;
  const ms = parseTimeMs(iso);
  return ms != null && ms >= resetMs;
}

function noteActivity(entry, iso) {
  const ms = parseTimeMs(iso);
  if (ms == null) return;
  const current = parseTimeMs(entry.lastActivityAt);
  if (current == null || ms > current) {
    entry.lastActivityAt = new Date(ms).toISOString();
  }
}

function computeTelemetry(options = {}) {
  const snapshot = runtimeStore.readCoordinationState({ ...options, runLimit: null });
  const telemetryState = readTelemetryState(snapshot.paths);
  const resetMs = parseTimeMs(telemetryState.resetAt);
  const metrics = {
    generatedAt: utcNow(),
    resetAt: telemetryState.resetAt || null,
    roles: {},
    totals: {
      dispatches: 0,
      completions: 0,
      reviews: 0,
      reports: 0,
      prompts: 0,
      duplicateDispatches: 0,
    },
    anomalies: [],
  };

  for (const role of ROLE_ORDER) ensureRole(metrics, role);

  const dispatchBuckets = new Map();
  for (const run of snapshot.runs || []) {
    if (!isAfterReset(run.startedAt || run.updatedAt, resetMs)) continue;
    const role = run.role || 'Unknown';
    const entry = ensureRole(metrics, role);
    entry.dispatches += 1;
    entry.prompts += 1;
    metrics.totals.dispatches += 1;
    metrics.totals.prompts += 1;
    noteActivity(entry, run.startedAt || run.updatedAt);

    const bucketKey = [
      run.agentSessionId || '',
      run.taskId || '',
      run.command || 'dispatch',
      Math.floor((parseTimeMs(run.startedAt || run.updatedAt) || 0) / 30000),
    ].join('|');
    const bucketCount = (dispatchBuckets.get(bucketKey) || 0) + 1;
    dispatchBuckets.set(bucketKey, bucketCount);
    if (bucketCount === 2) {
      entry.duplicateDispatches += 1;
      metrics.totals.duplicateDispatches += 1;
      metrics.anomalies.push({
        kind: 'duplicate-dispatch',
        severity: 'warning',
        role,
        agentName: run.agentName || null,
        taskId: run.taskId || null,
        message: `${run.taskId || 'Task'} was dispatched repeatedly to ${run.agentName || role} within 30 seconds.`,
        at: run.startedAt || run.updatedAt || null,
      });
    }
  }

  for (const task of snapshot.tasksStore.tasks || []) {
    if (task.completedBy && isAfterReset(task.completedAt, resetMs)) {
      const role = task.reviewedBy && task.reviewedBy.agentName === task.completedBy
        ? task.reviewedBy.role
        : ((task.reports || []).find((report) => report.agentName === task.completedBy)?.role || 'Unknown');
      const entry = ensureRole(metrics, role);
      entry.completions += 1;
      metrics.totals.completions += 1;
      noteActivity(entry, task.completedAt);
    }

    if (task.reviewedBy && isAfterReset(task.reviewedBy.reviewedAt, resetMs)) {
      const entry = ensureRole(metrics, task.reviewedBy.role || 'Unknown');
      entry.reviews += 1;
      metrics.totals.reviews += 1;
      noteActivity(entry, task.reviewedBy.reviewedAt);
    }

    for (const report of task.reports || []) {
      const reportAt = report.createdAt || task.completedAt || task.reviewedBy?.reviewedAt || null;
      if (!isAfterReset(reportAt, resetMs)) continue;
      const entry = ensureRole(metrics, report.role || 'Unknown');
      entry.reports += 1;
      metrics.totals.reports += 1;
      noteActivity(entry, reportAt);
    }
  }

  return {
    ...metrics,
    roles: Object.values(metrics.roles),
  };
}

function resetTelemetry(options = {}) {
  const paths = runtimeStore.resolvePaths(options);
  const state = {
    schemaVersion: 1,
    resetAt: utcNow(),
    updatedAt: utcNow(),
  };
  writeTelemetryState(paths, state);
  return computeTelemetry(options);
}

module.exports = {
  computeTelemetry,
  resetTelemetry,
};
