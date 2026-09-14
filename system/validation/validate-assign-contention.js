'use strict';

// Two agents race for one task, and exactly one wins.
//
// Ported 2026-08-20. It used to seed `tasks.json` and `agents.json` and hand the
// CLI their paths -- which stopped meaning anything when the store moved to
// SQLite: `resolvePaths` derives the database path from the directory of the
// tasks file, so the CLI opened a fresh empty database next to the JSON and
// never read a word of it. The scenario was failing on its first assertion for
// that reason and nothing else.
//
// The property is unchanged and is covered nowhere else. `validate-store-
// contention` covers database locking, which is a different question; this is
// about task ownership, the class that has cost the most here.
//
// It was also never registered in `check`, so nobody saw it fail. That is the
// hole `validate-check-registration` now closes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const { APP_ROOT } = require('../core/project-workspace');
const runtimeStore = require('../runtime/runtime-store');

const workspaceRoot = APP_ROOT;
const cliPath = path.join(workspaceRoot, 'system', 'agent-coordination.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coord-assign-'));
}

// Seed through the store rather than by writing the JSON mirrors. The mirrors
// are written FROM the database, so seeding them is writing to an output.
function seedProject(tasks) {
  const projectRoot = makeTempDir();
  runtimeStore.ensureInitialized({ projectRoot });
  runtimeStore.mutateCoordination({ projectRoot }, (state) => {
    state.tasksStore.tasks = tasks;
    state.tasksStore.nextTodo = [];
    state.tasksStore.history = [];
    state.registry.agents = [];
  });
  return projectRoot;
}

function createStore() {
  return {
    schemaVersion: 1,
    updatedAt: '2026-06-29T00:00:00.000Z',
    tasks: [
      {
        id: 'T-ASSIGN-1',
        parentId: null,
        type: 'subtask',
        section: 'active',
        status: 'TODO',
        title: 'Single assignable task',
        recommendedRole: 'Semi Senior',
        priority: 'High',
        suggestedOwnerRole: null,
        goal: ['Validate assign behavior'],
        scope: ['Used as a temporary contention fixture'],
        prerequisites: [],
        claim: null,
        completedBy: null,
        completedAt: null,
        reports: [],
        notes: [],
        children: [],
        source: null,
        order: 10,
      },
    ],
    nextTodo: [],
    history: [],
  };
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
  });

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function runCliAsync(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('close', (status) => {
      resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseJsonResult(result, label) {
  assert(result.status === 0, `${label} failed: ${result.stderr || result.stdout}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }
}

function successScenario() {
  const tempDir = seedProject(createStore().tasks);

  const result = parseJsonResult(runCli([
    'assign',
    '--role', 'SS',
    '--name', 'Copper Harbor SS',
    '--project', tempDir,
    '--json',
  ], workspaceRoot), 'success scenario');

  assert(result.assigned === true, 'Success scenario should assign a task.');
  assert(result.task.id === 'T-ASSIGN-1', 'Success scenario should assign T-ASSIGN-1.');
  assert(result.task.title === 'Single assignable task', 'Assigned task title missing.');
  assert(result.task.status === 'CLAIMED', 'Assigned task should be CLAIMED.');
  assert(result.task.priority === 'High', 'Assigned task priority missing.');
  assert(result.task.recommendedRole === 'Semi Senior', 'Assigned task recommended role missing.');
  assert(Array.isArray(result.task.prerequisites), 'Assigned task prerequisites should be present.');
  assert(result.task.claim && result.task.claim.agentName === 'Copper Harbor SS', 'Assigned task claim info missing.');

  return 'success scenario ok';
}

function noTaskScenario() {
  const store = createStore();
  store.tasks[0].status = 'CLAIMED';
  store.tasks[0].claim = {
    agentName: 'Another Agent SS',
    role: 'Semi Senior',
    claimedAt: '2026-06-29T00:00:01.000Z',
  };
  const tempDir = seedProject(store.tasks);

  const result = parseJsonResult(runCli([
    'assign',
    '--role', 'SS',
    '--name', 'Copper Harbor SS',
    '--project', tempDir,
    '--json',
  ], workspaceRoot), 'no-task scenario');

  assert(result.assigned === false, 'No-task scenario should not assign a task.');
  assert(result.role === 'Semi Senior', 'No-task scenario should report normalized role.');
  assert(typeof result.message === 'string' && result.message.includes('No claimable active task'), 'No-task scenario should explain why nothing was assigned.');

  return 'no-task scenario ok';
}

async function contentionScenario() {
  const tempDir = seedProject(createStore().tasks);

  const baseArgs = ['assign', '--role', 'SS', '--project', tempDir, '--json'];
  const [first, second] = await Promise.all([
    runCliAsync([...baseArgs, '--name', 'Copper Harbor SS'], workspaceRoot),
    runCliAsync([...baseArgs, '--name', 'Amber Valley SS'], workspaceRoot),
  ]);

  const firstJson = parseJsonResult(first, 'contention scenario first process');
  const secondJson = parseJsonResult(second, 'contention scenario second process');
  const results = [firstJson, secondJson];
  const assigned = results.filter((entry) => entry.assigned === true);
  const rejected = results.filter((entry) => entry.assigned === false);

  assert(assigned.length === 1, `Contention scenario should produce exactly one assignment, got ${assigned.length}.`);
  assert(rejected.length === 1, `Contention scenario should reject exactly one agent, got ${rejected.length}.`);
  assert(assigned[0].task.id === 'T-ASSIGN-1', 'Contention winner should receive the only assignable task.');

  // Read the store, not the mirror: the mirror is written from it.
  const finalStore = runtimeStore.readCoordinationState({ projectRoot: tempDir }).tasksStore;
  assert(finalStore.tasks[0].status === 'CLAIMED', 'Final task status should remain CLAIMED after contention.');
  assert(
    finalStore.tasks[0].claim && finalStore.tasks[0].claim.agentName === assigned[0].task.claim.agentName,
    'Final store claim should match the winning agent.'
  );

  return `contention scenario ok (${assigned[0].task.claim.agentName} won)`;
}

async function main() {
  const checks = [];
  checks.push(successScenario());
  checks.push(noTaskScenario());
  checks.push(await contentionScenario());

  console.log('Atomic assign validation passed.');
  for (const check of checks) {
    console.log(`- ${check}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Atomic assign validation failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  main,
};
