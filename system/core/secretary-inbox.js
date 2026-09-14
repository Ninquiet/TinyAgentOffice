'use strict';

const crypto = require('crypto');

const HISTORY_LIMIT = 200;

function utcNow() {
  return new Date().toISOString();
}

function emptySecretaryInbox() {
  return { schemaVersion: 1, items: [], history: [], updatedAt: null };
}

function normalizeSecretaryInbox(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    schemaVersion: 1,
    items: Array.isArray(source.items) ? source.items : [],
    history: Array.isArray(source.history) ? source.history : [],
    updatedAt: source.updatedAt || null,
  };
}

function createItem(type, options = {}) {
  const body = String(options.body || '').trim();
  if (!body) throw new Error(`${type === 'question' ? 'Question' : 'Message'} text is required.`);
  return {
    id: options.id || crypto.randomUUID(),
    type,
    agentName: String(options.agentName || 'Unknown agent'),
    role: String(options.role || 'Unknown'),
    cartridgeId: options.cartridgeId || null,
    sessionId: options.sessionId || null,
    taskId: options.taskId || null,
    body,
    options: type === 'question'
      ? (Array.isArray(options.options) ? options.options.map(String).map((entry) => entry.trim()).filter(Boolean) : [])
      : [],
    createdAt: options.createdAt || utcNow(),
  };
}

function createSecretaryMessage(options) {
  return createItem('message', options);
}

function createSecretaryQuestion(options) {
  return createItem('question', options);
}

function addInboxItem(inbox, item) {
  const target = inbox || emptySecretaryInbox();
  if (!Array.isArray(target.items)) target.items = [];
  if (!Array.isArray(target.history)) target.history = [];
  if (!target.items.some((entry) => entry.id === item.id)) target.items.push(item);
  target.updatedAt = utcNow();
  return item;
}

function archiveItem(inbox, item, outcome) {
  if (!Array.isArray(inbox.history)) inbox.history = [];
  inbox.history.push({ ...item, ...outcome });
  inbox.history = inbox.history.slice(-HISTORY_LIMIT);
  inbox.updatedAt = utcNow();
}

function dismissInboxMessage(inbox, id) {
  const index = (inbox.items || []).findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`Secretary message ${id} not found.`);
  const item = inbox.items[index];
  if (item.type !== 'message') throw new Error('A question must be answered, not dismissed.');
  inbox.items.splice(index, 1);
  archiveItem(inbox, item, { dismissedAt: utcNow() });
  return { dismissed: item };
}

function resolveInboxQuestion(inbox, match = {}) {
  const index = (inbox.items || []).findIndex((item) => (
    item.type === 'question'
    && (match.id ? item.id === match.id : item.sessionId === match.sessionId)
  ));
  if (index < 0) return { resolved: null };
  const item = inbox.items[index];
  inbox.items.splice(index, 1);
  archiveItem(inbox, item, { answeredAt: utcNow(), answer: String(match.answer || '').trim() });
  return { resolved: item };
}

module.exports = {
  emptySecretaryInbox,
  normalizeSecretaryInbox,
  createSecretaryMessage,
  createSecretaryQuestion,
  addInboxItem,
  dismissInboxMessage,
  resolveInboxQuestion,
};
