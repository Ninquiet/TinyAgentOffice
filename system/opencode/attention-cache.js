'use strict';

// Cache of native OpenCode attention signals (pending questions and pending
// permissions) per agent session.
//
// The polling lives in `refresh`, which is only ever called from the world tick.
// Everything else reads cached entries through `get`, with no I/O: that is what
// stops a dashboard refresh from reaching out to every OpenCode server on the
// box. The cache does not know the dashboard's view model — session-facts.js
// turns these entries into plain facts, and the view layer maps those.

const http = require('http');
const provider = require('./provider');

const DEFAULT_TIMEOUT_MS = 1500;

function defaultHttpJsonRequest(options, method, pathName) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: options.hostname,
      port: options.port,
      method,
      path: pathName,
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${pathName} failed with ${res.statusCode}. ${raw}`.trim()));
          return;
        }
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (_) {
          resolve(raw);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`${method} ${pathName} timed out.`)));
    req.end();
  });
}

const isPollableAgent = provider.hasReachableServer;

function emptyEntry() {
  return {
    pendingQuestions: 0,
    pendingPermissions: 0,
    attentionRequired: false,
    firstQuestionText: '',
    checkedAt: null,
    error: null,
  };
}

function firstQuestionTextOf(questions) {
  const first = questions[0];
  if (!first || !Array.isArray(first.questions) || !first.questions[0]) return '';
  return String(first.questions[0].question || '').replace(/\s+/g, ' ').trim();
}

function createAttentionCache(options = {}) {
  const httpJsonRequest = typeof options.httpJsonRequest === 'function'
    ? options.httpJsonRequest
    : defaultHttpJsonRequest;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();

  const entries = new Map();

  async function refreshAgent(agent) {
    const endpoint = { hostname: agent.serverHost || '127.0.0.1', port: agent.serverPort };
    try {
      const [questions, permissions] = await Promise.all([
        httpJsonRequest(endpoint, 'GET', '/question'),
        httpJsonRequest(endpoint, 'GET', '/permission'),
      ]);

      const pendingQuestions = Array.isArray(questions) ? questions : [];
      const pendingPermissions = Array.isArray(permissions) ? permissions : [];

      entries.set(agent.sessionId, {
        pendingQuestions: pendingQuestions.length,
        pendingPermissions: pendingPermissions.length,
        attentionRequired: pendingQuestions.length > 0 || pendingPermissions.length > 0,
        firstQuestionText: firstQuestionTextOf(pendingQuestions),
        checkedAt: now(),
        error: null,
      });
    } catch (error) {
      // An unreachable OpenCode server means "no known attention", which is what
      // the previous inline implementation also concluded.
      entries.set(agent.sessionId, {
        ...emptyEntry(),
        checkedAt: now(),
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  // World-tick side. Never call this from anything that builds a view.
  async function refresh(agents) {
    const pollable = (agents || []).filter(isPollableAgent);
    const live = new Set(pollable.map((agent) => agent.sessionId));
    for (const sessionId of Array.from(entries.keys())) {
      if (!live.has(sessionId)) entries.delete(sessionId);
    }
    await Promise.all(pollable.map((agent) => refreshAgent(agent)));
    return {
      polled: pollable.length,
      attention: pollable.filter((agent) => {
        const entry = entries.get(agent.sessionId);
        return Boolean(entry && entry.attentionRequired);
      }).length,
    };
  }

  function get(sessionId) {
    return entries.get(sessionId) || null;
  }

  function size() {
    return entries.size;
  }

  return {
    refresh,
    get,
    size,
  };
}

module.exports = {
  createAttentionCache,
  isPollableAgent,
};
