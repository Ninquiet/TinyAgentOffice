'use strict';

// Where a blueprint's instances are, across every project this machine knows.
//
// A blueprint is app level by definition, so its instances are wherever the user
// put them -- and three things in the tray need to see all of them: the prompt
// that names the running instances a blueprint edit would affect, the prompt that
// offers to break a link, and deleting a blueprint. Written once, because they
// share the whole mechanism.
//
// This is the first thing in the app that reads outside the open project, so two
// properties are load-bearing:
//
// **Reading takes no lock.** These reads happen while a dialog is being drawn,
// across every known project. Taking a lock per project to answer a question
// would put a prompt on the same contention path as the daemon, which is the path
// this refactor spent a slice clearing. `readProjectCartridges` and
// `readCoordinationState` are lock-free reads, and that is why they are used
// here rather than anything transactional.
//
// **An unreachable project is reported, never skipped.** A moved directory, a
// deleted one, a database from a newer build -- each has to surface as "this
// project blocked it", because the delete rule depends on knowing: if any project
// cannot be reached, the delete is refused rather than half-done.

const fs = require('fs');
const path = require('path');
const runtimeStore = require('../runtime/runtime-store');
const runtimeReconcile = require('../runtime/runtime-reconcile');
const { readRecentProjects } = require('./recent-projects');

function projectName(projectRoot) {
  return path.basename(path.resolve(projectRoot));
}

// Every project this machine knows about. The active one is included by the
// caller, because "which project is open" belongs to the dashboard rather than
// here.
function knownProjectRoots(extra = []) {
  const roots = new Set();
  for (const entry of readRecentProjects().projects || []) {
    if (entry && entry.root) roots.add(path.resolve(entry.root));
  }
  for (const root of extra) {
    if (root) roots.add(path.resolve(root));
  }
  return [...roots];
}

// Which registered sessions in this project actually have a live terminal.
// Intent and observation, again: a cartridge row saying `activated` is the user
// having started it, and a live pid is the only evidence it is still going.
function liveSessionsIn(projectRoot) {
  const snapshot = runtimeStore.readCoordinationState({ projectRoot, runLimit: 1 });
  const live = new Map();
  for (const agent of snapshot.registry.agents || []) {
    if (!agent || !agent.sessionId) continue;
    const alive = Number.isInteger(agent.terminalPid) && runtimeReconcile.isPidAlive(agent.terminalPid);
    live.set(agent.sessionId, { alive, agentName: agent.agentName || null });
  }
  return live;
}

// Returns { instances, unreachable }.
//
// `instances` carries what a prompt needs to NAME them -- agent name and project
// -- because "2 running instances" is not something a user can decide with. The
// plan is explicit about that, and it is the reason this function exists at all.
function findBlueprintInstances(blueprintId, options = {}) {
  const roots = Array.isArray(options.projectRoots)
    ? options.projectRoots.map((root) => path.resolve(root))
    : knownProjectRoots(options.alsoInclude || []);

  const instances = [];
  const unreachable = [];
  const gone = [];

  for (const projectRoot of roots) {
    // Gone and unreachable are different, and conflating them makes the whole
    // feature unusable.
    //
    // A project with no coordination database is not a project any more: it was
    // deleted or moved, and it cannot be holding an instance of anything. The
    // recent list fills up with these in normal use -- on this machine, nine of
    // twelve entries were already gone -- so blocking on them would refuse every
    // delete and every edit, permanently, for a list nobody prunes.
    //
    // A database that exists and cannot be READ is the opposite: something is
    // there, it may well hold instances, and the reason is usually transient --
    // a lock, a newer schema. That is what blocks.
    //
    // Reading a missing project would also CREATE it, since openDatabase makes
    // the coordination directory on the way in, so the check has to come first
    // either way.
    const paths = runtimeStore.resolvePaths({ projectRoot });
    if (!fs.existsSync(paths.dbPath)) {
      gone.push({ projectRoot, projectName: projectName(projectRoot) });
      continue;
    }

    let cartridges;
    let live;
    try {
      cartridges = runtimeStore.readProjectCartridges({ projectRoot });
      live = liveSessionsIn(projectRoot);
    } catch (error) {
      // Reported rather than skipped. A silently skipped project that DOES exist
      // is how a delete ends up half-done, and half-done is the one outcome that
      // cannot be recovered from.
      unreachable.push({
        projectRoot,
        projectName: projectName(projectRoot),
        reason: (error && error.message) || String(error),
      });
      continue;
    }

    for (const cartridge of cartridges) {
      if (cartridge.templateId !== blueprintId) continue;
      const session = cartridge.sessionId ? live.get(cartridge.sessionId) : null;
      instances.push({
        projectRoot,
        projectName: projectName(projectRoot),
        cartridgeId: cartridge.id,
        sessionId: cartridge.sessionId || null,
        // The user's intent to run it, kept separate from whether it is running.
        activated: Boolean(cartridge.activated),
        running: Boolean(session && session.alive),
        agentName: (session && session.agentName) || null,
      });
    }
  }

  return { instances, unreachable, gone };
}

// Deleting a blueprint (user decision Q4): its instances stay alive and become
// unlinked. Nothing stops, nothing is lost.
//
// There is no transaction here and there cannot be: this mutates N SQLite
// databases with N locks, one per project, including projects that are not open.
// So it will fail halfway one day -- a moved directory, a lock held by another
// window -- and the only question is what state that leaves.
//
// **Rule 1: unlink everywhere first, delete the blueprint last.** The blueprint
// is the only thing that makes recovery possible: while it exists, an instance
// that still points at it can be resolved again. So it is the last thing to go.
// Fail partway through the unlinking and the blueprint is still there with no
// orphans -- retry and it is finished. The other order leaves instances pointing
// at something that no longer exists, and there is nothing left to rebuild their
// definition from.
//
// It is the same principle as not advancing the committed snapshot until the
// write lands: do not move the state that permits recovery until everything else
// has gone right.
//
// **Rule 2: if any project cannot be reached, refuse the whole thing.** Not
// partial. "I deleted the blueprint and two projects were left with undrawable
// ghosts" is unrecoverable; refusing is ugly and recoverable. The refusal names
// the project so the user can fix it or decide.
function deleteBlueprintEverywhere(blueprintId, options = {}) {
  const blueprintStore = require('./blueprint-store');
  const storeOptions = options.storeOptions || {};

  const blueprint = blueprintStore.readBlueprints(storeOptions)
    .find((entry) => entry.id === blueprintId);
  if (!blueprint) return { deleted: false, reason: 'unknown-blueprint' };

  const found = findBlueprintInstances(blueprintId, options);

  // Rule 2, checked before anything is written.
  if (found.unreachable.length > 0) {
    return {
      deleted: false,
      reason: 'unreachable-project',
      unreachable: found.unreachable,
      instances: found.instances,
    };
  }

  // Rule 1, first half: every instance takes a snapshot of the definition and
  // drops the reference, while the blueprint is still there to snapshot from.
  let unlinked = 0;
  for (const instance of found.instances) {
    try {
      const [row] = runtimeStore.readProjectCartridges({ projectRoot: instance.projectRoot })
        .filter((entry) => entry.id === instance.cartridgeId);
      if (!row) continue;

      runtimeStore.saveProjectCartridge({ projectRoot: instance.projectRoot }, {
        ...row,
        templateId: null,
        definition: blueprint.definition,
      });
      unlinked += 1;
    } catch (error) {
      // Stop here and leave the blueprint alone. What was unlinked already kept
      // its definition, so a retry finishes the job rather than repairing damage.
      return {
        deleted: false,
        reason: 'unlink-failed',
        unlinked,
        failedAt: {
          projectRoot: instance.projectRoot,
          projectName: instance.projectName,
          cartridgeId: instance.cartridgeId,
          reason: (error && error.message) || String(error),
        },
        unreachable: [],
      };
    }
  }

  // Rule 1, second half: only now.
  blueprintStore.deleteBlueprint(storeOptions, blueprintId);
  return { deleted: true, unlinked, unreachable: [] };
}

// Editing a blueprint that has running instances (user decision Q1).
//
// **The edit is the irreversible commit, so everything that happens to the
// instances happens before it.** Same rule as the delete, in a different shape.
//
// Apply the edit first and then fail to stop a session, and there is an agent
// running whose definition changed underneath it. The plan is explicit that this
// must never happen, and it is the class of confusion that cost days in this
// project. In the other order there is no bad state to reach: if anything fails
// before the edit, the blueprint is exactly as it was and no instance is halfway.
//
// The choice only exists because something is running. Idle linked instances are
// never part of the prompt: there is nothing to stop and no conflict to resolve,
// so they simply follow the new definition (Q1).
//
// `stopSession` is injected because stopping a terminal belongs to the process
// that owns terminals, not here. The ORDER is what this function is for.
function applyBlueprintEdit(blueprintId, options = {}) {
  const blueprintStore = require('./blueprint-store');
  const storeOptions = options.storeOptions || {};

  const blueprint = blueprintStore.readBlueprints(storeOptions)
    .find((entry) => entry.id === blueprintId);
  if (!blueprint) return { applied: false, reason: 'unknown-blueprint' };

  const found = findBlueprintInstances(blueprintId, options);

  // Rule 2. Checked before anything is written, and before anything is stopped.
  if (found.unreachable.length > 0) {
    return {
      applied: false,
      reason: 'unreachable-project',
      unreachable: found.unreachable,
      blockedBy: found.unreachable[0],
    };
  }

  const running = found.instances.filter((entry) => entry.running);

  // A choice is required only when there is something to choose about. Without
  // this, an ordinary edit to a blueprint nobody is running would demand an
  // answer to a question with no consequences -- and a prompt with nothing
  // behind it is how prompts start being dismissed unread.
  if (running.length > 0 && options.choice !== 'stop' && options.choice !== 'unlink') {
    return { applied: false, reason: 'choice-required', running: running.length, instances: running };
  }

  // Everything reversible, first.
  if (options.choice === 'stop') {
    for (const instance of running) {
      let stopped = false;
      try {
        stopped = Boolean(options.stopSession && options.stopSession(instance));
      } catch (error) {
        stopped = false;
      }

      if (!stopped) {
        // Refuse the whole edit. Never "the blueprint changed but two are still
        // running on the old version".
        return { applied: false, reason: 'stop-failed', blockedBy: instance };
      }

      // The session is gone, so the user's intent to run it is spent. The
      // cartridge stays where it is and still follows the blueprint: it picks up
      // the new definition when it is next activated.
      try {
        const [row] = runtimeStore.readProjectCartridges({ projectRoot: instance.projectRoot })
          .filter((entry) => entry.id === instance.cartridgeId);
        if (row) {
          runtimeStore.saveProjectCartridge(
            { projectRoot: instance.projectRoot },
            { ...row, activated: false, sessionId: null },
          );
        }
      } catch (error) {
        return {
          applied: false,
          reason: 'stop-failed',
          blockedBy: { ...instance, reason: (error && error.message) || String(error) },
        };
      }
    }
  }

  if (options.choice === 'unlink') {
    for (const instance of running) {
      try {
        const [row] = runtimeStore.readProjectCartridges({ projectRoot: instance.projectRoot })
          .filter((entry) => entry.id === instance.cartridgeId);
        if (!row) continue;

        // They keep going, exactly as they are, on the definition they started
        // under -- which is why the snapshot is taken from the blueprint BEFORE
        // the edit is applied.
        runtimeStore.saveProjectCartridge(
          { projectRoot: instance.projectRoot },
          { ...row, templateId: null, definition: blueprint.definition },
        );
      } catch (error) {
        return {
          applied: false,
          reason: 'unlink-failed',
          blockedBy: { ...instance, reason: (error && error.message) || String(error) },
        };
      }
    }
  }

  // Only now.
  const saved = blueprintStore.saveBlueprint(storeOptions, {
    id: blueprintId,
    definition: options.definition,
    trayIndex: Number.isFinite(Number(options.trayIndex)) ? Number(options.trayIndex) : blueprint.trayIndex,
  });

  return {
    applied: true,
    running: running.length,
    choice: options.choice || null,
    blueprint: saved.blueprint,
  };
}

module.exports = {
  knownProjectRoots,
  findBlueprintInstances,
  deleteBlueprintEverywhere,
  applyBlueprintEdit,
};
