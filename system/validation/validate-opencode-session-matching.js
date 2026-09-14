'use strict';

const assert = require('assert');
const { _private } = require('../opencode/event-broker');

const ironConnection = {
  dashboardSessionId: 'iron-lantern-sp-sp-1784676230462',
  agentName: 'Iron Lantern SP',
};

const namariaConnection = {
  dashboardSessionId: 'namaria-ss-1784676405002',
  agentName: 'namaria',
};

const messagesWithRegistryDiff = [
  {
    info: {
      role: 'assistant',
      summary: {
        diffs: [
          {
            patch: [
              'agentName: namaria',
              'sessionId: namaria-ss-1784676405002',
              'agentName: Iron Lantern SP',
              'sessionId: iron-lantern-sp-sp-1784676230462',
            ].join('\n'),
          },
        ],
      },
    },
    parts: [
      { type: 'text', text: 'Done.' },
    ],
  },
];

const messagesWithIronIdentityPrompt = [
  {
    info: { role: 'user' },
    parts: [
      {
        type: 'text',
        text: 'Agent Name: Iron Lantern SP. Session ID: iron-lantern-sp-sp-1784676230462.',
      },
    ],
  },
];

const messagesWithOnlySessionId = [
  {
    info: { role: 'user' },
    parts: [
      {
        type: 'text',
        text: 'Session ID: iron-lantern-sp-sp-1784676230462.',
      },
    ],
  },
];

assert.strictEqual(
  _private.messagePayloadMatchesDashboardSession(messagesWithRegistryDiff, ironConnection),
  false,
  'Assistant diffs must not bind an OpenCode session to Iron Lantern.',
);

assert.strictEqual(
  _private.messagePayloadMatchesDashboardSession(messagesWithRegistryDiff, namariaConnection),
  false,
  'Assistant diffs must not bind an OpenCode session to namaria.',
);

assert.strictEqual(
  _private.messagePayloadMatchesDashboardSession(messagesWithIronIdentityPrompt, ironConnection),
  true,
  'User identity prompt should bind the matching dashboard session.',
);

assert.strictEqual(
  _private.messagePayloadMatchesDashboardSession(messagesWithIronIdentityPrompt, namariaConnection),
  false,
  'User identity prompt must not bind a different dashboard session.',
);

assert.strictEqual(
  _private.messagePayloadMatchesDashboardSession(messagesWithOnlySessionId, ironConnection),
  false,
  'A session id without the matching agent name is not enough to bind a dashboard console.',
);

assert.strictEqual(
  _private.extractUserTextFromMessages(messagesWithRegistryDiff),
  '',
  'Only real user text parts should be inspected.',
);

const messagesWithNativeError = [
  {
    info: {
      id: 'msg_error',
      role: 'assistant',
      time: { created: 1784758862985 },
      error: {
        name: 'APIError',
        data: {
          message: 'Bad Request: {"detail":"The gpt-5.3-codex-spark model is not supported."}',
        },
      },
    },
    parts: [
      { type: 'patch', hash: 'abc' },
    ],
  },
];

const normalizedError = _private.normalizeSessionMessages(messagesWithNativeError);
assert.strictEqual(normalizedError[0].role, 'error', 'Native OpenCode errors should be visible in the fake terminal.');
assert.match(normalizedError[0].preview, /model is not supported/i, 'Native OpenCode error text should be preserved.');

console.log('OpenCode session matching validation passed.');
