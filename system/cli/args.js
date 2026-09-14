'use strict';

const {
  REGISTRY_JSON_PATH,
  TASKS_JSON_PATH,
} = require('./common');

function parseArgs(argv) {
  const options = {
    command: null,
    registryPath: REGISTRY_JSON_PATH,
    tasksPath: TASKS_JSON_PATH,
    projectRoot: null,
    dbPath: null,
    runsPath: null,
    name: null,
    role: null,
    sessionId: null,
    status: null,
    taskId: null,
    note: '',
    reason: '',
    summary: '',
    tested: '',
    notTested: '',
    risks: '',
    files: '',
    issue: '',
    tried: '',
    need: '',
    suggest: '',
    question: '',
    message: '',
    optionsList: [],
    json: false,
    staleMinutes: 120,
    goal: [],
    scope: [],
    prereq: [],
    newId: null,
    parentId: null,
    source: null,
    includeNext: false,
    explainAll: false,
    priority: null,
    title: null,
    executionMode: null,
    adapterType: null,
    launchCommand: null,
    launchArgs: [],
    workspacePath: null,
    serverHost: null,
    serverPort: null,
    disabled: false,
    contextReviewed: null,
    contextNote: '',
    contextOperation: null,
    contextTarget: null,
    contextText: '',
    contextHints: [],
    cartridgeId: null,
    memoryPath: null,
  };

  if (argv.length > 0 && !argv[0].startsWith('--')) {
    options.command = argv[0];
    argv = argv.slice(1);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--registry' && i + 1 < argv.length) {
      options.registryPath = argv[++i];
    } else if (arg === '--project' && i + 1 < argv.length) {
      options.projectRoot = argv[++i];
    } else if (arg === '--tasks' && i + 1 < argv.length) {
      options.tasksPath = argv[++i];
    } else if (arg === '--db' && i + 1 < argv.length) {
      options.dbPath = argv[++i];
    } else if (arg === '--runs' && i + 1 < argv.length) {
      options.runsPath = argv[++i];
    } else if ((arg === '--name' || arg === '--agent') && i + 1 < argv.length) {
      options.name = argv[++i];
    } else if (arg === '--role' && i + 1 < argv.length) {
      options.role = argv[++i];
    } else if (arg === '--session-id' && i + 1 < argv.length) {
      options.sessionId = argv[++i];
    } else if (arg === '--status' && i + 1 < argv.length) {
      options.status = argv[++i];
    } else if (arg === '--task' && i + 1 < argv.length) {
      options.taskId = argv[++i];
    } else if (arg === '--note' && i + 1 < argv.length) {
      options.note = argv[++i];
    } else if (arg === '--reason' && i + 1 < argv.length) {
      options.reason = argv[++i];
    } else if (arg === '--summary' && i + 1 < argv.length) {
      options.summary = argv[++i];
    } else if (arg === '--tested' && i + 1 < argv.length) {
      options.tested = argv[++i];
    } else if (arg === '--not-tested' && i + 1 < argv.length) {
      options.notTested = argv[++i];
    } else if (arg === '--risks' && i + 1 < argv.length) {
      options.risks = argv[++i];
    } else if (arg === '--files' && i + 1 < argv.length) {
      options.files = argv[++i];
    } else if (arg === '--issue' && i + 1 < argv.length) {
      options.issue = argv[++i];
    } else if (arg === '--tried' && i + 1 < argv.length) {
      options.tried = argv[++i];
    } else if (arg === '--need' && i + 1 < argv.length) {
      options.need = argv[++i];
    } else if (arg === '--suggest' && i + 1 < argv.length) {
      options.suggest = argv[++i];
    } else if (arg === '--question' && i + 1 < argv.length) {
      options.question = argv[++i];
    } else if (arg === '--message' && i + 1 < argv.length) {
      options.message = argv[++i];
    } else if (arg === '--option' && i + 1 < argv.length) {
      options.optionsList.push(argv[++i]);
    } else if (arg === '--stale-minutes' && i + 1 < argv.length) {
      options.staleMinutes = Number(argv[++i]);
    } else if (arg === '--goal' && i + 1 < argv.length) {
      options.goal.push(argv[++i]);
    } else if (arg === '--scope' && i + 1 < argv.length) {
      options.scope.push(argv[++i]);
    } else if (arg === '--prereq' && i + 1 < argv.length) {
      options.prereq.push(argv[++i]);
    } else if (arg === '--priority' && i + 1 < argv.length) {
      options.priority = argv[++i];
    } else if (arg === '--new-id' && i + 1 < argv.length) {
      options.newId = argv[++i];
    } else if (arg === '--parent' && i + 1 < argv.length) {
      options.parentId = argv[++i];
    } else if (arg === '--source' && i + 1 < argv.length) {
      options.source = argv[++i];
    } else if (arg === '--title' && i + 1 < argv.length) {
      options.title = argv[++i];
    } else if (arg === '--execution-mode' && i + 1 < argv.length) {
      options.executionMode = argv[++i];
    } else if (arg === '--adapter' && i + 1 < argv.length) {
      options.adapterType = argv[++i];
    } else if (arg === '--command' && i + 1 < argv.length) {
      options.launchCommand = argv[++i];
    } else if (arg === '--launch-arg' && i + 1 < argv.length) {
      options.launchArgs.push(argv[++i]);
    } else if (arg === '--workspace' && i + 1 < argv.length) {
      options.workspacePath = argv[++i];
    } else if (arg === '--cartridge-id' && i + 1 < argv.length) {
      options.cartridgeId = argv[++i];
    } else if (arg === '--memory-path' && i + 1 < argv.length) {
      options.memoryPath = argv[++i];
    } else if (arg === '--server-host' && i + 1 < argv.length) {
      options.serverHost = argv[++i];
    } else if (arg === '--server-port' && i + 1 < argv.length) {
      options.serverPort = Number(argv[++i]);
    } else if (arg === '--disabled') {
      options.disabled = true;
    } else if (arg === '--context-reviewed' && i + 1 < argv.length) {
      options.contextReviewed = argv[++i];
    } else if (arg === '--context-note' && i + 1 < argv.length) {
      options.contextNote = argv[++i];
    } else if (arg === '--context-operation' && i + 1 < argv.length) {
      options.contextOperation = argv[++i];
    } else if (arg === '--context-target' && i + 1 < argv.length) {
      options.contextTarget = argv[++i];
    } else if (arg === '--context-text' && i + 1 < argv.length) {
      options.contextText = argv[++i];
    } else if (arg === '--context-hint' && i + 1 < argv.length) {
      options.contextHints.push(argv[++i]);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--include-next') {
      options.includeNext = true;
    } else if (arg === '--explain-all') {
      options.explainAll = true;
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.command) options.command = 'help';
  return options;
}

function printHelp() {
  console.log('Usage: node <tiny-agent-office>/system/agent-coordination.js <command> [options]');
  console.log('');
  console.log('Presence commands:');
  console.log('  anunciate       Register or refresh an agent session');
  console.log('  heartbeat       Refresh lastSeenAt for an existing session');
  console.log('  registry        Show current agent registry');
  console.log('  clear-registry  Clear active agent presence without touching tasks');
  console.log('');
  console.log('Task discovery commands:');
  console.log('  query           Read claimable work from the coordination runtime');
  console.log('  query-tasks     Alias for query');
  console.log('  assign          Claim one suitable task atomically for the caller');
  console.log('');
  console.log('Task mutation commands:');
  console.log('  claim           TODO -> CLAIMED');
  console.log('  start           CLAIMED -> IN_PROGRESS');
  console.log('  complete        -> DONE (with optional report)');
  console.log('  block           -> BLOCKED (requires --reason)');
  console.log('  unblock         BLOCKED -> IN_PROGRESS');
  console.log('  request-review  DONE -> REVIEW_NEEDED (implementation review only)');
  console.log('  junior-help     Jr-only: BLOCKED with help request');
  console.log('  ask-user        Put the session in attention and ask the user a structured question');
  console.log('  notify-secretary Send a non-blocking informational message to the secretary');
  console.log('  add-report      Append report without changing status');
  console.log('  pm-review       PM-only: user approval -> PM_REVIEWED or CONTEXT_UPDATED');
  console.log('  pm-status       PM-only: set any status');
  console.log('  create-task     PM/SP: create a new active task');
  console.log('  create-next-todo PM/SP: create a new Next-Todo item');
  console.log('  promote         PM: promote Next-Todo to active');
  console.log('');
  console.log('Common options:');
  console.log('  --registry <path>     Registry path. Default: <project>/.tiny-agent-office/coordination/agents.json');
  console.log('  --tasks <path>        Tasks JSON path. Default: <project>/.tiny-agent-office/coordination/tasks.json');
  console.log('  --project <path>      Project root. Default: current directory or TAO_PROJECT_ROOT');
  console.log('  --db <path>           Runtime SQLite path. Default: <project>/.tiny-agent-office/coordination/runtime.db');
  console.log('  --runs <path>         Run history mirror path. Default: <project>/.tiny-agent-office/coordination/runs.json');
  console.log('  --json                Emit JSON output');
  console.log('');
  console.log('Presence command options:');
  console.log('  --name <name>         Agent two-word session name');
  console.log('  --agent <name>        Alias for --name');
  console.log('  --role <role>         Role or acronym: PM, SP, SS, Jr');
  console.log('  --session-id <id>     Optional stable session id');
  console.log('  --status <status>     available, working, blocked, waiting, done, inactive');
  console.log('  --task <task-id>      Optional active task id');
  console.log('  --note <text>         Optional status note');
  console.log('  --execution-mode <m>  manual (default) or daemon');
  console.log('  --adapter <name>      Adapter label for daemon-managed workers');
  console.log('  --command <cmd>       Launch command for daemon-managed workers');
  console.log('  --launch-arg <arg>    Repeatable launch argument template');
  console.log('  --workspace <path>    Workspace path override for daemon launch');
  console.log('  --cartridge-id <id>   Stable cartridge identity for project-local memory');
  console.log('  --memory-path <path>  Exact project-local agent memory file');
  console.log('  --server-host <host>  Optional external control host for interactive clients');
  console.log('  --server-port <port>  Optional external control port for interactive clients');
  console.log('  --disabled            Mark agent as disabled for daemon scheduling');
  console.log('');
  console.log('Mutation command options:');
  console.log('  --task <task-id>      Target task ID (required)');
  console.log('  --name <name>         Agent name (required)');
  console.log('  --role <role>         Agent role (required)');
  console.log('  --reason <text>       Block reason (required for block)');
  console.log('  --summary <text>      Task report summary');
  console.log('  --tested <text>       What was tested');
  console.log('  --not-tested <text>   What was not tested');
  console.log('  --risks <text>        Risks or follow-up needed');
  console.log('  --files <list>        Changed files (comma-separated)');
  console.log('  --context-reviewed <updated|not-needed>');
  console.log('                       Senior Pro final review context decision');
  console.log('  --context-operation <append|replace|remove|merge>');
  console.log('                       Context proposal operation for Senior Pro final review');
  console.log('  --context-target <heading>');
  console.log('                       Target heading in <project>/.tiny-agent-office/general-context.md');
  console.log('  --context-text <text> Proposed context text');
  console.log('  --context-note <text> Context proposal reason or no-change note');
  console.log('  --issue <text>        Junior help: issue description');
  console.log('  --tried <text>        Junior help: what was tried');
  console.log('  --need <text>         Junior help: what is needed');
  console.log('  --suggest <text>      Junior help: suggested next step');
  console.log('  --question <text>     Structured user question text');
  console.log('  --option <text>       Repeatable suggested answer option');
  console.log('  --message <text>      Informational secretary message');
  console.log('');
  console.log('PM planning options:');
  console.log('  --title <text>        Task title (required for create-task)');
  console.log('  --role <role>         Recommended role for the task (required for create-task)');
  console.log('  --priority <text>     High, Medium, or Low');
  console.log('  --goal <text>         Repeatable; appends to goal array');
  console.log('  --scope <text>        Repeatable; appends to scope array');
  console.log('  --prereq <task-id>    Repeatable; adds prerequisite');
  console.log('  --parent <task-id>    Parent task ID for subtask creation');
  console.log('  --new-id <task-id>    New ID when promoting a Next-Todo item');
  console.log('  --source <text>       Optional source metadata');
  console.log('  --context-hint <heading>');
  console.log('                       Repeatable suggested context heading for task work');
  console.log('');
  console.log('Examples:');
  console.log('  node <tiny-agent-office>/system/agent-coordination.js assign --role SS --name "Silent Storm"');
  console.log('  node <tiny-agent-office>/system/agent-coordination.js query --role Jr --include-next --json');
  console.log('  node <tiny-agent-office>/system/agent-coordination.js anunciate --role SP --name "Iron Lantern SP"');
}

module.exports = {
  parseArgs,
  printHelp,
};
