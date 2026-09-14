'use strict';

const { parseArgs, printHelp } = require('./args');
const { formatResult } = require('./output');
const { configureProjectWorkspace } = require('../core/project-workspace');
const {
  anunciate,
  heartbeat,
  clearRegistry,
  listRegistry,
} = require('./registry-commands');
const {
  queryTasks,
  assignTask,
  claimTask,
  startTask,
  completeTask,
  blockTask,
  unblockTask,
  requestReviewTask,
  pmReviewTask,
  juniorHelpTask,
  askUserTask,
  addReportTask,
  pmStatusTask,
  createTask,
  createNextTodoTask,
  promoteTask,
} = require('./task-commands');
const { notifySecretary } = require('./secretary-commands');

function executeCommand(options) {
  switch (options.command) {
    case 'anunciate':
      return anunciate(options);
    case 'heartbeat':
      return heartbeat(options);
    case 'registry':
      return listRegistry(options);
    case 'clear-registry':
      return clearRegistry(options);
    case 'query':
    case 'query-tasks':
      return queryTasks(options);
    case 'assign':
      return assignTask(options);
    case 'claim':
      return claimTask(options);
    case 'start':
      return startTask(options);
    case 'complete':
      return completeTask(options);
    case 'block':
      return blockTask(options);
    case 'unblock':
      return unblockTask(options);
    case 'request-review':
      return requestReviewTask(options);
    case 'pm-review':
      return pmReviewTask(options);
    case 'junior-help':
      return juniorHelpTask(options);
    case 'ask-user':
      return askUserTask(options);
    case 'notify-secretary':
      return notifySecretary(options);
    case 'add-report':
      return addReportTask(options);
    case 'pm-status':
      return pmStatusTask(options);
    case 'create-task':
      return createTask(options);
    case 'create-next-todo':
      return createNextTodoTask(options);
    case 'promote':
      return promoteTask(options);
    case 'help':
      printHelp();
      return null;
    default:
      throw new Error(`Unknown command: ${options.command}`);
  }
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    configureProjectWorkspace(options.projectRoot || process.env.TAO_PROJECT_ROOT || process.cwd());
    if (options.command === 'help') {
      printHelp();
      return;
    }
    const result = executeCommand(options);
    if (result != null) {
      console.log(formatResult(result, options.json));
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  executeCommand,
  main,
};
