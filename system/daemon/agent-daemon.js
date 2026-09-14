'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const coordinationCore = require('../runtime/coordination-core');
const runtimeStore = require('../runtime/runtime-store');
const runtimeReconcile = require('../runtime/runtime-reconcile');
const sessionDispatch = require('../dispatch/session-dispatch');
const opencodeActivityWatchdog = require('../opencode/activity-watchdog');
const { APP_ROOT } = require('../core/project-workspace');
const { resolveLimits } = require('../runtime/runtime-policy');

const DEFAULT_INTERVAL_MS = 5000;

// Ceiling for the failure backoff. A transient lock clears in milliseconds; if
// something is wrong for longer than this, slowing down further does not help.
const MAX_BACKOFF_MS = 60000;

function utcNow() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const options = {
    command: 'run',
    tasksPath: runtimeStore.DEFAULT_TASKS_PATH,
    registryPath: runtimeStore.DEFAULT_REGISTRY_PATH,
    dbPath: null,
    runsPath: null,
    intervalMs: DEFAULT_INTERVAL_MS,
    json: false,
    workspacePath: APP_ROOT,
  };

  if (argv.length > 0 && !argv[0].startsWith('--')) {
    options.command = argv[0];
    argv = argv.slice(1);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tasks' && i + 1 < argv.length) {
      options.tasksPath = argv[++i];
    } else if (arg === '--registry' && i + 1 < argv.length) {
      options.registryPath = argv[++i];
    } else if (arg === '--db' && i + 1 < argv.length) {
      options.dbPath = argv[++i];
    } else if (arg === '--runs' && i + 1 < argv.length) {
      options.runsPath = argv[++i];
    } else if (arg === '--interval-ms' && i + 1 < argv.length) {
      options.intervalMs = Number(argv[++i]);
    } else if (arg === '--workspace' && i + 1 < argv.length) {
      options.workspacePath = path.resolve(argv[++i]);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1000) {
    throw new Error('--interval-ms must be an integer >= 1000.');
  }

  return options;
}

function printHelp() {
  console.log('Usage: node <tiny-agent-office>/system/agent-daemon.js <run|once|status> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --tasks <path>        Tasks JSON mirror path');
  console.log('  --registry <path>     Agent registry mirror path');
  console.log('  --db <path>           Runtime SQLite path');
  console.log('  --runs <path>         Run history mirror path');
  console.log('  --workspace <path>    Default workspace path for worker launches');
  console.log('  --interval-ms <ms>    Scheduler interval for run mode (default 5000)');
  console.log('  --json                Emit JSON output for once/status');
}

function runtimeOptions(options) {
  return {
    projectRoot: options.workspacePath,
    tasksPath: options.tasksPath,
    registryPath: options.registryPath,
    dbPath: options.dbPath,
    runsPath: options.runsPath,
  };
}

// Three conditions gate a dispatch, and each has a defined way to unblock:
//
//   runtimeState === 'idle'  -> events, the read-only rescue, or markStale
//   activeTaskId === null    -> the watchdog releasing after its grace period
//   no open ledger entry     -> closed on idle, or closed when a task is released
//
// These checks are advisory. The real gates are transactional -- the ledger
// reservation and the task reservation each decide atomically -- so this exists
// to avoid attempting the obviously impossible, not to be the last word.
function isSchedulableAgent(agent, context = {}) {
  if (!agent) return false;

  // Cheap operational guards first. They fail safe and cost nothing.
  if (agent.executionMode !== 'manual' || agent.disabled) return false;
  if (!Number.isInteger(agent.terminalPid) || !runtimeReconcile.isPidAlive(agent.terminalPid)) return false;
  if (agent.attentionRequired || agent.operationalStatus === 'error') return false;
  if (['attention', 'blocked'].includes(agent.status)) return false;

  // An agent that already owns a task is never scheduled. This is the rule the
  // whole incident came down to.
  if (agent.activeTaskId) return false;

  // The runtime's own verdict, not a status string somebody wrote earlier.
  // No verdict means we know nothing, and knowing nothing is not permission.
  const runtimeStateFor = typeof context.runtimeStateFor === 'function' ? context.runtimeStateFor : null;
  if (!runtimeStateFor || !agent.opencodeSessionId) return false;
  const runtime = runtimeStateFor(agent);
  if (!runtime || runtime.state !== 'idle') return false;

  // A prompt still in flight for this agent.
  const hasOpenPromptEntry = typeof context.hasOpenPromptEntry === 'function' ? context.hasOpenPromptEntry : null;
  if (!hasOpenPromptEntry || hasOpenPromptEntry(agent)) return false;

  return true;
}

// Never allowed to throw.
//
// This is the least important write in the system and it sat on the most
// fragile path: it runs inside the loop's catch block, so a locked database
// while recording that a tick had failed escaped runLoop entirely and hit
// main().catch, which exits the process. The daemon was dying while trying to
// write down that something had gone wrong -- and the user saw it as Auto Mode
// switching itself off during the burst of activating cartridges.
function updateDaemonStatus(options, patch) {
  try {
    runtimeStore.mutateCoordination(runtimeOptions(options), (state) => {
      state.daemonStatus = {
        ...state.daemonStatus,
        ...patch,
        updatedAt: utcNow(),
      };
    });
    return true;
  } catch (error) {
    // Losing a status update costs a stale field until the next tick. Losing
    // the daemon costs the whole office.
    console.error(`[daemon] could not record status: ${error.message}`);
    return false;
  }
}

function listSchedulableAgents(snapshot, context = {}) {
  return (snapshot.registry.agents || [])
    .filter((agent) => isSchedulableAgent(agent, context))
    .sort((a, b) => {
      const rankA = coordinationCore.implementationRank(a.role) ?? -1;
      const rankB = coordinationCore.implementationRank(b.role) ?? -1;
      if (rankA !== rankB) return rankB - rankA;
      return String(a.agentName).localeCompare(String(b.agentName));
    });
}

// The daemon reads the state machine and the ledger through the same modules
// the dashboard uses. It owns no notion of readiness of its own.
function schedulingContext(options, overrides = {}) {
  return {
    runtimeStateFor: overrides.runtimeStateFor
      || ((agent) => (agent.runtimeState ? { state: agent.runtimeState } : null)),
    hasOpenPromptEntry: overrides.hasOpenPromptEntry
      || ((agent) => runtimeStore.openPromptEntries(runtimeOptions(options), {
        agentSessionId: agent.sessionId,
      }).length > 0),
  };
}

async function runOnce(options, dependencies = {}) {
  const context = schedulingContext(options, dependencies);
  // Without this the ledger counts against no limits and refuses nothing: the
  // caps existed for days and never fired because nobody passed them.
  const limits = resolveLimits(options.limits || {});
  runtimeReconcile.reconcileCoordination(runtimeOptions(options));
  await opencodeActivityWatchdog.reconcileOpencodeActivity(runtimeOptions(options));
  runtimeReconcile.reconcileCoordination(runtimeOptions(options));
  const snapshot = runtimeStore.readCoordinationState(runtimeOptions(options));
  const agents = listSchedulableAgents(snapshot, context);
  const launches = [];
  const skipped = [];

  for (const agent of agents) {
    try {
      const currentSnapshot = runtimeStore.readCoordinationState(runtimeOptions(options));
      const currentAgent = (currentSnapshot.registry.agents || []).find((entry) => entry.sessionId === agent.sessionId);
      if (!isSchedulableAgent(currentAgent, context)) {
        skipped.push({
          agent: agent.agentName,
          assigned: false,
          message: 'Agent state changed before dispatch.',
        });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await sessionDispatch.dispatchNextTask(runtimeOptions(options), currentAgent.sessionId, { limits });
      // A refused reservation is a normal outcome: the caps exist to be hit.
      // Record why and move on to the next agent rather than failing the pass.
      if (result && result.delivered === false) {
        skipped.push({
          agent: currentAgent.agentName,
          assigned: false,
          message: `Dispatch refused: ${result.refusedReason}.`,
        });
        continue;
      }
      launches.push({
        runId: null,
        pid: currentAgent.terminalPid,
        agent: currentAgent.agentName,
        taskId: result.task.id,
      });
    } catch (error) {
      skipped.push({
        agent: agent.agentName,
        assigned: false,
        message: error.message,
      });
    }
  }

  updateDaemonStatus(options, {
    lastTickAt: utcNow(),
  });

  return {
    tickAt: utcNow(),
    launches,
    skipped,
    daemonManagedAgents: agents.length,
  };
}

async function runLoop(options) {
  updateDaemonStatus(options, {
    running: true,
    pid: process.pid,
    intervalMs: options.intervalMs,
    lastError: null,
  });

  const shutdown = () => {
    updateDaemonStatus(options, {
      running: false,
      pid: null,
      intervalMs: null,
      lastTickAt: utcNow(),
    });
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  let consecutiveFailures = 0;

  while (true) {
    try {
      const result = await runOnce(options);
      consecutiveFailures = 0;
      if (!options.json) {
        if (result.launches.length > 0) {
          result.launches.forEach((launch) => {
            console.log(`[daemon] launched ${launch.agent} on ${launch.taskId} (pid ${launch.pid})`);
          });
        } else {
          console.log('[daemon] no runnable daemon-managed work this tick');
        }
      }
    } catch (error) {
      consecutiveFailures += 1;
      updateDaemonStatus(options, {
        running: true,
        pid: process.pid,
        intervalMs: options.intervalMs,
        lastTickAt: utcNow(),
        lastError: error.message,
      });
      if (!options.json) {
        console.error(`[daemon] tick failed: ${error.message}`);
      }
    }

    // Back off when ticks keep failing, so a busy database is given room to
    // clear instead of being hammered at the normal cadence. Resets as soon as
    // a tick succeeds.
    const delay = consecutiveFailures > 0
      ? Math.min(options.intervalMs * (2 ** consecutiveFailures), MAX_BACKOFF_MS)
      : options.intervalMs;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function status(options) {
  runtimeReconcile.reconcileCoordination(runtimeOptions(options));
  const snapshot = runtimeStore.readCoordinationState(runtimeOptions(options));
  const liveRunMap = runtimeReconcile.buildLiveRunMap(snapshot.runs || []);
  return {
    daemonStatus: snapshot.daemonStatus,
    schedulableAgents: listSchedulableAgents(snapshot).map((agent) => ({
      sessionId: agent.sessionId,
      agentName: agent.agentName,
      role: agent.role,
      adapterType: agent.adapterType || null,
      executionMode: agent.executionMode || 'manual',
      disabled: Boolean(agent.disabled),
    })),
    runningChildren: [],
    liveRuns: Array.from(liveRunMap.values()).map((run) => ({
      runId: run.runId,
      agentSessionId: run.agentSessionId,
      agentName: run.agentName,
      taskId: run.taskId,
      workerPid: run.workerPid,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
    })),
    recentRuns: snapshot.runs,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'once') {
    const result = await runOnce(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : `Daemon tick completed. Launches: ${result.launches.length}`);
    return;
  }

  if (options.command === 'status') {
    const result = status(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : JSON.stringify(result, null, 2));
    return;
  }

  await runLoop(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Daemon failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  isSchedulableAgent,
  listSchedulableAgents,
  schedulingContext,
  updateDaemonStatus,
  runOnce,
  runLoop,
  status,
  main,
};

