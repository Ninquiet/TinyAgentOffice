'use strict';

// What OpenCode knows about each session, as plain data.
//
// This module never sees the dashboard's view model. It takes a plain
// projection of the sessions we care about and returns a plain fact per
// session; mapping those facts onto agents, roles and alerts is the view
// layer's job. The dependency points one way: the dashboard knows about
// OpenCode, OpenCode knows nothing about the dashboard.
//
// `runtimeState` carries the state machine's verdict for the session, reduced
// from OpenCode's own events rather than inferred from timestamps.

const provider = require('./provider');

const FATAL_CONSOLE_ERROR_SCAN_DEPTH = 12;

// The only failure classification we have today: a regex over console text.
// OpenCode does expose structured errors (session.error carries a typed union
// including APIError with a statusCode), and this goes away once the event
// adapter consumes them. The event shapes were verified against a live
// OpenCode event stream during development.
function findFatalConsoleError(consoleState) {
  const messages = Array.isArray(consoleState && consoleState.messages) ? consoleState.messages : [];
  for (const entry of messages.slice(-FATAL_CONSOLE_ERROR_SCAN_DEPTH).reverse()) {
    const text = String(entry && entry.preview ? entry.preview : '');
    if (!text) continue;
    if (/bad request/i.test(text) && /model/i.test(text) && /(not supported|unsupported)/i.test(text)) {
      return text.replace(/\s+/g, ' ').trim();
    }
    if (/model.+(not supported|unsupported)/i.test(text)) {
      return text.replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

function emptyConsoleState() {
  return {
    connected: false,
    currentSessionId: null,
    currentSessionTitle: null,
    todoCount: 0,
    messages: [],
    lastEventAt: null,
    error: null,
    usingLiveEvents: false,
  };
}

function unreachableFact(session) {
  return {
    sessionId: session.sessionId,
    reachable: false,
    consoleState: null,
    operationalStatus: null,
    operationalError: null,
    pendingQuestions: 0,
    pendingPermissions: 0,
    attentionRequired: false,
    firstQuestionText: '',
    todoCount: 0,
    lastEventAt: null,
    runtimeState: null,
  };
}

// `sessions` is a plain projection, not the dashboard's agents:
//   { sessionId, adapterType, hasLiveTerminal, serverHost, serverPort, configuredModel }
function createSessionFacts({ broker, attention, models, sessionStates, resolveSessionId }) {
  function operationalHealth(consoleState, configuredModel) {
    const catalog = models.peekModels().models || [];
    if (catalog.length > 0 && configuredModel && !catalog.includes(configuredModel)) {
      return {
        operationalStatus: 'error',
        operationalError: `Configured OpenCode model is not available: ${configuredModel}.`,
      };
    }

    const consoleError = findFatalConsoleError(consoleState);
    if (consoleError) {
      return { operationalStatus: 'error', operationalError: consoleError };
    }

    return { operationalStatus: 'ok', operationalError: null };
  }

  function factFor(session) {
    if (!provider.hasReachableServer(session)) return unreachableFact(session);

    const consoleState = broker.getConsoleState(session) || emptyConsoleState();
    const attentionEntry = attention.get(session.sessionId);
    const health = operationalHealth(consoleState, session.configuredModel || null);

    return {
      sessionId: session.sessionId,
      reachable: true,
      consoleState,
      operationalStatus: health.operationalStatus,
      operationalError: health.operationalError,
      pendingQuestions: attentionEntry ? attentionEntry.pendingQuestions : 0,
      pendingPermissions: attentionEntry ? attentionEntry.pendingPermissions : 0,
      attentionRequired: Boolean(attentionEntry && attentionEntry.attentionRequired),
      firstQuestionText: attentionEntry ? attentionEntry.firstQuestionText : '',
      todoCount: Number(consoleState.todoCount || 0),
      lastEventAt: consoleState.lastEventAt || null,
      // Same resolution the scheduler uses, so the UI and the daemon cannot
      // report different states for one agent.
      runtimeState: (() => {
        if (!sessionStates) return null;
        const resolved = resolveSessionId ? resolveSessionId(session) : consoleState.currentSessionId;
        return resolved ? sessionStates.get(resolved).state : null;
      })(),
    };
  }

  function factsFor(sessions) {
    const facts = new Map();
    for (const session of sessions || []) {
      if (!session || !session.sessionId) continue;
      facts.set(session.sessionId, factFor(session));
    }
    return facts;
  }

  return {
    factsFor,
    factFor,
  };
}

module.exports = {
  createSessionFacts,
  findFatalConsoleError,
  emptyConsoleState,
};
