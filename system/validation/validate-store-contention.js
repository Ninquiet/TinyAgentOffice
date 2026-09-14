'use strict';

// "database is locked", reproduced.
//
// Seen twice during the closing run, both times while cartridges were being
// activated in a burst -- so it fails exactly when the user is setting up the
// office and watching. The visible symptom is Auto Mode switching itself off,
// because the daemon exits on the error.
//
// WAL is enabled, so readers do not block writers. Two things made it happen
// anyway:
//
// 1. No busy_timeout. In WAL two writers still collide, and without a timeout
//    the loser gets SQLITE_BUSY immediately instead of waiting.
// 2. Every open ran ensureSchema, which is DDL. Reads go through openDatabase
//    without the file lock, so every read was a would-be writer sneaking past
//    the serialisation that protects the real ones. That is the bypass: the
//    writers were disciplined, the readers were not.
//
// This drives several processes at the coordination store at once, the way
// activating a fleet does.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const runtimeStore = require('../runtime/runtime-store');
const agentDaemon = require('../daemon/agent-daemon');

const WORKER = `
const runtimeStore = require(process.argv[2]);
const projectRoot = process.argv[3];
const mode = process.argv[4];
const options = { projectRoot };
const deadline = Date.now() + 2500;
let operations = 0;

try {
  while (Date.now() < deadline) {
    if (mode === 'writer') {
      runtimeStore.mutateCoordination(options, (state) => {
        state.registry.updatedAt = new Date().toISOString();
      });
      runtimeStore.appendWorkflowTransitions(options, [{
        at: new Date().toISOString(),
        sessionId: 'ses_stress',
        to: 'idle',
        eventType: 'stress',
      }]);
    } else {
      runtimeStore.readCoordinationState(options);
      runtimeStore.readPromptLedger(options);
      runtimeStore.readWorkflowTransitions(options, { limit: 10 });
    }
    operations += 1;
  }
  console.log(JSON.stringify({ ok: true, mode, operations }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, mode, operations, error: error.message }));
  process.exit(1);
}
`;

function runWorkers(projectRoot, workerPath, storePath) {
  const modes = ['writer', 'writer', 'reader', 'reader', 'reader'];
  const children = modes.map((mode) => spawn(
    process.execPath,
    [workerPath, storePath, projectRoot, mode],
    { encoding: 'utf8' }
  ));

  return Promise.all(children.map((child) => new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code, out: out.trim() }));
  })));
}

// The reproduction. Several processes reading and writing at once must not
// produce a lock error, because a lock error takes the daemon down with it.
async function assertConcurrentAccessDoesNotHitLockErrors() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-lock-'));
  const workerPath = path.join(projectRoot, 'worker.js');
  const storePath = path.resolve(__dirname, '..', 'runtime', 'runtime-store.js');

  try {
    runtimeStore.ensureInitialized({ projectRoot });
    runtimeStore.mutateCoordination({ projectRoot }, (state) => {
      state.registry.agents = [];
      state.tasksStore.tasks = [];
    });
    fs.writeFileSync(workerPath, WORKER, 'utf8');

    const results = await runWorkers(projectRoot, workerPath, storePath.split(path.sep).join('/'));
    const failures = results.filter((result) => result.code !== 0);

    assert.deepEqual(
      failures.map((failure) => failure.out),
      [],
      'concurrent access produced a lock error, which is what takes the daemon down'
    );

    const totals = results.map((result) => JSON.parse(result.out));
    const done = totals.reduce((sum, entry) => sum + entry.operations, 0);
    assert.ok(done > 0, 'no worker managed a single operation');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// Reads must not attempt DDL. The schema version is what lets an open skip it,
// and skipping it is what keeps a read from behaving like an unserialised
// writer.
function assertReadsDoNotRunSchemaStatements() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-ddl-'));
  try {
    runtimeStore.ensureInitialized({ projectRoot });
    const paths = runtimeStore.resolvePaths({ projectRoot });

    const probe = spawnSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(paths.dbPath)});
      console.log(JSON.stringify(db.prepare('PRAGMA user_version').get()));
      db.close();
    `], { encoding: 'utf8' });

    const version = JSON.parse(probe.stdout.trim()).user_version;
    assert.ok(version > 0, 'the schema has no version, so every open must re-run its DDL');
    assert.equal(version, runtimeStore.SCHEMA_VERSION);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// The version gate has to be directional.
//
// `version !== SCHEMA_VERSION` treats a downgrade exactly like an upgrade: an
// older binary opening a newer database runs its own DDL and stamps the version
// back down, and the newer one stamps it up again on its next open. Two
// processes with different versions -- the daemon and the dashboard are separate
// processes and can be out of step through any deploy -- then run DDL on every
// single open, which is the bypass this whole file exists to close.
//
// The deeper problem is that the older binary should not be writing at all. It
// does not know the columns or the constraints the newer schema added, so
// "degrade quietly and carry on" means writing data that violates rules it has
// never heard of. Failing loudly is the safe direction.
function assertAnOlderBinaryRefusesANewerDatabase() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-version-'));
  try {
    runtimeStore.ensureInitialized({ projectRoot });
    const paths = runtimeStore.resolvePaths({ projectRoot });

    // A database written by a future version of the app.
    const future = runtimeStore.SCHEMA_VERSION + 1;
    const stamp = new DatabaseSync(paths.dbPath);
    try {
      stamp.exec(`PRAGMA user_version = ${future};`);
    } finally {
      stamp.close();
    }

    assert.throws(
      () => runtimeStore.readCoordinationState({ projectRoot }),
      (error) => /newer version/i.test(error.message),
      'an older binary opened a newer database instead of refusing it'
    );

    // And it must not have touched anything on the way out.
    const probe = new DatabaseSync(paths.dbPath);
    try {
      assert.equal(
        probe.prepare('PRAGMA user_version').get().user_version,
        future,
        'the older binary stamped the schema version backwards'
      );
    } finally {
      probe.close();
    }
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// The other direction is the ordinary one and must keep working: a database
// written before a migration is brought up to date on first open.
function assertAnOlderDatabaseIsMigrated() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-migrate-'));
  try {
    runtimeStore.ensureInitialized({ projectRoot });
    const paths = runtimeStore.resolvePaths({ projectRoot });

    const stamp = new DatabaseSync(paths.dbPath);
    try {
      stamp.exec('PRAGMA user_version = 1;');
      stamp.exec('DROP TABLE IF EXISTS project_cartridges;');
    } finally {
      stamp.close();
    }

    assert.doesNotThrow(
      () => runtimeStore.readProjectCartridges({ projectRoot }),
      'an older database was not migrated on open'
    );

    const probe = new DatabaseSync(paths.dbPath);
    try {
      assert.equal(probe.prepare('PRAGMA user_version').get().user_version, runtimeStore.SCHEMA_VERSION);
    } finally {
      probe.close();
    }
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

// The daemon died on a lock error, and the loop already catches per-tick
// failures -- so the death came from somewhere else: updateDaemonStatus, which
// runs inside the catch block and writes to the same database. The daemon was
// killed while trying to record that a tick had failed.
//
// Status bookkeeping must never be able to take the process down. It is the
// least important write in the system and it sat on the most fragile path.
function assertStatusBookkeepingCannotKillTheDaemon() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-status-'));
  const realMutate = runtimeStore.mutateCoordination;
  try {
    runtimeStore.ensureInitialized({ projectRoot });
    runtimeStore.mutateCoordination = () => {
      const error = new Error('database is locked');
      error.code = 'SQLITE_BUSY';
      throw error;
    };

    assert.doesNotThrow(
      () => agentDaemon.updateDaemonStatus({ workspacePath: projectRoot }, { lastError: 'a tick failed' }),
      'a locked database while recording status took the daemon down'
    );
  } finally {
    runtimeStore.mutateCoordination = realMutate;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

async function main() {
  assertReadsDoNotRunSchemaStatements();
  assertAnOlderBinaryRefusesANewerDatabase();
  assertAnOlderDatabaseIsMigrated();
  assertStatusBookkeepingCannotKillTheDaemon();
  await assertConcurrentAccessDoesNotHitLockErrors();

  console.log('Store contention validation passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
