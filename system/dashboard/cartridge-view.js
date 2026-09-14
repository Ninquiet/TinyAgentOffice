'use strict';

// Joins what the user placed with what is actually running.
//
// Two stores answer two different questions and neither may answer the other's:
//
//   activated  -- intent.      "I put this cartridge in a slot and switched it on."
//   live       -- observation. "There is a session behind it right now."
//
// Collapsing those into one field is finding 06 in miniature. That is what
// `desiredAutoMode` and `daemonStatus.running` did, and the visible result was
// the Auto Mode switch turning itself off with nothing on screen to explain it.
// The same collapse here would reset a cartridge to off because its terminal
// died, leaving the user unable to tell whether they switched it off, never
// switched it on, or it fell over.
//
// So both are carried and the disagreement is the thing worth rendering:
// `stopped` means "you started this and it is not running any more", which is
// something a user can act on.

const PRESENCE = {
  RUNNING: 'running',
  STOPPED: 'stopped',
  IDLE: 'idle',
};

function liveSessionIds(agents) {
  const ids = new Set();
  for (const agent of agents || []) {
    if (!agent || !agent.sessionId) continue;
    if (agent.hasLiveTerminal) ids.add(agent.sessionId);
  }
  return ids;
}

function presenceFor(activated, live) {
  if (!activated) return PRESENCE.IDLE;
  return live ? PRESENCE.RUNNING : PRESENCE.STOPPED;
}

// Pure: takes the stored placements, the derived agents and the blueprints, and
// returns the view. No I/O, so the join is testable without a project on disk.
//
// Resolving a linked instance's definition from its blueprint IS the propagation
// mechanism. The row deliberately carries no definition while the link holds --
// a private copy is what would make propagation impossible -- so if nothing
// resolves it here, every linked instance arrives with no name, role or model
// and the board draws nothing. That is not a rendering bug with a data cause;
// it is the link doing nothing at all.
function buildCartridgeView(cartridges, agents, blueprints) {
  const live = liveSessionIds(agents);
  const blueprintById = new Map((blueprints || []).map((entry) => [entry.id, entry]));

  return (cartridges || []).map((cartridge) => {
    const activated = Boolean(cartridge.activated);
    const hasLiveSession = Boolean(cartridge.sessionId && live.has(cartridge.sessionId));
    const blueprint = cartridge.templateId ? blueprintById.get(cartridge.templateId) : null;

    return {
      id: cartridge.id,
      // The blueprint this instance follows. Its presence is the LINKED tag,
      // and its absence is the entire visual for an unlinked cartridge.
      templateId: cartridge.templateId || null,
      linked: Boolean(cartridge.templateId),
      // From the blueprint while linked, from the row once unlinked. An
      // instance whose blueprint has been deleted keeps whatever snapshot it
      // has: a stale definition is worse than none only in theory, and in
      // practice none means it cannot be drawn at all.
      definition: (blueprint && blueprint.definition) || cartridge.definition || null,
      // Which version of the blueprint this instance is showing. Null when it
      // follows none, so "linked but running an older version" stays a thing
      // that does not exist rather than a state to reason about.
      blueprintRevision: blueprint ? blueprint.revision : null,
      x: cartridge.x,
      y: cartridge.y,
      slotId: cartridge.slotId || null,
      activated,
      sessionId: cartridge.sessionId || null,
      live: hasLiveSession,
      presence: presenceFor(activated, hasLiveSession),
    };
  });
}

module.exports = {
  PRESENCE,
  buildCartridgeView,
};
