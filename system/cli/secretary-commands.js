'use strict';

const { requireRole, mutateRuntime } = require('./common');
const { findAgent } = require('./registry-commands');
const { addInboxItem, createSecretaryMessage } = require('../core/secretary-inbox');

function notifySecretary(options) {
  if (!options.name) throw new Error('--name is required.');
  if (!options.message) throw new Error('--message is required for notify-secretary.');
  const role = requireRole(options.role);

  return mutateRuntime(options, (state) => {
    const agent = findAgent(state.registry, { ...options, role });
    if (!agent) throw new Error(`Agent session not found for ${options.name}. Announce the session first.`);
    if (agent.agentName !== options.name || agent.role !== role) throw new Error('Agent identity does not match the registered session.');
    const item = createSecretaryMessage({
      agentName: agent.agentName,
      role: agent.role,
      cartridgeId: agent.cartridgeId || options.cartridgeId || null,
      sessionId: agent.sessionId,
      taskId: options.taskId || agent.activeTaskId || null,
      body: options.message,
    });
    addInboxItem(state.secretaryInbox, item);
    return { message: 'Message sent to the secretary.', item };
  });
}

module.exports = { notifySecretary };
