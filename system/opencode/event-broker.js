'use strict';

const http = require('http');
const opencodeSessionResolver = require('./session-resolver');
const provider = require('./provider');

const MAX_BUFFERED_MESSAGES = 120;
const RECONNECT_DELAY_MS = 1500;
const REFRESH_DEBOUNCE_MS = 150;
const POLL_INTERVAL_MS = 1200;

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['items', 'data', 'sessions', 'messages', 'todos', 'list']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function compactText(value, maxLength = 180) {
  const text = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatToolValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return compactText(value);
  }
  if (Array.isArray(value)) {
    return compactText(value.map((entry) => formatToolValue(entry)).filter(Boolean).join(', '));
  }
  if (typeof value !== 'object') return compactText(value);

  const importantPairs = [];
  for (const key of [
    'command',
    'cmd',
    'path',
    'file',
    'filename',
    'pattern',
    'query',
    'url',
    'cwd',
    'workdir',
    'description',
  ]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const formatted = formatToolValue(value[key]);
      if (formatted) importantPairs.push(`${key}=${formatted}`);
    }
  }
  if (importantPairs.length > 0) return compactText(importantPairs.join(' | '));

  const entries = Object.entries(value)
    .filter(([key, entryValue]) => (
      !['type', 'tool', 'name'].includes(key)
      && entryValue != null
      && typeof entryValue !== 'object'
    ))
    .slice(0, 4)
    .map(([key, entryValue]) => `${key}=${formatToolValue(entryValue)}`)
    .filter(Boolean);
  if (entries.length > 0) return compactText(entries.join(' | '));

  try {
    return compactText(JSON.stringify(value));
  } catch (_) {
    return '';
  }
}

function pickToolName(part) {
  if (!part || typeof part !== 'object') return 'tool';
  const candidates = [
    part.tool,
    part.name,
    part.command,
    part.call && part.call.name,
    part.toolCall && part.toolCall.name,
    part.tool_call && part.tool_call.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return 'tool';
}

function describeToolPart(part) {
  if (!part || typeof part !== 'object') return '';
  const toolName = pickToolName(part);
  const payloadCandidates = [
    part.input,
    part.args,
    part.arguments,
    part.params,
    part.parameters,
    part.call && (part.call.input || part.call.arguments || part.call.args),
    part.toolCall && (part.toolCall.input || part.toolCall.arguments || part.toolCall.args),
    part.tool_call && (part.tool_call.input || part.tool_call.arguments || part.tool_call.args),
  ];
  const outputCandidates = [
    part.output,
    part.result,
    part.response,
    part.error,
  ];
  const detail = payloadCandidates.map(formatToolValue).find(Boolean)
    || outputCandidates.map(formatToolValue).find(Boolean)
    || formatToolValue(part);

  if (!detail || detail === `type=${part.type}`) return `${toolName}: running`;
  return `${toolName}: ${detail}`;
}

function describeNonTextPart(part) {
  if (!part || typeof part !== 'object') return '';
  const type = String(part.type || '').toLowerCase();
  if (type === 'tool') return describeToolPart(part);
  if (typeof part.title === 'string' && part.title.trim()) return compactText(part.title);
  if (typeof part.summary === 'string' && part.summary.trim()) return compactText(part.summary);
  if (part.type && typeof part.type === 'string') return `[${part.type}]`;
  return '';
}

const pickSessionId = opencodeSessionResolver.pickSessionId;

function extractTextParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    if (typeof part.delta === 'string') return part.delta;
    return describeNonTextPart(part);
  }).join('');
}

function normalizeMessages(payload) {
  return asArray(payload).slice(-20).map((message) => ({
    id: message.id || message.messageId || null,
    role: message.role || message.type || 'message',
    preview: extractTextParts(message.parts || message.content || []) || String(message.text || message.summary || '').trim(),
    createdAt: message.createdAt || message.updatedAt || null,
    source: 'snapshot',
  }));
}

function normalizeSessionMessages(payload) {
  const entries = [];
  for (const message of asArray(payload)) {
    const baseRole = message && message.info && typeof message.info.role === 'string'
      ? message.info.role
      : 'message';
    const messageError = message && message.info && message.info.error ? message.info.error : null;
    const errorText = extractErrorText(messageError);
    if (errorText) {
      entries.push({
        id: message.info && message.info.id ? `${message.info.id}:error` : null,
        role: 'error',
        preview: errorText,
        createdAt: message.info && message.info.time && message.info.time.created
          ? new Date(Number(message.info.time.created)).toISOString()
          : null,
        source: 'snapshot',
      });
    }
    const parts = Array.isArray(message && message.parts) ? message.parts : [];

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const partType = String(part.type || '').toLowerCase();
      const text = extractTextParts([part]);
      if (!text) continue;
      if (partType === 'step-start' || partType === 'step-finish') continue;

      let role = baseRole;
      if (partType === 'reasoning') role = 'reasoning';
      else if (partType === 'tool') role = `tool:${part.tool || 'call'}`;
      else if (partType !== 'text') role = part.type || baseRole;

      entries.push({
        id: part.id || message.info && message.info.id || null,
        role,
        preview: text,
        createdAt: message.info && message.info.time && message.info.time.created
          ? new Date(Number(message.info.time.created)).toISOString()
          : null,
        source: 'snapshot',
      });
    }
  }

  return entries.slice(-MAX_BUFFERED_MESSAGES);
}

function extractErrorText(error) {
  if (!error || typeof error !== 'object') return '';
  const candidates = [
    error.message,
    error.data && error.data.message,
    error.data && error.data.responseBody,
    error.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

const httpJsonRequest = opencodeSessionResolver.httpJsonRequest;

function parseJsonSafely(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return raw;
  }
}

function deepSearch(value, predicate, seen = new Set()) {
  if (value == null) return null;
  if (typeof value !== 'object') return predicate(value) ? value : null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (predicate(value)) return value;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepSearch(item, predicate, seen);
      if (found != null) return found;
    }
    return null;
  }

  for (const nested of Object.values(value)) {
    const found = deepSearch(nested, predicate, seen);
    if (found != null) return found;
  }
  return null;
}

function extractSessionId(payload) {
  const found = deepSearch(payload, (value) => (
    typeof value === 'string'
    && /^ses_[a-z0-9]+$/i.test(value)
  ));
  return typeof found === 'string' ? found : null;
}

function extractSessionTitle(payload) {
  const found = deepSearch(payload, (value) => (
    value
    && typeof value === 'object'
    && (typeof value.title === 'string' || typeof value.name === 'string')
  ));
  if (!found || typeof found !== 'object') return null;
  return found.title || found.name || null;
}

function extractPreviewText(value) {
  if (value == null) return '';

  const directParts = deepSearch(value, (candidate) => (
    candidate
    && typeof candidate === 'object'
    && Array.isArray(candidate.parts)
  ));
  if (directParts && Array.isArray(directParts.parts)) {
    const text = extractTextParts(directParts.parts);
    if (text) return text;
  }

  const textHolder = deepSearch(value, (candidate) => (
    candidate
    && typeof candidate === 'object'
    && (
      typeof candidate.text === 'string'
      || typeof candidate.content === 'string'
      || typeof candidate.delta === 'string'
      || typeof candidate.summary === 'string'
    )
  ));
  if (textHolder && typeof textHolder === 'object') {
    const text = [
      textHolder.text,
      textHolder.content,
      textHolder.delta,
      textHolder.summary,
    ].filter((entry) => typeof entry === 'string' && entry.trim()).join('');
    if (text) return text;
  }

  return '';
}

function buildEventPreview(type, payload) {
  const properties = payload && typeof payload === 'object' && payload.properties && typeof payload.properties === 'object'
    ? payload.properties
    : payload;
  const source = properties && typeof properties === 'object' && properties.message
    ? properties.message
    : properties;

  const normalized = normalizeMessages([source])[0];
  if (normalized && normalized.preview) {
    return {
      role: normalized.role || type || 'message',
      preview: normalized.preview,
    };
  }

  const deepText = extractPreviewText(source);
  if (deepText) {
    return {
      role: 'message',
      preview: deepText,
    };
  }

  if (properties && Array.isArray(properties.questions) && properties.questions[0]) {
        const question = properties.questions[0];
    const text = String(question.question || '').trim();
    if (text) {
      return { role: 'question', preview: text };
    }
  }

  if (type && type.includes('permission')) {
    return { role: 'permission', preview: 'Permission request pending.' };
  }

  if (type && type.includes('todo')) {
    return null;
  }

  if (type && (type.includes('error') || type.includes('failed'))) {
    return {
      role: 'event',
      preview: String(type).replace(/\s+/g, ' ').trim(),
    };
  }

  return null;
}

function buildFingerprint(entry) {
  return [
    entry.id || '',
    entry.role || '',
    entry.preview || '',
  ].join('::');
}

function sessionMatchesAgent(session, agentName) {
  if (!session || !agentName) return false;
  const haystacks = [
    session.title,
    session.name,
    session.slug,
  ].filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase());
  const needle = String(agentName).toLowerCase();
  return haystacks.some((value) => value.includes(needle));
}

const sortSessionsByUpdatedDesc = opencodeSessionResolver.sortSessionsByUpdatedDesc;

function extractUserTextFromMessages(messagesPayload) {
  const lines = [];
  for (const message of asArray(messagesPayload)) {
    if (!message || typeof message !== 'object') continue;
    const role = message.info && typeof message.info.role === 'string'
      ? message.info.role
      : message.role;
    if (String(role || '').toLowerCase() !== 'user') continue;

    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (!part || typeof part !== 'object') continue;
      if (String(part.type || '').toLowerCase() !== 'text') continue;
      if (typeof part.text === 'string') lines.push(part.text);
    }
  }
  return lines.join('\n');
}

function messagePayloadMatchesDashboardSession(messagesPayload, connection) {
  return opencodeSessionResolver.messagePayloadMatchesDashboardIdentity(messagesPayload, {
    dashboardSessionId: connection.dashboardSessionId,
    agentName: connection.agentName,
  });
}

class OpencodeEventBroker {
  constructor(options = {}) {
    this.connections = new Map();
    // Raw event sink. The state machine subscribes here so that session.status
    // and friends stop being used only to schedule a console refresh and then
    // discarded.
    this.onSessionEvent = typeof options.onSessionEvent === 'function' ? options.onSessionEvent : null;
    this.onSessionDisconnected = typeof options.onSessionDisconnected === 'function'
      ? options.onSessionDisconnected
      : null;
  }

  syncAgents(agents) {
    const activeKeys = new Set();

    for (const agent of agents || []) {
      if (!provider.hasReachableServer(agent)) continue;

      activeKeys.add(agent.sessionId);
      this.ensureConnection(agent);
    }

    for (const [key, connection] of this.connections.entries()) {
      if (!activeKeys.has(key)) {
        this.disposeConnection(connection);
        this.connections.delete(key);
      }
    }
  }

  ensureConnection(agent) {
    const existing = this.connections.get(agent.sessionId);
    if (existing) {
      existing.agentName = agent.agentName;
      existing.role = agent.role;
      existing.endpoint = { hostname: agent.serverHost || '127.0.0.1', port: agent.serverPort };
      existing.preferredSessionId = agent.opencodeSessionId || null;
      existing.preferredSessionTitle = agent.opencodeSessionTitle || null;
      existing.stale = false;
      if (existing.preferredSessionId && existing.currentSessionId !== existing.preferredSessionId) {
        this.switchSession(existing, existing.preferredSessionId, existing.preferredSessionTitle);
      }
      if (!existing.connected && !existing.connecting) {
        this.openConnection(existing);
      }
      return existing;
    }

    const connection = {
      dashboardSessionId: agent.sessionId,
      agentName: agent.agentName,
      role: agent.role,
      endpoint: { hostname: agent.serverHost || '127.0.0.1', port: agent.serverPort },
      preferredSessionId: agent.opencodeSessionId || null,
      preferredSessionTitle: agent.opencodeSessionTitle || null,
      currentSessionId: null,
      currentSessionTitle: null,
      todoCount: 0,
      messages: [],
      messageFingerprints: new Set(),
      parserBuffer: '',
      connected: false,
      connecting: false,
      stale: false,
      disposed: false,
      reconnectTimer: null,
      req: null,
      lastEventAt: null,
      lastError: null,
      snapshotLoaded: false,
      snapshotLoading: false,
      refreshTimer: null,
      pollTimer: null,
    };

    this.connections.set(agent.sessionId, connection);
    if (connection.preferredSessionId) {
      this.switchSession(connection, connection.preferredSessionId, connection.preferredSessionTitle);
    }
    this.openConnection(connection);
    return connection;
  }

  // Test seam: pretend the stream resolved this session, without a server.
  setResolvedSessionForTest(dashboardSessionId, opencodeSessionId) {
    const existing = this.connections.get(dashboardSessionId) || { dashboardSessionId, messages: [] };
    existing.currentSessionId = opencodeSessionId;
    this.connections.set(dashboardSessionId, existing);
  }

  getConsoleState(agent) {
    const connection = this.connections.get(agent.sessionId);
    if (!connection) return null;
    return {
      connected: connection.connected,
      currentSessionId: connection.currentSessionId,
      currentSessionTitle: connection.currentSessionTitle,
      todoCount: connection.todoCount,
      messages: connection.messages.slice(-20),
      lastEventAt: connection.lastEventAt,
      error: connection.lastError,
      usingLiveEvents: Boolean(connection.currentSessionId || connection.lastEventAt),
    };
  }

  openConnection(connection) {
    if (connection.disposed || connection.connecting) return;
    connection.connecting = true;
    connection.lastError = null;
    this.schedulePolling(connection);

    const req = http.request({
      hostname: connection.endpoint.hostname,
      port: connection.endpoint.port,
      method: 'GET',
      path: '/event',
      timeout: 0,
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    }, (res) => {
      connection.connecting = false;

      if (res.statusCode !== 200) {
        connection.connected = false;
        connection.lastError = `GET /event failed with ${res.statusCode}.`;
        res.resume();
        this.scheduleReconnect(connection);
        return;
      }

      connection.connected = true;
      connection.streamLossAnnounced = false;
      connection.req = req;
      res.setEncoding('utf8');
      res.on('data', (chunk) => this.onChunk(connection, chunk));
      res.on('end', () => {
        connection.connected = false;
        // Losing the stream is how the state machine learns it no longer knows.
        // Without this the last state stays frozen while we are blind, and the
        // scheduler can act on a verdict that stopped being true.
        this.notifyStreamLost(connection);
        if (!connection.disposed) {
          this.scheduleReconnect(connection);
        }
      });
    });

    req.on('error', (error) => {
      connection.connecting = false;
      connection.connected = false;
      connection.lastError = error.message;
      this.notifyStreamLost(connection);
      if (!connection.disposed) {
        this.scheduleReconnect(connection);
      }
    });

    req.end();
  }

  // Announced once per loss, not once per failed reconnect attempt: a session
  // already marked unknown does not need telling again, and the reconnect loop
  // would otherwise emit a transition every 1.5 seconds forever.
  notifyStreamLost(connection) {
    if (!this.onSessionDisconnected) return;
    if (!connection.currentSessionId) return;
    if (connection.streamLossAnnounced) return;
    connection.streamLossAnnounced = true;
    this.onSessionDisconnected(connection.currentSessionId, connection);
  }

  scheduleReconnect(connection) {
    if (connection.disposed || connection.reconnectTimer) return;
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = null;
      this.openConnection(connection);
    }, RECONNECT_DELAY_MS);
  }

  disposeConnection(connection) {
    if (this.onSessionDisconnected && connection.currentSessionId) {
      this.onSessionDisconnected(connection.currentSessionId, connection);
    }
    connection.disposed = true;
    connection.stale = true;
    if (connection.reconnectTimer) {
      clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = null;
    }
    if (connection.req) {
      connection.req.destroy();
      connection.req = null;
    }
    if (connection.refreshTimer) {
      clearTimeout(connection.refreshTimer);
      connection.refreshTimer = null;
    }
    if (connection.pollTimer) {
      clearTimeout(connection.pollTimer);
      connection.pollTimer = null;
    }
    connection.connected = false;
    connection.connecting = false;
  }

  schedulePolling(connection) {
    if (connection.disposed || connection.pollTimer) return;
    connection.pollTimer = setTimeout(() => {
      connection.pollTimer = null;
      this.pollConnection(connection).catch((error) => {
        connection.lastError = error.message;
        this.schedulePolling(connection);
      });
    }, POLL_INTERVAL_MS);
  }

  async pollConnection(connection) {
    if (connection.disposed) return;

    try {
      const statusPayload = await httpJsonRequest(connection.endpoint, 'GET', '/session/status').catch(() => ({}));
      const activeSessionIds = statusPayload && typeof statusPayload === 'object' && !Array.isArray(statusPayload)
        ? Object.keys(statusPayload).filter((key) => /^ses_/i.test(String(key)))
        : [];
      const sessionsPayload = await httpJsonRequest(connection.endpoint, 'GET', '/session').catch(() => []);
      const sessions = asArray(sessionsPayload);
      const sortedSessions = sortSessionsByUpdatedDesc(sessions);

      const identitySession = await this.findSessionByDashboardIdentity(connection, sortedSessions);
      let nextSession = identitySession || null;
      if (!nextSession && connection.preferredSessionId) {
        const preferredCandidate = sessions.find((entry) => pickSessionId(entry) === connection.preferredSessionId) || { id: connection.preferredSessionId };
        const preferredMessages = await httpJsonRequest(connection.endpoint, 'GET', `/session/${encodeURIComponent(connection.preferredSessionId)}/message`).catch(() => []);
        if (messagePayloadMatchesDashboardSession(preferredMessages, connection)) {
          nextSession = preferredCandidate;
        }
      }
      if (!nextSession && activeSessionIds.length > 0) {
        const activeCandidate = sessions.find((entry) => pickSessionId(entry) === activeSessionIds[0]) || { id: activeSessionIds[0] };
        const activeSessionId = pickSessionId(activeCandidate);
        const activeMessages = activeSessionId
          ? await httpJsonRequest(connection.endpoint, 'GET', `/session/${encodeURIComponent(activeSessionId)}/message`).catch(() => [])
          : [];
        if (messagePayloadMatchesDashboardSession(activeMessages, connection)) {
          nextSession = activeCandidate;
        }
      }
      if (!nextSession) {
        nextSession = sortedSessions.find((entry) => sessionMatchesAgent(entry, connection.agentName)) || null;
      }

      const nextSessionId = pickSessionId(nextSession);
      if (!nextSessionId) {
        return;
      }

      if (connection.currentSessionId !== nextSessionId) {
        this.switchSession(connection, nextSessionId, nextSession && (nextSession.title || nextSession.name) ? (nextSession.title || nextSession.name) : null);
        await this.seedSessionSnapshot(connection);
        return;
      }

      if (!connection.snapshotLoaded) {
        await this.seedSessionSnapshot(connection);
        return;
      }

      await this.refreshSessionState(connection);
    } finally {
      this.schedulePolling(connection);
    }
  }

  async findSessionByDashboardIdentity(connection, sortedSessions) {
    const candidates = sortedSessions.slice(0, 16);
    for (const session of candidates) {
      const sessionId = pickSessionId(session);
      if (!sessionId) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const messagesPayload = await httpJsonRequest(connection.endpoint, 'GET', `/session/${encodeURIComponent(sessionId)}/message`).catch(() => []);
        if (messagePayloadMatchesDashboardSession(messagesPayload, connection)) {
          return session;
        }
      } catch (_) {
        // Ignore unreadable historical sessions.
      }
    }
    return null;
  }

  onChunk(connection, chunk) {
    connection.parserBuffer += chunk;

    while (true) {
      const separatorMatch = /\r?\n\r?\n/.exec(connection.parserBuffer);
      if (!separatorMatch) break;

      const separatorIndex = separatorMatch.index;
      const rawEvent = connection.parserBuffer.slice(0, separatorIndex);
      connection.parserBuffer = connection.parserBuffer.slice(separatorIndex + separatorMatch[0].length);
      const parsed = this.parseSseEvent(rawEvent);
      if (parsed) {
        this.onEvent(connection, parsed);
      }
    }
  }

  parseSseEvent(rawEvent) {
    const normalized = rawEvent.replace(/\r/g, '');
    const lines = normalized.split('\n');
    let eventName = 'message';
    const dataLines = [];

    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim() || eventName;
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) return null;
    return {
      event: eventName,
      data: dataLines.join('\n'),
    };
  }

  onEvent(connection, parsedEvent) {
    connection.lastEventAt = new Date().toISOString();
    const payload = parseJsonSafely(parsedEvent.data);
    const type = payload && typeof payload === 'object' && typeof payload.type === 'string'
      ? payload.type
      : parsedEvent.event;
    const sessionId = extractSessionId(payload);
    const sessionTitle = extractSessionTitle(payload);

    // Hand the raw event on before any of the console bookkeeping below, so a
    // change in how the console is maintained cannot silently stop the state
    // machine from seeing events.
    if (this.onSessionEvent && payload && typeof payload === 'object' && type) {
      this.onSessionEvent({
        ...payload,
        type,
        properties: {
          ...(payload.properties || {}),
          sessionID: (payload.properties && payload.properties.sessionID) || sessionId || connection.currentSessionId || null,
        },
      }, connection);
    }

    if (sessionId && !connection.currentSessionId) {
      this.switchSession(connection, sessionId, sessionTitle);
      this.seedSessionSnapshot(connection).catch((error) => {
        connection.lastError = error.message;
      });
      this.schedulePolling(connection);
    } else if (sessionId && connection.currentSessionId && sessionId !== connection.currentSessionId) {
      this.switchSession(connection, sessionId, sessionTitle);
      this.seedSessionSnapshot(connection).catch((error) => {
        connection.lastError = error.message;
      });
      this.schedulePolling(connection);
    } else if (sessionTitle && !connection.currentSessionTitle) {
      connection.currentSessionTitle = sessionTitle;
    }

    if (type && type.includes('todo')) {
      this.scheduleRefresh(connection);
      return;
    }

    if (
      type === 'message.part.delta'
      || type === 'message.part.updated'
      || type === 'message.updated'
      || type === 'session.updated'
      || type === 'session.diff'
      || type === 'session.status'
      || type === 'session.idle'
    ) {
      this.scheduleRefresh(connection);
      return;
    }

    const preview = buildEventPreview(type, payload);
    if (!preview || !preview.preview) return;

    this.pushMessage(connection, {
      id: extractSessionId(payload) ? `${type}:${extractSessionId(payload)}:${connection.lastEventAt}` : null,
      role: preview.role,
      preview: preview.preview,
      createdAt: connection.lastEventAt,
      source: 'event',
    });
  }

  switchSession(connection, sessionId, sessionTitle = null) {
    if (!sessionId || connection.currentSessionId === sessionId) return;
    connection.currentSessionId = sessionId;
    connection.currentSessionTitle = sessionTitle || null;
    connection.todoCount = 0;
    connection.messages = [];
    connection.messageFingerprints.clear();
    connection.snapshotLoaded = false;
    connection.snapshotLoading = false;
  }

  async seedSessionSnapshot(connection) {
    if (!connection.currentSessionId || connection.snapshotLoading || connection.snapshotLoaded) return;
    connection.snapshotLoading = true;

    try {
      const [messagesPayload, todoPayload, sessionsPayload] = await Promise.all([
        httpJsonRequest(connection.endpoint, 'GET', `/session/${encodeURIComponent(connection.currentSessionId)}/message`).catch(() => []),
        httpJsonRequest(connection.endpoint, 'GET', `/session/${encodeURIComponent(connection.currentSessionId)}/todo`).catch(() => []),
        httpJsonRequest(connection.endpoint, 'GET', '/session').catch(() => []),
      ]);

      const session = asArray(sessionsPayload).find((item) => pickSessionId(item) === connection.currentSessionId);
      if (session && !connection.currentSessionTitle) {
        connection.currentSessionTitle = session.title || session.name || null;
      }

      connection.todoCount = asArray(todoPayload).length;
      connection.messages = [];
      connection.messageFingerprints.clear();
      for (const entry of normalizeSessionMessages(messagesPayload)) {
        this.pushMessage(connection, entry);
      }
      connection.snapshotLoaded = true;
      connection.lastError = null;
      this.schedulePolling(connection);
    } finally {
      connection.snapshotLoading = false;
    }
  }

  scheduleRefresh(connection) {
    if (!connection.currentSessionId || connection.disposed) return;
    if (connection.refreshTimer) return;
    connection.refreshTimer = setTimeout(() => {
      connection.refreshTimer = null;
      this.refreshSessionState(connection).catch((error) => {
        connection.lastError = error.message;
      });
    }, REFRESH_DEBOUNCE_MS);
  }

  async refreshSessionState(connection) {
    if (!connection.currentSessionId || connection.snapshotLoading) return;
    const [messagesPayload, todoPayload] = await Promise.all([
      httpJsonRequest(connection.endpoint, 'GET', `/session/${encodeURIComponent(connection.currentSessionId)}/message`).catch(() => []),
      httpJsonRequest(connection.endpoint, 'GET', `/session/${encodeURIComponent(connection.currentSessionId)}/todo`).catch(() => []),
    ]);

    connection.todoCount = asArray(todoPayload).length;
    connection.messages = [];
    connection.messageFingerprints.clear();
    for (const entry of normalizeSessionMessages(messagesPayload)) {
      this.pushMessage(connection, entry);
    }
    connection.snapshotLoaded = true;
    connection.lastError = null;
  }

  pushMessage(connection, entry) {
    if (!entry || !entry.preview) return;
    const fingerprint = buildFingerprint(entry);
    if (connection.messageFingerprints.has(fingerprint)) return;

    connection.messageFingerprints.add(fingerprint);
    connection.messages.push(entry);
    if (connection.messages.length > MAX_BUFFERED_MESSAGES) {
      const removed = connection.messages.splice(0, connection.messages.length - MAX_BUFFERED_MESSAGES);
      for (const item of removed) {
        connection.messageFingerprints.delete(buildFingerprint(item));
      }
    }
  }
}

module.exports = {
  OpencodeEventBroker,
  _private: {
    extractUserTextFromMessages,
    normalizeSessionMessages,
    messagePayloadMatchesDashboardSession,
  },
};
