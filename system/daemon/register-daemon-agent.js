'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const { APP_ROOT } = require('../core/project-workspace');

// The application root, from the one module that derives it. This used to count
// parent segments by hand, and from system/daemon/ the count landed one level
// ABOVE the repository, so agents were registered against the directory that
// contains every project and were handed a coordination CLI path that does not
// exist. Six other modules had the same bug at their own depths.
const WORKSPACE_ROOT = APP_ROOT;
const COORDINATION_CLI = path.join(__dirname, '..', 'agent-coordination.js');

function printHelp() {
  console.log('Usage: node <tiny-agent-office>/system/register-daemon-agent.js --cli <codex|opencode> --role <PM|SP|SS|Jr> --name "<Agent Name>" [options]');
  console.log('');
  console.log('Required:');
  console.log('  --cli <name>          codex or opencode');
  console.log('  --role <role>         PM, SP, SS, or Jr');
  console.log('  --name <name>         Announced agent name');
  console.log('');
  console.log('Optional:');
  console.log('  --workspace <path>    Workspace path for the launched worker');
  console.log('  --model <model>       Model override for the target CLI');
  console.log('  --profile <profile>   Codex profile name');
  console.log('  --opencode-agent <a>  OpenCode agent preset name');
  console.log('  --tasks <path>        Tasks JSON mirror path');
  console.log('  --registry <path>     Registry JSON mirror path');
  console.log('  --db <path>           Runtime SQLite path');
  console.log('  --runs <path>         Run history mirror path');
  console.log('  --disabled            Register as daemon-managed but disabled');
  console.log('  --dry-run             Print the anunciate command without executing it');
  console.log('  --json                Print JSON result from the underlying CLI');
}

function parseArgs(argv) {
  const options = {
    cli: null,
    role: null,
    name: null,
    workspace: WORKSPACE_ROOT,
    model: null,
    profile: null,
    opencodeAgent: null,
    tasksPath: null,
    registryPath: null,
    dbPath: null,
    runsPath: null,
    disabled: false,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cli' && i + 1 < argv.length) {
      options.cli = argv[++i];
    } else if (arg === '--role' && i + 1 < argv.length) {
      options.role = argv[++i];
    } else if (arg === '--name' && i + 1 < argv.length) {
      options.name = argv[++i];
    } else if (arg === '--workspace' && i + 1 < argv.length) {
      options.workspace = path.resolve(argv[++i]);
    } else if (arg === '--model' && i + 1 < argv.length) {
      options.model = argv[++i];
    } else if (arg === '--profile' && i + 1 < argv.length) {
      options.profile = argv[++i];
    } else if (arg === '--opencode-agent' && i + 1 < argv.length) {
      options.opencodeAgent = argv[++i];
    } else if (arg === '--tasks' && i + 1 < argv.length) {
      options.tasksPath = argv[++i];
    } else if (arg === '--registry' && i + 1 < argv.length) {
      options.registryPath = argv[++i];
    } else if (arg === '--db' && i + 1 < argv.length) {
      options.dbPath = argv[++i];
    } else if (arg === '--runs' && i + 1 < argv.length) {
      options.runsPath = argv[++i];
    } else if (arg === '--disabled') {
      options.disabled = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.cli) throw new Error('--cli is required.');
  if (!options.role) throw new Error('--role is required.');
  if (!options.name) throw new Error('--name is required.');
  return options;
}

function buildCodexArgs(options) {
  const launchArgs = [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--cd',
    '{workspace}',
  ];

  if (options.model) {
    launchArgs.push('--model', options.model);
  }
  if (options.profile) {
    launchArgs.push('--profile', options.profile);
  }

  launchArgs.push('{instruction}');
  return {
    adapter: 'codex',
    command: 'codex',
    launchArgs,
  };
}

function buildOpenCodeArgs(options) {
  const launchArgs = [
    'run',
    '--dir',
    '{workspace}',
    '--auto',
  ];

  if (options.model) {
    launchArgs.push('--model', options.model);
  }
  if (options.opencodeAgent) {
    launchArgs.push('--agent', options.opencodeAgent);
  }

  launchArgs.push('{instruction}');
  return {
    adapter: 'opencode',
    command: 'opencode',
    launchArgs,
  };
}

function buildPreset(options) {
  const cli = String(options.cli).toLowerCase();
  if (cli === 'codex') return buildCodexArgs(options);
  if (cli === 'opencode') return buildOpenCodeArgs(options);
  throw new Error(`Unsupported --cli "${options.cli}". Supported values: codex, opencode.`);
}

function buildAnnouncementCommand(options) {
  const preset = buildPreset(options);
  const args = [
    COORDINATION_CLI,
    'anunciate',
    '--project', options.workspace,
    '--role', options.role,
    '--name', options.name,
    '--execution-mode', 'daemon',
    '--adapter', preset.adapter,
    '--command', preset.command,
    '--workspace', options.workspace,
  ];

  if (options.tasksPath) args.push('--tasks', options.tasksPath);
  if (options.registryPath) args.push('--registry', options.registryPath);
  if (options.dbPath) args.push('--db', options.dbPath);
  if (options.runsPath) args.push('--runs', options.runsPath);
  if (options.disabled) args.push('--disabled');
  if (options.json) args.push('--json');

  for (const launchArg of preset.launchArgs) {
    args.push('--launch-arg', launchArg);
  }

  return {
    executable: process.execPath,
    args,
  };
}

function shellQuote(value) {
  if (/^[a-zA-Z0-9_:\\/.\-{}]+$/.test(value)) return value;
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = buildAnnouncementCommand(options);

  if (options.dryRun) {
    console.log([shellQuote(command.executable), ...command.args.map(shellQuote)].join(' '));
    return;
  }

  const result = spawnSync(command.executable, command.args, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'daemon registration failed\n');
    process.exit(result.status || 1);
  }

  process.stdout.write(result.stdout);
}

if (require.main === module) {
  main();
}

module.exports = {
  WORKSPACE_ROOT,
  parseArgs,
  buildPreset,
  buildAnnouncementCommand,
  shellQuote,
  main,
};

