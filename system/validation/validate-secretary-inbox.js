'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const inbox = require('../core/secretary-inbox');
const runtimeStore = require('../runtime/runtime-store');
const { executeCommand } = require('../cli/main');
const { parseArgs } = require('../cli/args');

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-secretary-inbox-'));
const options = { projectRoot };

try {
  runtimeStore.ensureInitialized(options);
  runtimeStore.mutateCoordination(options, (state) => {
    inbox.addInboxItem(state.secretaryInbox, inbox.createSecretaryMessage({
      id: 'message-1', agentName: 'Iron Runner SS', role: 'Semi Senior', cartridgeId: 'cart-alpha',
      sessionId: 'session-alpha', body: 'The task is ready for review.',
    }));
    inbox.addInboxItem(state.secretaryInbox, inbox.createSecretaryQuestion({
      id: 'question-1', agentName: 'Iron Runner SS', role: 'Semi Senior', cartridgeId: 'cart-alpha',
      sessionId: 'session-alpha', taskId: 'TASK-101', body: 'Which layout should I use?',
      options: ['Compact', 'Comfortable'],
    }));
  });

  let persisted = runtimeStore.readCoordinationState(options).secretaryInbox;
  assert.deepEqual(persisted.items.map((item) => item.id), ['message-1', 'question-1']);
  assert.throws(() => inbox.dismissInboxMessage(persisted, 'question-1'), /question/i);
  assert.equal(inbox.dismissInboxMessage(persisted, 'message-1').dismissed.id, 'message-1');
  assert.equal(inbox.resolveInboxQuestion(persisted, { sessionId: 'session-alpha', answer: 'Compact' }).resolved.id, 'question-1');
  assert.equal(persisted.items.length, 0);
  assert.equal(persisted.history.length, 2);

  runtimeStore.mutateCoordination(options, (state) => {
    state.tasksStore.tasks = [{
      id: 'TASK-CLI',
      title: 'Exercise secretary commands',
      type: 'subtask',
      status: 'IN_PROGRESS',
      recommendedRole: 'Semi Senior',
      prerequisites: [],
      notes: [],
      claim: { agentName: 'Iron Runner SS', role: 'Semi Senior' },
    }];
    state.registry.agents = [{
      sessionId: 'session-cli',
      agentName: 'Iron Runner SS',
      role: 'Semi Senior',
      roleAcronym: 'SS',
      cartridgeId: 'cart-alpha',
      status: 'working',
      activeTaskId: 'TASK-CLI',
    }];
  });

  executeCommand(parseArgs([
    'notify-secretary', '--project', projectRoot, '--role', 'SS', '--name', 'Iron Runner SS',
    '--session-id', 'session-cli', '--message', 'Implementation checkpoint.',
  ]));
  executeCommand(parseArgs([
    'ask-user', '--project', projectRoot, '--role', 'SS', '--name', 'Iron Runner SS',
    '--session-id', 'session-cli', '--task', 'TASK-CLI', '--question', 'Choose a mode?', '--option', 'Safe', '--option', 'Fast',
  ]));

  persisted = runtimeStore.readCoordinationState(options).secretaryInbox;
  assert.equal(persisted.items.some((item) => item.type === 'message' && item.body === 'Implementation checkpoint.'), true);
  assert.equal(persisted.items.some((item) => item.type === 'question' && item.body === 'Choose a mode?' && item.options.length === 2), true);
  console.log('secretary inbox validation passed');
} finally {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
