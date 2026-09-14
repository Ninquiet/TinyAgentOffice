'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { APP_ROOT, getActiveProjectWorkspace } = require('../core/project-workspace');
const { ProjectPaths } = require('../core/project-paths');
const { TERMINAL_OUTCOMES, promptIdempotencyKey } = require('./prompt-lifecycle');
const {
  addInboxItem,
  createSecretaryMessage,
  emptySecretaryInbox,
  normalizeSecretaryInbox,
} = require('../core/secretary-inbox');

const WORKSPACE_ROOT = APP_ROOT;
const DEFAULT_TASKS_PATH = '.tiny-agent-office/coordination/tasks.json';
const DEFAULT_REGISTRY_PATH = '.tiny-agent-office/coordination/agents.json';
const DEFAULT_DB_NAME = 'runtime.db';
const DEFAULT_RUNS_NAME = 'runs.json';

// Bump when the schema changes. It is what lets an open skip ensureSchema:
// running CREATE TABLE IF NOT EXISTS on every open made every read attempt a
// write transaction, and reads do not hold the file lock -- so the readers were
// sneaking past the serialisation that protects the writers, and colliding.
const SCHEMA_VERSION = 3;

// Without this a writer that loses a WAL collision gets SQLITE_BUSY instantly
// instead of waiting. Five seconds is far longer than any transaction here,
// which are all short by construction.
const BUSY_TIMEOUT_MS = 5000;

function utcNow() {
  return new Date().toISOString();
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableFsError(error) {
  return Boolean(error && (
    error.code === 'EPERM'
    || error.code === 'EACCES'
    || error.code === 'EBUSY'
  ));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const attempts = 8;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.writeFileSync(tempPath, body, 'utf8');
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      if (attempt === attempts || !isRetryableFsError(error)) {
        try {
          if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
        } catch (_) {
          // Ignore cleanup failures and preserve the original error.
        }
        throw error;
      }

      sleepMs(25 * attempt);
    }
  }
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function acquireFileLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3000;
  const staleMs = options.staleMs ?? 30000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        acquiredAt: utcNow(),
      }, null, 2), 'utf8');
      return () => {
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = readLockOwner(lockPath);
        if (owner && Number.isInteger(owner.pid) && !processIsAlive(owner.pid)) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
        const stat = fs.statSync(lockPath);
        if ((Date.now() - stat.mtimeMs) > staleMs) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (_) {
        continue;
      }
      sleepMs(50);
    }
  }

  throw new Error(`Could not acquire lock for ${lockPath}.`);
}

function activeProjectRoot(options = {}) {
  return path.resolve(options.projectRoot || getActiveProjectWorkspace().projectRoot);
}

function resolveFromWorkspace(filePath, options = {}) {
  if (!filePath) return filePath;
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(activeProjectRoot(options), filePath);
}

function resolvePaths(options = {}) {
  const workspace = options.projectRoot
    ? { projectRoot: path.resolve(options.projectRoot), paths: new ProjectPaths(options.projectRoot) }
    : getActiveProjectWorkspace();
  const tasksPath = resolveFromWorkspace(options.tasksPath || workspace.paths.tasksFile || DEFAULT_TASKS_PATH, options);
  const registryPath = resolveFromWorkspace(options.registryPath || workspace.paths.registryFile || DEFAULT_REGISTRY_PATH, options);
  const baseDir = path.dirname(tasksPath);
  const dbPath = resolveFromWorkspace(options.dbPath || path.join(baseDir, DEFAULT_DB_NAME), options);
  const runsPath = resolveFromWorkspace(options.runsPath || path.join(baseDir, DEFAULT_RUNS_NAME), options);
  return {
    projectRoot: workspace.projectRoot,
    tasksPath,
    registryPath,
    dbPath,
    runsPath,
  };
}

function emptyTasksStore() {
  return {
    schemaVersion: 1,
    generatedAt: utcNow(),
    source: {
      format: 'runtime',
      path: '.tiny-agent-office/coordination/runtime.db',
    },
    tasks: [],
    nextTodo: [],
    history: [],
    updatedAt: utcNow(),
  };
}

function emptyRegistry() {
  const now = utcNow();
  return {
    schemaVersion: 1,
    resetAt: now,
    updatedAt: now,
    agents: [],
  };
}

function emptyDaemonStatus() {
  return {
    running: false,
    pid: null,
    intervalMs: null,
    lastTickAt: null,
    lastRunAt: null,
    lastError: null,
    updatedAt: utcNow(),
  };
}

function emptyUserTaskQueue() {
  return {
    schemaVersion: 1,
    pending: [],
    inFlight: null,
    history: [],
    updatedAt: utcNow(),
  };
}

function parseMetaValue(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function ensureSchema(db) {
  // Additive migrations for databases created before a column existed.
  // CREATE TABLE IF NOT EXISTS silently leaves an older table alone, so the
  // columns have to be added explicitly.
  const addColumn = (table, column, type) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
    } catch (_) {
      // Already present, which is the common case.
    }
  };

  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_snapshots (
      id TEXT PRIMARY KEY,
      collection_name TEXT NOT NULL,
      item_order INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_snapshots (
      session_id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT,
      last_seen_at TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      session_id TEXT,
      agent_session_id TEXT,
      agent_name TEXT,
      role TEXT,
      task_id TEXT,
      from_state TEXT,
      to_state TEXT NOT NULL,
      event_type TEXT,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS prompt_ledger (
      idempotency_key TEXT PRIMARY KEY,
      agent_session_id TEXT NOT NULL,
      task_id TEXT,
      command TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      transport_status TEXT NOT NULL,
      outcome_status TEXT NOT NULL,
      message_id TEXT,
      cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      appended_at TEXT,
      submitted_at TEXT,
      admitted_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      delivery_verified INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER
    );
    CREATE INDEX IF NOT EXISTS prompt_ledger_task ON prompt_ledger (task_id);
    CREATE INDEX IF NOT EXISTS prompt_ledger_session ON prompt_ledger (agent_session_id);
    CREATE INDEX IF NOT EXISTS workflow_transitions_task ON workflow_transitions (task_id);
    CREATE INDEX IF NOT EXISTS workflow_transitions_session ON workflow_transitions (session_id);
    CREATE TABLE IF NOT EXISTS project_cartridges (
      id TEXT PRIMARY KEY,
      template_id TEXT,
      definition_json TEXT,
      position_x REAL NOT NULL,
      position_y REAL NOT NULL,
      slot_id TEXT,
      activated INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- One instance per template per project, as a constraint rather than a
    -- check in a caller. A partial index, so the many unlinked cartridges --
    -- which all have a NULL template -- do not collide with each other.
    CREATE UNIQUE INDEX IF NOT EXISTS project_cartridges_template
      ON project_cartridges (template_id) WHERE template_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      agent_session_id TEXT,
      agent_name TEXT,
      role TEXT,
      task_id TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      payload_json TEXT NOT NULL
    );
  `);

  for (const column of ['input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
    addColumn('prompt_ledger', column, 'INTEGER');
  }
}

function runTransaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // Ignore rollback errors so the original failure is preserved.
    }
    throw error;
  }
}

function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value_json FROM meta WHERE key = ?').get(key);
  return parseMetaValue(row ? row.value_json : null, fallback);
}

function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO meta (key, value_json)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(key, JSON.stringify(value));
}

function loadTasksStore(db) {
  const store = emptyTasksStore();
  store.schemaVersion = getMeta(db, 'tasks.schemaVersion', 1);
  store.generatedAt = getMeta(db, 'tasks.generatedAt', store.generatedAt);
  store.source = getMeta(db, 'tasks.source', store.source);
  store.updatedAt = getMeta(db, 'tasks.updatedAt', store.updatedAt);

  const rows = db.prepare(`
    SELECT collection_name, payload_json
    FROM task_snapshots
    ORDER BY
      CASE collection_name
        WHEN 'tasks' THEN 0
        WHEN 'nextTodo' THEN 1
        ELSE 2
      END,
      item_order ASC,
      id ASC
  `).all();

  for (const row of rows) {
    const task = JSON.parse(row.payload_json);
    if (row.collection_name === 'tasks') store.tasks.push(task);
    else if (row.collection_name === 'nextTodo') store.nextTodo.push(task);
    else store.history.push(task);
  }

  return store;
}

function loadRegistry(db) {
  const registry = emptyRegistry();
  registry.schemaVersion = getMeta(db, 'registry.schemaVersion', 1);
  registry.resetAt = getMeta(db, 'registry.resetAt', registry.resetAt);
  registry.updatedAt = getMeta(db, 'registry.updatedAt', registry.updatedAt);

  const rows = db.prepare(`
    SELECT payload_json
    FROM agent_snapshots
    ORDER BY role ASC, agent_name ASC, session_id ASC
  `).all();

  registry.agents = rows.map((row) => JSON.parse(row.payload_json));
  return registry;
}

function saveTasksStore(db, store) {
  const deleteTasks = db.prepare('DELETE FROM task_snapshots');
  const insertTask = db.prepare(`
    INSERT INTO task_snapshots (id, collection_name, item_order, payload_json)
    VALUES (?, ?, ?, ?)
  `);

  deleteTasks.run();

  const collections = [
    ['tasks', store.tasks || []],
    ['nextTodo', store.nextTodo || []],
    ['history', store.history || []],
  ];

  for (const [collectionName, entries] of collections) {
    entries.forEach((entry, index) => {
      insertTask.run(entry.id, collectionName, Number.isFinite(entry.order) ? entry.order : (index + 1) * 10, JSON.stringify(entry));
    });
  }

  setMeta(db, 'tasks.schemaVersion', store.schemaVersion || 1);
  setMeta(db, 'tasks.generatedAt', store.generatedAt || utcNow());
  setMeta(db, 'tasks.source', store.source || { format: 'runtime', path: '.tiny-agent-office/coordination/runtime.db' });
  setMeta(db, 'tasks.updatedAt', store.updatedAt || utcNow());
}

function saveRegistry(db, registry) {
  const deleteAgents = db.prepare('DELETE FROM agent_snapshots');
  const insertAgent = db.prepare(`
    INSERT INTO agent_snapshots (session_id, agent_name, role, status, last_seen_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  deleteAgents.run();
  for (const agent of registry.agents || []) {
    insertAgent.run(
      agent.sessionId,
      agent.agentName,
      agent.role,
      agent.status || null,
      agent.lastSeenAt || null,
      JSON.stringify(agent)
    );
  }

  setMeta(db, 'registry.schemaVersion', registry.schemaVersion || 1);
  setMeta(db, 'registry.resetAt', registry.resetAt || utcNow());
  setMeta(db, 'registry.updatedAt', registry.updatedAt || utcNow());
}

function loadRuns(db, limit = null) {
  if (limit === null || limit === undefined) {
    return db.prepare(`
      SELECT payload_json
      FROM runs
      ORDER BY updated_at DESC, started_at DESC
    `).all().map((row) => JSON.parse(row.payload_json));
  }

  const stmt = db.prepare(`
    SELECT payload_json
    FROM runs
    ORDER BY updated_at DESC, started_at DESC
    LIMIT ?
  `);
  return stmt.all(limit).map((row) => JSON.parse(row.payload_json));
}

function saveRun(db, run) {
  db.prepare(`
    INSERT INTO runs (
      run_id,
      started_at,
      updated_at,
      agent_session_id,
      agent_name,
      role,
      task_id,
      status,
      exit_code,
      payload_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      started_at = excluded.started_at,
      updated_at = excluded.updated_at,
      agent_session_id = excluded.agent_session_id,
      agent_name = excluded.agent_name,
      role = excluded.role,
      task_id = excluded.task_id,
      status = excluded.status,
      exit_code = excluded.exit_code,
      payload_json = excluded.payload_json
  `).run(
    run.runId,
    run.startedAt,
    run.updatedAt,
    run.agentSessionId || null,
    run.agentName || null,
    run.role || null,
    run.taskId || null,
    run.status,
    Number.isInteger(run.exitCode) ? run.exitCode : null,
    JSON.stringify(run)
  );
}

function saveRuns(db, runs) {
  db.prepare('DELETE FROM runs').run();
  for (const run of runs || []) {
    saveRun(db, run);
  }
}

function mirrorRunsJson(db, paths, limit = 50) {
  atomicWriteJson(paths.runsPath, {
    updatedAt: utcNow(),
    runs: loadRuns(db, limit),
  });
}

// Only ever reached through ensureInitialized, never from openDatabase. Lazy
// initialization on the read path meant a plain read could write, and did so
// without holding the file lock, since readCoordinationState does not take it.
function bootstrapDb(db, paths) {
  const alreadySeeded = db.prepare('SELECT COUNT(*) AS count FROM meta WHERE key = ?').get('bootstrap.seededAt').count > 0;
  if (alreadySeeded) return false;

  const taskCount = db.prepare('SELECT COUNT(*) AS count FROM task_snapshots').get().count;
  const agentCount = db.prepare('SELECT COUNT(*) AS count FROM agent_snapshots').get().count;
  const hasDaemonMeta = db.prepare('SELECT COUNT(*) AS count FROM meta WHERE key = ?').get('daemon.status').count > 0;
  let seededFromJson = false;

  runTransaction(db, () => {
    if (taskCount === 0) {
      saveTasksStore(db, readJson(paths.tasksPath, emptyTasksStore()));
      seededFromJson = true;
    }
    if (agentCount === 0) {
      saveRegistry(db, readJson(paths.registryPath, emptyRegistry()));
      seededFromJson = true;
    }
    if (!hasDaemonMeta) {
      setMeta(db, 'daemon.status', emptyDaemonStatus());
    }
    setMeta(db, 'bootstrap.seededAt', utcNow());
  });

  if (seededFromJson) {
    atomicWriteJson(paths.tasksPath, loadTasksStore(db));
    atomicWriteJson(paths.registryPath, loadRegistry(db));
    mirrorRunsJson(db, paths);
  }

  return true;
}

// Opens and migrates the schema. Deliberately does not seed: seeding is a write,
// and this runs on the read path too. Call ensureInitialized for that.
function openDatabase(paths) {
  fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });
  const db = new DatabaseSync(paths.dbPath);

  // Wait for a busy database rather than failing instantly. This is the
  // difference between a momentary collision and the daemon exiting.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);

  // Only touch the schema when this database has not been brought up to the
  // current version. Reading a pragma is a pure read; the DDL below is not,
  // and running it on every open is what made reads collide with writes.
  //
  // The comparison is directional on purpose. `!==` treated a downgrade like an
  // upgrade: an older binary opening a newer database ran its own DDL and
  // stamped the version back down, the newer one stamped it up again, and two
  // processes out of step -- the daemon and the dashboard are separate
  // processes and any deploy can leave them that way -- then ran DDL on every
  // open, which is exactly the bypass this gate was added to close.
  //
  // A newer database is refused rather than downgraded. An older binary does
  // not know the columns or the constraints a later schema added, so carrying
  // on means writing data that breaks rules it has never heard of. Stopping
  // with an explanation is the safe direction.
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `${paths.dbPath} was written by a newer version of the app `
      + `(database schema ${version}, this build understands ${SCHEMA_VERSION}). `
      + 'Update the app, or point it at a different project.'
    );
  }
  if (version < SCHEMA_VERSION) {
    ensureSchema(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  return db;
}

function withLockedDb(options, action) {
  const paths = resolvePaths(options);
  // The lock is a directory created without `recursive`, so its parent has to
  // exist before we try to take it. openDatabase creates it, but that runs after
  // the lock: on a brand new project the very first locked call would fail.
  fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });
  const release = acquireFileLock(`${paths.dbPath}.lock`);
  const db = openDatabase(paths);
  try {
    return action(db, paths);
  } finally {
    db.close();
    release();
  }
}

// Seeds a brand new database from the JSON mirrors, exactly once, under the file
// lock. Call this explicitly when a process starts and from the world tick; the
// read path must never trigger it.
function ensureInitialized(options = {}) {
  return withLockedDb(options, (db, paths) => ({
    seeded: bootstrapDb(db, paths),
  }));
}

function readCoordinationState(options = {}) {
  const paths = resolvePaths(options);
  const db = openDatabase(paths);
  try {
    const runLimit = Object.prototype.hasOwnProperty.call(options, 'runLimit')
      ? options.runLimit
      : null;
    return {
      paths,
      tasksStore: loadTasksStore(db),
      registry: loadRegistry(db),
      daemonStatus: getMeta(db, 'daemon.status', emptyDaemonStatus()),
      userTaskQueue: getMeta(db, 'userTaskQueue', emptyUserTaskQueue()),
      secretaryInbox: normalizeSecretaryInbox(getMeta(db, 'secretaryInbox', emptySecretaryInbox())),
      runs: loadRuns(db, runLimit),
    };
  } finally {
    db.close();
  }
}

function mutateCoordination(options = {}, mutate) {
  return withLockedDb(options, (db, paths) => {
    const state = {
      paths,
      tasksStore: loadTasksStore(db),
      registry: loadRegistry(db),
      daemonStatus: getMeta(db, 'daemon.status', emptyDaemonStatus()),
      userTaskQueue: getMeta(db, 'userTaskQueue', emptyUserTaskQueue()),
      secretaryInbox: normalizeSecretaryInbox(getMeta(db, 'secretaryInbox', emptySecretaryInbox())),
      runs: loadRuns(db, null),
    };

    return runTransaction(db, () => {
      const result = mutate(state, db) || {};
      saveTasksStore(db, state.tasksStore);
      saveRegistry(db, state.registry);
      saveRuns(db, state.runs);
      setMeta(db, 'daemon.status', state.daemonStatus || emptyDaemonStatus());
      setMeta(db, 'userTaskQueue', state.userTaskQueue || emptyUserTaskQueue());
      setMeta(db, 'secretaryInbox', normalizeSecretaryInbox(state.secretaryInbox));
      atomicWriteJson(paths.tasksPath, state.tasksStore);
      atomicWriteJson(paths.registryPath, state.registry);
      mirrorRunsJson(db, paths);
      return result;
    });
  });
}

// Append-only log of workflow state transitions.
//
// Deliberately NOT routed through mutateCoordination: that rewrites all three
// JSON mirrors and holds the lock for the whole coordination state, which on a
// per-tick write would undo the performance work of separating the render path
// from the world tick. This takes the lock, inserts the batch, and leaves.
//
// Nothing prunes this table. It is the accumulation layer the employee history
// and the task-journey view are built from, so expiring it by default would
// throw away the progression before it exists.
function appendWorkflowTransitions(options = {}, transitions = []) {
  if (!Array.isArray(transitions) || transitions.length === 0) return { written: 0 };

  return withLockedDb(options, (db) => runTransaction(db, () => {
    const insert = db.prepare(`
      INSERT INTO workflow_transitions
        (at, session_id, agent_session_id, agent_name, role, task_id, from_state, to_state, event_type, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const entry of transitions) {
      insert.run(
        entry.at || utcNow(),
        entry.sessionId || null,
        entry.agentSessionId || null,
        entry.agentName || null,
        entry.role || null,
        entry.taskId || null,
        entry.from || null,
        entry.to,
        entry.eventType || null,
        entry.reason || null
      );
    }

    return { written: transitions.length };
  }));
}

function readWorkflowTransitions(options = {}, query = {}) {
  const paths = resolvePaths(options);
  const db = openDatabase(paths);
  try {
    const filters = [];
    const params = [];
    if (query.taskId) {
      filters.push('task_id = ?');
      params.push(query.taskId);
    }
    if (query.sessionId) {
      filters.push('session_id = ?');
      params.push(query.sessionId);
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    // limit 0 means everything; the default is a diagnostic window, not a
    // retention policy.
    const limit = Object.prototype.hasOwnProperty.call(query, 'limit') ? query.limit : 500;
    const limitClause = Number.isInteger(limit) && limit > 0 ? `LIMIT ${limit}` : '';

    return db.prepare(`
      SELECT at, session_id, agent_session_id, agent_name, role, task_id,
             from_state, to_state, event_type, reason
      FROM workflow_transitions
      ${where}
      ORDER BY id ASC
      ${limitClause}
    `).all(...params).map((row) => ({
      at: row.at,
      sessionId: row.session_id,
      agentSessionId: row.agent_session_id,
      agentName: row.agent_name,
      role: row.role,
      taskId: row.task_id,
      fromState: row.from_state,
      toState: row.to_state,
      eventType: row.event_type,
      reason: row.reason,
    }));
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------------
// Project cartridges.
//
// Where the user placed each cartridge in this project, and which template it
// follows. Architecture review finding 07: this lived in the browser's
// localStorage, keyed per project, and was reloaded with `activated: false`
// forced on -- so a refresh made the UI forget what was running while this
// process still held the live sessions.
//
// A narrow write path, like appendWorkflowTransitions: it takes the lock, writes
// its own table, and leaves the JSON mirrors alone. Placement is committed when a
// drag ends, so rewriting tasks.json on every drop would put a cosmetic gesture
// on the hot write path.
//
// `definition_json` is NULL while a cartridge follows a template: the definition
// belongs to the template, and a private copy here is what would make
// propagation impossible. It is filled in at the moment the link is broken.
// --------------------------------------------------------------------------

function mapCartridgeRow(row) {
  return {
    id: row.id,
    templateId: row.template_id,
    definition: row.definition_json ? JSON.parse(row.definition_json) : null,
    x: row.position_x,
    y: row.position_y,
    slotId: row.slot_id,
    activated: Boolean(row.activated),
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readProjectCartridges(options = {}) {
  const paths = resolvePaths(options);
  const db = openDatabase(paths);
  try {
    return db.prepare('SELECT * FROM project_cartridges ORDER BY created_at ASC, id ASC')
      .all()
      .map(mapCartridgeRow);
  } finally {
    db.close();
  }
}

// Returns { saved: true, cartridge } or { saved: false, reason }. Refusing is a
// normal outcome here: dragging a template into a project that already has an
// instance of it is something a user can simply do, and the answer is a hint
// rather than an error.
//
// The unique index is what actually holds the rule. This check exists to give
// the refusal a name; a path that forgets to read it gets a constraint error
// instead of a second instance.
function saveProjectCartridge(options = {}, cartridge = {}) {
  if (!cartridge || typeof cartridge.id !== 'string' || !cartridge.id) {
    throw new Error('A cartridge needs an id.');
  }

  return withLockedDb(options, (db) => runTransaction(db, () => {
    const templateId = cartridge.templateId || null;

    if (templateId) {
      const clash = db
        .prepare('SELECT id FROM project_cartridges WHERE template_id = ? AND id <> ?')
        .get(templateId, cartridge.id);
      if (clash) {
        return { saved: false, reason: 'duplicate-template', existingId: clash.id };
      }
    }

    const now = utcNow();
    const existing = db.prepare('SELECT created_at FROM project_cartridges WHERE id = ?').get(cartridge.id);

    db.prepare(`
      INSERT INTO project_cartridges
        (id, template_id, definition_json, position_x, position_y, slot_id, activated, session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        template_id = excluded.template_id,
        definition_json = excluded.definition_json,
        position_x = excluded.position_x,
        position_y = excluded.position_y,
        slot_id = excluded.slot_id,
        activated = excluded.activated,
        session_id = excluded.session_id,
        updated_at = excluded.updated_at
    `).run(
      cartridge.id,
      templateId,
      cartridge.definition ? JSON.stringify(cartridge.definition) : null,
      Number(cartridge.x) || 0,
      Number(cartridge.y) || 0,
      cartridge.slotId || null,
      cartridge.activated ? 1 : 0,
      cartridge.sessionId || null,
      (existing && existing.created_at) || now,
      now
    );

    return {
      saved: true,
      cartridge: mapCartridgeRow(
        db.prepare('SELECT * FROM project_cartridges WHERE id = ?').get(cartridge.id)
      ),
    };
  }));
}

function removeProjectCartridge(options = {}, id) {
  if (!id) return { removed: 0 };
  return withLockedDb(options, (db) => runTransaction(db, () => ({
    removed: db.prepare('DELETE FROM project_cartridges WHERE id = ?').run(id).changes,
  })));
}

// The one-time import of what the browser was holding.
//
// The obvious condition -- import when the store is empty -- resurrects data: a
// user who deletes every cartridge leaves an empty store, and the next time the
// project is opened the browser's copy comes back. So the fact that the import
// ran is recorded, and it is recorded here rather than in localStorage, where a
// second browser profile would not see it.
// `force` exists because this is the one step a user cannot undo. If the import
// goes wrong -- half the cartridges, positions lost -- the marker is set and the
// ordinary path will not run again, and the only remedy would be editing the
// database by hand. The source data is still in localStorage, so the fix is a
// door rather than a rescue. A forced run repairs rows instead of skipping them,
// since re-running is only useful if it can correct what came in wrong; it will
// therefore overwrite placements changed since, which is why nothing triggers it
// automatically.
function importLegacyProjectCartridges(options = {}, cartridges = [], { force = false } = {}) {
  return withLockedDb(options, (db, paths) => runTransaction(db, () => {
    const done = getMeta(db, 'cartridges.importedAt', null);
    if (done && !force) return { imported: 0, reason: 'already-imported', importedAt: done };

    const now = utcNow();
    let imported = 0;

    for (const cartridge of Array.isArray(cartridges) ? cartridges : []) {
      if (!cartridge || typeof cartridge.id !== 'string' || !cartridge.id) continue;
      const templateId = cartridge.templateId || null;
      if (templateId) {
        const clash = db
          .prepare('SELECT id FROM project_cartridges WHERE template_id = ? AND id <> ?')
          .get(templateId, cartridge.id);
        if (clash) continue;
      }
      db.prepare(`
        INSERT INTO project_cartridges
          (id, template_id, definition_json, position_x, position_y, slot_id, activated, session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          template_id = excluded.template_id,
          definition_json = excluded.definition_json,
          position_x = excluded.position_x,
          position_y = excluded.position_y,
          slot_id = excluded.slot_id,
          activated = excluded.activated,
          session_id = excluded.session_id,
          updated_at = excluded.updated_at
      `).run(
        cartridge.id,
        templateId,
        cartridge.definition ? JSON.stringify(cartridge.definition) : null,
        Number(cartridge.x) || 0,
        Number(cartridge.y) || 0,
        cartridge.slotId || null,
        cartridge.activated ? 1 : 0,
        cartridge.sessionId || null,
        now,
        now
      );
      imported += 1;
    }

    setMeta(db, 'cartridges.importedAt', now);
    return { imported, importedAt: now };
  }));
}

// --------------------------------------------------------------------------
// Prompt ledger.
//
// Idempotency and the spend caps solve two different problems. Idempotency
// stops the same prompt being delivered twice. It does nothing about thirteen
// legitimately different prompts against one task, which is what actually
// exhausted the quota -- only a cap stops that.
//
// Both checks run inside the reservation transaction, deliberately. A caller
// that checks and then reserves is two dispatchers each passing their own
// check and both proceeding.
// --------------------------------------------------------------------------

function mapLedgerRow(row) {
  if (!row) return null;
  return {
    idempotencyKey: row.idempotency_key,
    agentSessionId: row.agent_session_id,
    taskId: row.task_id,
    command: row.command,
    promptHash: row.prompt_hash,
    transportStatus: row.transport_status,
    outcomeStatus: row.outcome_status,
    messageId: row.message_id,
    cost: row.cost,
    createdAt: row.created_at,
    appendedAt: row.appended_at,
    submittedAt: row.submitted_at,
    admittedAt: row.admitted_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
    deliveryVerified: Boolean(row.delivery_verified),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
  };
}

// Returns { reserved: true, entry } or { reserved: false, reason }. Nothing is
// written when a reservation is refused.
function reservePrompt(options = {}, request = {}, limits = {}) {
  const idempotencyKey = promptIdempotencyKey(request);

  return withLockedDb(options, (db) => runTransaction(db, () => {
    const existing = mapLedgerRow(
      db.prepare('SELECT * FROM prompt_ledger WHERE idempotency_key = ?').get(idempotencyKey)
    );

    if (existing) {
      if (!TERMINAL_OUTCOMES.has(existing.outcomeStatus)) {
        return { reserved: false, reason: 'duplicate', entry: existing };
      }
      // Failing once the prompt was already submitted means the agent may have
      // acted on it. Recovery is a decision, not an automatic retry.
      if (existing.outcomeStatus === 'failed' && existing.transportStatus === 'submitted') {
        return { reserved: false, reason: 'failed-after-submit', entry: existing };
      }
      if (existing.outcomeStatus === 'completed') {
        return { reserved: false, reason: 'already-completed', entry: existing };
      }
    }

    if (Number.isInteger(limits.maxPromptsPerTask) && request.taskId) {
      const used = db.prepare('SELECT COUNT(*) AS count FROM prompt_ledger WHERE task_id = ?').get(request.taskId).count;
      if (used >= limits.maxPromptsPerTask) {
        return { reserved: false, reason: 'task-prompt-cap', used, limit: limits.maxPromptsPerTask };
      }
    }

    if (Number.isFinite(limits.maxSessionCost)) {
      const spent = db.prepare('SELECT COALESCE(SUM(cost), 0) AS total FROM prompt_ledger WHERE agent_session_id = ?')
        .get(request.agentSessionId).total;
      if (spent >= limits.maxSessionCost) {
        return { reserved: false, reason: 'session-spend-cap', spent, limit: limits.maxSessionCost };
      }
    }

    const now = utcNow();
    db.prepare(`
      INSERT INTO prompt_ledger
        (idempotency_key, agent_session_id, task_id, command, prompt_hash,
         transport_status, outcome_status, cost, created_at)
      VALUES (?, ?, ?, ?, ?, 'created', 'pending', 0, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        transport_status = 'created',
        outcome_status = 'pending',
        message_id = NULL,
        last_error = NULL,
        delivery_verified = 0,
        created_at = excluded.created_at
    `).run(
      idempotencyKey,
      request.agentSessionId,
      request.taskId || null,
      request.command,
      request.promptHash,
      now
    );

    return {
      reserved: true,
      entry: mapLedgerRow(db.prepare('SELECT * FROM prompt_ledger WHERE idempotency_key = ?').get(idempotencyKey)),
    };
  }));
}

const TRANSPORT_TIMESTAMPS = { appended: 'appended_at', submitted: 'submitted_at' };
const OUTCOME_TIMESTAMPS = { admitted: 'admitted_at', completed: 'completed_at' };

function recordPromptTransport(options = {}, idempotencyKey, transportStatus, details = {}) {
  return withLockedDb(options, (db) => runTransaction(db, () => {
    const column = TRANSPORT_TIMESTAMPS[transportStatus];
    const sql = [
      'UPDATE prompt_ledger SET transport_status = ?, delivery_verified = COALESCE(?, delivery_verified)',
      column ? ', ' + column + ' = ?' : '',
      ' WHERE idempotency_key = ?',
    ].join('');
    const params = [
      transportStatus,
      details.deliveryVerified === undefined ? null : (details.deliveryVerified ? 1 : 0),
    ];
    if (column) params.push(utcNow());
    params.push(idempotencyKey);
    db.prepare(sql).run(...params);
    return { idempotencyKey, transportStatus };
  }));
}

function recordPromptOutcome(options = {}, idempotencyKey, outcomeStatus, details = {}) {
  return withLockedDb(options, (db) => runTransaction(db, () => {
    const column = OUTCOME_TIMESTAMPS[outcomeStatus];
    const sql = [
      'UPDATE prompt_ledger SET outcome_status = ?, message_id = COALESCE(?, message_id),',
      ' last_error = COALESCE(?, last_error), cost = cost + ?',
      column ? ', ' + column + ' = ?' : '',
      ' WHERE idempotency_key = ?',
    ].join('');
    const params = [
      outcomeStatus,
      details.messageId || null,
      details.error || null,
      Number.isFinite(details.cost) ? details.cost : 0,
    ];
    if (column) params.push(utcNow());
    params.push(idempotencyKey);
    db.prepare(sql).run(...params);
    return { idempotencyKey, outcomeStatus };
  }));
}

// Entries that have not reached a terminal outcome yet.
//
// `admitted` is deliberately not terminal: OpenCode taking the prompt is not
// the turn being over. But that means something has to finish these, or the
// first prompt delivered to an agent leaves a row open forever and any
// scheduler rule of the form "no open entry" locks the office permanently.
function openPromptEntries(options = {}, query = {}) {
  const paths = resolvePaths(options);
  const db = openDatabase(paths);
  try {
    const filters = ["outcome_status NOT IN ('completed', 'failed', 'cancelled')"];
    const params = [];
    if (query.agentSessionId) {
      filters.push('agent_session_id = ?');
      params.push(query.agentSessionId);
    }
    if (query.taskId) {
      filters.push('task_id = ?');
      params.push(query.taskId);
    }
    const sql = 'SELECT * FROM prompt_ledger WHERE ' + filters.join(' AND ') + ' ORDER BY created_at ASC';
    return db.prepare(sql).all(...params).map(mapLedgerRow);
  } finally {
    db.close();
  }
}

// Closes every open entry for an agent, and only the open ones: a completed
// prompt must never be rewritten as failed by a later pass, and the spend
// already recorded against it has to survive.
//
// Two callers, for two different endings. A session returning to idle means
// the turn finished, so its prompt completed. A released assignment means the
// system gave up on that session, so its prompt died with it.
function closeOpenPromptEntries(options = {}, { agentSessionId, taskId = null, outcome = 'completed', reason = null } = {}) {
  if (!agentSessionId) return { closed: 0 };

  return withLockedDb(options, (db) => runTransaction(db, () => {
    const filters = ["outcome_status NOT IN ('completed', 'failed', 'cancelled')", 'agent_session_id = ?'];
    const params = [agentSessionId];
    if (taskId) {
      filters.push('task_id = ?');
      params.push(taskId);
    }

    const where = filters.join(' AND ');
    const open = db.prepare('SELECT idempotency_key FROM prompt_ledger WHERE ' + where).all(...params);
    if (open.length === 0) return { closed: 0 };

    const column = outcome === 'completed' ? 'completed_at' : null;
    const sql = [
      'UPDATE prompt_ledger SET outcome_status = ?, last_error = COALESCE(?, last_error)',
      column ? ', ' + column + ' = ?' : '',
      ' WHERE ' + where,
    ].join('');
    const updateParams = [outcome, reason];
    if (column) updateParams.push(utcNow());
    db.prepare(sql).run(...updateParams, ...params);

    return { closed: open.length, keys: open.map((row) => row.idempotency_key) };
  }));
}

// What one assistant message cost, read from the event OpenCode actually
// sends. Verified against a recording of 29,373 real events rather than
// against the schema.
//
// Only message.updated for an assistant message is a per-prompt charge.
// session.updated carries the session running total and would double-count
// everything if it were treated the same way.
// The runtime's own receipt for a prompt: which message it became.
//
// Without this the ledger has a message_id column that nothing fills, so no
// reported cost can ever be matched to the prompt that caused it. The event
// exists and arrives -- confirmed in the closing run -- it was simply never
// read.
function admissionFromEvent(event) {
  if (!event || event.type !== 'session.next.prompt.admitted') return null;
  const properties = event.properties || {};
  if (!properties.messageID) return null;
  return {
    sessionId: properties.sessionID || null,
    messageId: properties.messageID,
    delivery: properties.delivery || null,
  };
}

// Attaches the message id to the agent's open prompt that does not have one
// yet, oldest first. An entry that already carries an id is left alone: a
// later admission belongs to a later prompt.
function attributePromptMessage(options = {}, admissions = []) {
  const rows = (admissions || []).filter((entry) => entry && entry.agentSessionId && entry.messageId);
  if (rows.length === 0) return { attributed: 0 };

  return withLockedDb(options, (db) => runTransaction(db, () => {
    const find = db.prepare(`
      SELECT idempotency_key FROM prompt_ledger
      WHERE agent_session_id = ? AND message_id IS NULL
        AND outcome_status NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY created_at ASC LIMIT 1
    `);
    const update = db.prepare('UPDATE prompt_ledger SET message_id = ? WHERE idempotency_key = ?');

    let attributed = 0;
    for (const entry of rows) {
      const target = find.get(entry.agentSessionId);
      if (!target) continue;
      update.run(entry.messageId, target.idempotency_key);
      attributed += 1;
    }
    return { attributed };
  }));
}

function usageFromEvent(event) {
  if (!event || event.type !== 'message.updated') return null;
  const info = event.properties && event.properties.info;
  if (!info || info.role !== 'assistant' || !info.id) return null;
  if (!Number.isFinite(info.cost) && !info.tokens) return null;

  return {
    messageId: info.id,
    sessionId: info.sessionID || (event.properties && event.properties.sessionID) || null,
    cost: Number.isFinite(info.cost) ? info.cost : 0,
    tokens: info.tokens || {},
  };
}

// Sets usage, never adds it.
//
// The recording showed message.updated firing repeatedly for the same message
// with the same figures; accumulating per event would have inflated the bill
// and fired the spend cap early. The last figure for a message is its total.
//
// Usage for a message no prompt claims is dropped rather than stored: manual
// turns and work begun in the terminal produce assistant messages the office
// never sent, and inventing rows for those would corrupt the attribution the
// whole ledger exists to provide.
function recordPromptUsage(options = {}, usages = []) {
  const rows = (usages || []).filter((entry) => entry && entry.messageId);
  if (rows.length === 0) return { updated: 0 };

  return withLockedDb(options, (db) => runTransaction(db, () => {
    const update = db.prepare(`
      UPDATE prompt_ledger
      SET cost = ?,
          input_tokens = ?,
          output_tokens = ?,
          reasoning_tokens = ?,
          cache_read_tokens = ?,
          cache_write_tokens = ?
      WHERE message_id = ?
    `);

    let updated = 0;
    for (const entry of rows) {
      const tokens = entry.tokens || {};
      const cache = tokens.cache || {};
      const result = update.run(
        Number.isFinite(entry.cost) ? entry.cost : 0,
        Number.isFinite(tokens.input) ? tokens.input : null,
        Number.isFinite(tokens.output) ? tokens.output : null,
        Number.isFinite(tokens.reasoning) ? tokens.reasoning : null,
        Number.isFinite(cache.read) ? cache.read : null,
        Number.isFinite(cache.write) ? cache.write : null,
        entry.messageId
      );
      updated += result.changes || 0;
    }

    return { updated };
  }));
}

function readPromptLedgerEntry(options = {}, idempotencyKey) {
  const paths = resolvePaths(options);
  const db = openDatabase(paths);
  try {
    return mapLedgerRow(db.prepare('SELECT * FROM prompt_ledger WHERE idempotency_key = ?').get(idempotencyKey));
  } finally {
    db.close();
  }
}

function readPromptLedger(options = {}, query = {}) {
  const paths = resolvePaths(options);
  const db = openDatabase(paths);
  try {
    const filters = [];
    const params = [];
    if (query.taskId) {
      filters.push('task_id = ?');
      params.push(query.taskId);
    }
    if (query.agentSessionId) {
      filters.push('agent_session_id = ?');
      params.push(query.agentSessionId);
    }
    const where = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';
    const sql = 'SELECT * FROM prompt_ledger ' + where + ' ORDER BY created_at ASC';
    return db.prepare(sql).all(...params).map(mapLedgerRow);
  } finally {
    db.close();
  }
}

function sessionSpend(options = {}, agentSessionId) {
  const paths = resolvePaths(options);
  const db = openDatabase(paths);
  try {
    return db.prepare('SELECT COALESCE(SUM(cost), 0) AS total FROM prompt_ledger WHERE agent_session_id = ?')
      .get(agentSessionId).total;
  } finally {
    db.close();
  }
}

// Publishes the state machine's verdict per session into the registry.
//
// This is the seam between the dashboard and the daemon. They are separate
// processes, so the daemon cannot read the in-memory state store; the registry
// is how the verdict crosses over. That makes this a load-bearing step rather
// than bookkeeping: without it the scheduler never sees an idle agent and the
// office never dispatches.
//
// Runs on the world tick, so it follows the same rule as the reconcile pass:
// compare first, and only take the lock if something would actually change.
function publishAgentRuntimeStates(options = {}, states = []) {
  if (!Array.isArray(states) || states.length === 0) return { changed: false, updated: 0 };

  // Indexed by the dashboard session id when it is available, because that is
  // the stable identifier; the OpenCode session id is what converges.
  const byAgentSession = new Map();
  const byOpencodeSession = new Map();
  for (const entry of states) {
    if (!entry) continue;
    if (entry.agentSessionId) byAgentSession.set(entry.agentSessionId, entry);
    if (entry.sessionId) byOpencodeSession.set(entry.sessionId, entry);
  }

  const entryFor = (agent) => byAgentSession.get(agent.sessionId)
    || byOpencodeSession.get(agent.opencodeSessionId)
    || byOpencodeSession.get(agent.sessionId)
    || null;

  const projectionFor = (agent, next) => {
    const rateLimited = next.runtimeState === 'rate_limited';
    return {
      runtimeState: next.runtimeState || null,
      lastRuntimeEventAt: next.lastEventAt || null,
      opencodeSessionId: next.sessionId || agent.opencodeSessionId || null,
      runtimeRateLimitStartedAt: rateLimited
        ? next.rateLimitStartedAt || agent.runtimeRateLimitStartedAt || next.lastEventAt || null
        : null,
      runtimeLastError: rateLimited ? next.lastError || null : null,
      runtimeRetry: rateLimited ? next.retry || null : null,
    };
  };

  const notificationIdFor = (agent, projection) => (
    projection.runtimeState === 'rate_limited' && projection.runtimeRateLimitStartedAt
      ? `usage-limit:${agent.sessionId}:${projection.runtimeRateLimitStartedAt}`
      : null
  );

  const hasInboxRecord = (inbox, id) => Boolean(id) && [
    ...(inbox && Array.isArray(inbox.items) ? inbox.items : []),
    ...(inbox && Array.isArray(inbox.history) ? inbox.history : []),
  ].some((item) => item.id === id);

  const sameRetry = (left, right) => JSON.stringify(left || null) === JSON.stringify(right || null);

  const snapshot = readCoordinationState({ ...options, runLimit: 1 });
  const wouldChange = (snapshot.registry.agents || []).some((agent) => {
    const next = entryFor(agent);
    if (!next) return false;
    const projection = projectionFor(agent, next);
    const notificationId = notificationIdFor(agent, projection);
    return agent.runtimeState !== projection.runtimeState
      || (agent.lastRuntimeEventAt || null) !== projection.lastRuntimeEventAt
      || (agent.opencodeSessionId || null) !== projection.opencodeSessionId
      || (agent.runtimeRateLimitStartedAt || null) !== projection.runtimeRateLimitStartedAt
      || (agent.runtimeLastError || null) !== projection.runtimeLastError
      || !sameRetry(agent.runtimeRetry, projection.runtimeRetry)
      || (notificationId && !hasInboxRecord(snapshot.secretaryInbox, notificationId));
  });

  if (!wouldChange) return { changed: false, updated: 0, notified: 0 };

  let updated = 0;
  let notified = 0;
  mutateCoordination(options, (state) => {
    for (const agent of state.registry.agents || []) {
      const next = entryFor(agent);
      if (!next) continue;
      const projection = projectionFor(agent, next);
      const sameState = agent.runtimeState === projection.runtimeState
        && (agent.lastRuntimeEventAt || null) === projection.lastRuntimeEventAt
        && (agent.opencodeSessionId || null) === projection.opencodeSessionId
        && (agent.runtimeRateLimitStartedAt || null) === projection.runtimeRateLimitStartedAt
        && (agent.runtimeLastError || null) === projection.runtimeLastError
        && sameRetry(agent.runtimeRetry, projection.runtimeRetry);
      if (!sameState) {
        // Keep these assignments explicit: field-ownership validation proves
        // this module is the registry writer for the scheduler-facing state.
        agent.runtimeState = projection.runtimeState;
        agent.lastRuntimeEventAt = projection.lastRuntimeEventAt;
        agent.opencodeSessionId = projection.opencodeSessionId;
        agent.runtimeRateLimitStartedAt = projection.runtimeRateLimitStartedAt;
        agent.runtimeLastError = projection.runtimeLastError;
        agent.runtimeRetry = projection.runtimeRetry;
        updated += 1;
      }

      const notificationId = notificationIdFor(agent, projection);
      if (notificationId && !hasInboxRecord(state.secretaryInbox, notificationId)) {
        const retryAt = projection.runtimeRetry && projection.runtimeRetry.nextAt;
        const retryText = retryAt
          ? ` Automatic retry is scheduled for ${new Date(retryAt).toLocaleString('en-US')}.`
          : '';
        addInboxItem(state.secretaryInbox, createSecretaryMessage({
          id: notificationId,
          agentName: agent.agentName,
          role: agent.role,
          cartridgeId: agent.cartridgeId || null,
          sessionId: agent.sessionId,
          taskId: agent.activeTaskId || null,
          body: `${projection.runtimeLastError || 'The provider reported a usage limit for this agent.'}${retryText}`,
          createdAt: projection.runtimeRateLimitStartedAt,
        }));
        notified += 1;
      }
    }
    if (updated > 0) state.registry.updatedAt = utcNow();
  });

  return { changed: updated > 0 || notified > 0, updated, notified };
}

function upsertRun(options = {}, run) {
  return withLockedDb(options, (db, paths) => {
    return runTransaction(db, () => {
      saveRun(db, run);
      mirrorRunsJson(db, paths);
      return run;
    });
  });
}

function listRuns(options = {}) {
  const paths = resolvePaths(options);
  const db = openDatabase(paths);
  try {
    return {
      paths,
      runs: loadRuns(db, options.runLimit || 25),
    };
  } finally {
    db.close();
  }
}

module.exports = {
  SCHEMA_VERSION,
  WORKSPACE_ROOT,
  DEFAULT_TASKS_PATH,
  DEFAULT_REGISTRY_PATH,
  emptyTasksStore,
  emptyRegistry,
  emptyDaemonStatus,
  emptyUserTaskQueue,
  emptySecretaryInbox,
  resolvePaths,
  readProjectCartridges,
  saveProjectCartridge,
  removeProjectCartridge,
  importLegacyProjectCartridges,
  ensureInitialized,
  appendWorkflowTransitions,
  readWorkflowTransitions,
  promptIdempotencyKey,
  reservePrompt,
  recordPromptTransport,
  recordPromptOutcome,
  readPromptLedgerEntry,
  readPromptLedger,
  usageFromEvent,
  admissionFromEvent,
  attributePromptMessage,
  recordPromptUsage,
  openPromptEntries,
  closeOpenPromptEntries,
  publishAgentRuntimeStates,
  sessionSpend,
  readCoordinationState,
  mutateCoordination,
  upsertRun,
  listRuns,
};
