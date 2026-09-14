'use strict';

const http = require('http');

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['items', 'data', 'sessions', 'messages', 'todos', 'list']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function httpJsonRequest(options, method, pathName, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: options.hostname,
      port: options.port,
      method,
      path: pathName,
      timeout: options.timeoutMs || 2000,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : undefined,
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
          resolve(body == null ? null : true);
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
    if (payload) req.write(payload);
    req.end();
  });
}

function pickSessionId(session) {
  if (!session || typeof session !== 'object') return null;
  return session.id || session.sessionId || session.sessionID || null;
}

function sessionUpdatedMs(session) {
  const value = session && session.time && session.time.updated;
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : 0;
}

function sortSessionsByUpdatedDesc(sessions) {
  return [...(sessions || [])].sort((a, b) => sessionUpdatedMs(b) - sessionUpdatedMs(a));
}

async function listSessions(endpoint) {
  return asArray(await httpJsonRequest(endpoint, 'GET', '/session').catch(() => []));
}

async function getSession(endpoint, sessionId) {
  if (!sessionId) return null;
  return httpJsonRequest(endpoint, 'GET', `/session/${encodeURIComponent(sessionId)}`).catch(() => null);
}

async function listMessages(endpoint, sessionId) {
  if (!sessionId) return [];
  return asArray(await httpJsonRequest(endpoint, 'GET', `/session/${encodeURIComponent(sessionId)}/message`).catch(() => []));
}

async function listTodos(endpoint, sessionId) {
  if (!sessionId) return [];
  return asArray(await httpJsonRequest(endpoint, 'GET', `/session/${encodeURIComponent(sessionId)}/todo`).catch(() => []));
}

function messageCreatedMs(message) {
  const value = message && message.info && message.info.time && message.info.time.created;
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : 0;
}

function extractMessageText(message) {
  const parts = Array.isArray(message && message.parts) ? message.parts : [];
  return parts.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    if (typeof part.delta === 'string') return part.delta;
    return '';
  }).join('');
}

function extractUserTextFromMessages(messagesPayload) {
  const lines = [];
  for (const message of asArray(messagesPayload)) {
    if (!message || typeof message !== 'object') continue;
    const role = message.info && typeof message.info.role === 'string'
      ? message.info.role
      : message.role;
    if (String(role || '').toLowerCase() !== 'user') continue;
    const text = extractMessageText(message);
    if (text) lines.push(text);
  }
  return lines.join('\n');
}

function messagePayloadMatchesDashboardIdentity(messagesPayload, identity) {
  const haystack = extractUserTextFromMessages(messagesPayload).toLowerCase();
  if (!haystack) return false;

  const dashboardSessionId = String(identity && identity.dashboardSessionId || '').toLowerCase();
  if (!dashboardSessionId || !haystack.includes(dashboardSessionId)) return false;

  const agentName = String(identity && identity.agentName || '').toLowerCase();
  if (agentName && !haystack.includes(agentName)) return false;

  return true;
}

async function findSessionByDashboardIdentity(endpoint, identity, sessions = null) {
  const candidates = sortSessionsByUpdatedDesc(sessions || await listSessions(endpoint)).slice(0, 32);
  for (const session of candidates) {
    const sessionId = pickSessionId(session);
    if (!sessionId) continue;
    // eslint-disable-next-line no-await-in-loop
    const messages = await listMessages(endpoint, sessionId);
    if (messagePayloadMatchesDashboardIdentity(messages, identity)) {
      return {
        id: sessionId,
        title: session.title || session.name || null,
        messages,
        session,
      };
    }
  }
  return null;
}

function sessionMessageCheckpoint(messages) {
  let latestCreatedMs = 0;
  for (const message of messages || []) {
    latestCreatedMs = Math.max(latestCreatedMs, messageCreatedMs(message));
  }
  return {
    count: Array.isArray(messages) ? messages.length : 0,
    latestCreatedMs,
  };
}

function hasDeliveredPromptAfterCheckpoint(messages, checkpoint, text) {
  const expected = String(text || '').trim();
  if (!expected) return false;
  for (const message of messages || []) {
    const role = message && message.info && message.info.role;
    if (role !== 'user') continue;
    const createdMs = messageCreatedMs(message);
    const isNewByTime = createdMs > (checkpoint.latestCreatedMs || 0);
    const isNewByAppend = createdMs === (checkpoint.latestCreatedMs || 0)
      && Array.isArray(messages)
      && messages.length > (checkpoint.count || 0);
    if (!isNewByTime && !isNewByAppend) continue;
    if (extractMessageText(message).includes(expected)) return true;
  }
  return false;
}

function indexSessionUpdates(sessions) {
  const updates = new Map();
  for (const session of sessions || []) {
    const id = pickSessionId(session);
    if (!id) continue;
    updates.set(id, sessionUpdatedMs(session));
  }
  return updates;
}

function detectTouchedSession(beforeUpdates, afterSessions) {
  let best = null;
  for (const session of afterSessions || []) {
    const id = pickSessionId(session);
    if (!id) continue;
    const updated = sessionUpdatedMs(session);
    const previous = beforeUpdates.get(id) || 0;
    if (updated <= previous) continue;
    if (!best || updated > best.updated) {
      best = {
        id,
        updated,
        title: session.title || session.name || null,
      };
    }
  }
  return best;
}

module.exports = {
  asArray,
  httpJsonRequest,
  pickSessionId,
  sessionUpdatedMs,
  sortSessionsByUpdatedDesc,
  listSessions,
  getSession,
  listMessages,
  listTodos,
  extractMessageText,
  extractUserTextFromMessages,
  messagePayloadMatchesDashboardIdentity,
  findSessionByDashboardIdentity,
  sessionMessageCheckpoint,
  hasDeliveredPromptAfterCheckpoint,
  indexSessionUpdates,
  detectTouchedSession,
};
