'use strict';

// The OpenCode surface. Everything the rest of the app needs from OpenCode goes
// through here, so that consumers require one module instead of six.
//
// Two rules hold inside this directory:
//
// 1. Nothing here knows the dashboard's view model. The read side returns plain
//    facts keyed by session id (see session-facts.js); mapping them onto agents,
//    roles and alerts belongs to the view layer.
// 2. The refresh calls are separate on purpose. The world tick runs each one as
//    its own isolated phase, so one unreachable OpenCode server cannot starve
//    the rest of the pass.

const provider = require('./provider');
const { createAttentionCache } = require('./attention-cache');
const { createSessionFacts } = require('./session-facts');
const { OpencodeEventBroker } = require('./event-broker');
const { createOpencodeModelsService } = require('./models-service');
const { createOpencodeMaintenanceService, commandExists } = require('./maintenance-service');
const activityWatchdog = require('./activity-watchdog');
const { createSessionStateStore } = require('./session-state-store');
const resolver = require('./session-resolver');
const { getPolicy } = require('../runtime/runtime-policy');
const { usageFromEvent, admissionFromEvent } = require('../runtime/runtime-store');

// Read-only look at a session: lists its messages and reports whether the last
// one is a completed assistant message. Sends nothing, so it costs no quota.
// This is the evidence the state machine's rescue path runs on, and it is the
// same read the activity watchdog already performs.
async function readSessionActivity(endpointFor, sessionId) {
  const endpoint = endpointFor(sessionId);
  if (!endpoint) return null;
  const messages = await resolver.listMessages(endpoint, sessionId);
  const last = Array.isArray(messages) && messages.length > 0 ? messages[messages.length - 1] : null;
  const role = last && last.info && last.info.role ? String(last.info.role).toLowerCase() : null;
  const completed = Boolean(last && last.info && last.info.time && last.info.time.completed);
  return { lastMessageRole: role, completed };
}

function createOpencodeRuntime({ cwd, onTransition } = {}) {
  const endpoints = new Map();
  const endpointFor = (sessionId) => endpoints.get(sessionId) || null;

  const sessionStates = createSessionStateStore({
    onTransition,
    readSessionActivity: (sessionId) => readSessionActivity(endpointFor, sessionId),
  });

  // Usage seen on the stream since the last drain. Held per message id so
  // repeated message.updated events collapse to one row rather than piling up.
  const pendingUsage = new Map();
  const pendingAdmissions = [];

  const broker = new OpencodeEventBroker({
    onSessionEvent: (event) => {
      const usage = usageFromEvent(event);
      if (usage) pendingUsage.set(usage.messageId, usage);
      const admission = admissionFromEvent(event);
      if (admission) pendingAdmissions.push(admission);
      return sessionStates.applyEvent(event);
    },
    onSessionDisconnected: (sessionId) => sessionStates.disconnect(sessionId),
  });
  const attention = createAttentionCache();
  const models = createOpencodeModelsService({ cwd });
  const maintenance = createOpencodeMaintenanceService();
  // The one place a session id is resolved.
  //
  // The broker resolves the live session from the event stream; the registry
  // caches it only after a prompt has been delivered. Reading different ones in
  // different places meant the UI and the scheduler could disagree about the
  // same agent, and an agent the broker had resolved but that had never been
  // prompted was invisible to the scheduler entirely. Live wins; the registry
  // converges on it.
  function resolveSessionId(agent) {
    const consoleState = broker.getConsoleState(agent);
    if (consoleState && consoleState.currentSessionId) return consoleState.currentSessionId;
    return agent.opencodeSessionId || null;
  }

  const facts = createSessionFacts({ broker, attention, models, sessionStates, resolveSessionId });

  return {
    // --- identity -----------------------------------------------------------
    ADAPTER_TYPE: provider.ADAPTER_TYPE,
    isOpencodeAgent: provider.isOpencodeAgent,
    hasReachableServer: provider.hasReachableServer,
    requireOpencodeAgent: provider.requireOpencodeAgent,
    describe: provider.describe,

    // --- read side: plain facts, no view model ------------------------------
    factsFor: facts.factsFor,
    runtimeStateFor: (sessionId) => sessionStates.get(sessionId),
    resolveSessionId,
    // What the world tick publishes to the registry for the daemon to read.
    runtimeStatesFor: (agents) => (agents || []).map((agent) => {
      const sessionId = resolveSessionId(agent);
      if (!sessionId) return null;
      const runtime = sessionStates.get(sessionId);
      return {
        agentSessionId: agent.sessionId,
        sessionId,
        runtimeState: runtime.state,
        lastEventAt: runtime.lastEventAt || null,
        droppedTurnAt: runtime.droppedTurnAt || null,
        rateLimitStartedAt: runtime.rateLimitStartedAt || null,
        lastError: runtime.lastError || null,
        retry: runtime.retry || null,
      };
    }).filter(Boolean),
    maintenanceNotifications: () => maintenance.peekNotifications(),

    // --- write side: one isolated phase each --------------------------------
    syncSessions: (sessions) => {
      endpoints.clear();
      for (const session of sessions || []) {
        const endpoint = provider.serverEndpoint(session);
        const sessionId = resolveSessionId(session);
        if (endpoint && sessionId) endpoints.set(sessionId, endpoint);
      }
      return broker.syncAgents(sessions);
    },
    // Rescues sessions stuck in a state nothing will move them out of. One
    // definition of "no longer trustworthy", shared with the watchdog, and read
    // at call time so policy changes apply without rebuilding the runtime.
    sweepSessionStates: (sessions) => sessionStates.sweep({
      sessions: (sessions || [])
        .map((session) => ({ sessionId: resolveSessionId(session) }))
        .filter((entry) => entry.sessionId),
      staleAfterMs: getPolicy().staleAfterMs,
    }),
    refreshAttention: (sessions) => attention.refresh(sessions),
    refreshModels: () => models.getModels(),
    refreshMaintenance: () => maintenance.checkUpdates(),
    // The watchdog consumes the state machine rather than deriving a second
    // notion of staleness from timestamps. One definition, one place.
    reconcileActivity: (options) => activityWatchdog.reconcileOpencodeActivity(options, {
      sessionStateFor: (agent) => {
        const sessionId = resolveSessionId(agent);
        return sessionId ? sessionStates.get(sessionId) : null;
      },
    }),

    // --- direct operations, for the endpoints that expose them ---------------
    getModels: (options) => models.getModels(options),
    forceMaintenanceCheck: () => maintenance.forceCheck(),
    resolveMaintenance: () => maintenance.resolveMaintenance(),

    // Releases every event stream and the timers that keep them alive.
    // Without it the process never exits: the broker reschedules a reconnect
    // forever, which made the scenario suites hang after reporting success.
    dispose: () => broker.syncAgents([]),

    // Hands over the usage seen since the last call and forgets it. The
    // caller writes it; holding it here would be a second store.
    drainAdmissions: () => pendingAdmissions.splice(0, pendingAdmissions.length),

    drainUsage: () => {
      const drained = Array.from(pendingUsage.values());
      pendingUsage.clear();
      return drained;
    },

    // Test seams. Driving the real reducer and the real resolution keeps these
    // honest: a double that disagreed with production would defeat the point.
    applySessionEventForTest: (event) => sessionStates.applyEvent(event),
    setConsoleSessionForTest: (dashboardSessionId, opencodeSessionId) => {
      broker.setResolvedSessionForTest(dashboardSessionId, opencodeSessionId);
    },
  };
}

module.exports = {
  createOpencodeRuntime,
  commandExists,
};
