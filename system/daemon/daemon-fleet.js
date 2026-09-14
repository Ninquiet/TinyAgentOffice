'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const registerHelper = require('./register-daemon-agent');
const COORDINATION_CLI = path.join(__dirname, '..', 'agent-coordination.js');
const runtimeStore = require('../runtime/runtime-store');
const runtimeReconcile = require('../runtime/runtime-reconcile');
const sessionDispatch = require('../dispatch/session-dispatch');
const terminalWindowHost = require('../platform/terminal-window-host');
const { getActiveProjectWorkspace } = require('../core/project-workspace');
const agentMemory = require('../core/agent-memory');

const WORKSPACE_ROOT = registerHelper.WORKSPACE_ROOT;
const DAEMON_SCRIPT = path.join(__dirname, '..', 'agent-daemon.js');
const DASHBOARD_SCRIPT = path.join(__dirname, '..', 'dashboard-server.js');
const NAME_ADJECTIVES = ['Silver', 'Amber', 'Silent', 'Iron', 'Blue', 'Bright', 'Copper', 'Steel', 'Crimson', 'Golden'];
const NAME_NOUNS = ['Falcon', 'Lantern', 'Storm', 'Harbor', 'Compass', 'Sparrow', 'Beacon', 'Forge', 'Cinder', 'Valley'];
const OPENCODE_HOST = '127.0.0.1';
const OPENCODE_PORT_START = 43100;
const OPENCODE_PORT_END = 43199;
const OPENCODE_AUTO_APPROVE_ARG = '--auto';
const pendingOpencodePorts = new Set();

function defaultConfigPath() {
  return getActiveProjectWorkspace().paths.daemonFleetFile;
}

function utcNow() {
  return new Date().toISOString();
}

function defaultConfig() {
  return {
    schemaVersion: 1,
    updatedAt: utcNow(),
    dashboardPort: 5189,
    daemonIntervalMs: 5000,
    agents: [],
  };
}

function printHelp() {
  console.log('Usage: node <tiny-agent-office>/system/daemon-fleet.js <add|remove|list|register|launch|up|down|init> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  init        Create the fleet config if it does not exist');
  console.log('  add         Add or update one agent preset in the fleet config');
  console.log('  remove      Remove one agent preset from the fleet config');
  console.log('  list        Print the current fleet config');
  console.log('  register    Register all enabled presets through the daemon-agent helper');
  console.log('  launch      Open one preset in a visible manual terminal');
  console.log('  up          Register enabled presets and start dashboard + daemon if needed');
  console.log('  down        Stop the daemon scheduler and any tracked daemon workers');
  console.log('');
  console.log('Common options:');
  console.log('  --config <path>            Fleet config path');
  console.log('  --tasks <path>             Tasks JSON mirror path');
  console.log('  --registry <path>          Registry JSON mirror path');
  console.log('  --db <path>                Runtime SQLite path');
  console.log('  --runs <path>              Run history mirror path');
  console.log('  --dashboard-port <port>    Dashboard port override');
  console.log('  --daemon-interval-ms <ms>  Scheduler interval override');
  console.log('  --json                     Print JSON when supported');
  console.log('');
  console.log('Add command options:');
  console.log('  --cli <codex|opencode>');
  console.log('  --role <PM|SP|SS|Jr>');
  console.log('  --name "<Agent Name>"    Optional. Auto-generated when omitted');
  console.log('  --workspace <path>');
  console.log('  --model <model>');
  console.log('  --profile <profile>');
  console.log('  --opencode-agent <agent>');
  console.log('  --disabled');
}

function parseArgs(argv) {
  const options = {
    command: 'list',
    configPath: defaultConfigPath(),
    tasksPath: null,
    registryPath: null,
    dbPath: null,
    runsPath: null,
    dashboardPort: null,
    daemonIntervalMs: null,
    cli: null,
    role: null,
    name: null,
    workspace: WORKSPACE_ROOT,
    model: null,
    profile: null,
    opencodeAgent: null,
    startupInstructions: '',
    disabled: false,
    noDashboard: false,
    json: false,
  };

  if (argv.length > 0 && !argv[0].startsWith('--')) {
    options.command = argv[0];
    argv = argv.slice(1);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config' && i + 1 < argv.length) {
      options.configPath = path.resolve(argv[++i]);
    } else if (arg === '--tasks' && i + 1 < argv.length) {
      options.tasksPath = argv[++i];
    } else if (arg === '--registry' && i + 1 < argv.length) {
      options.registryPath = argv[++i];
    } else if (arg === '--db' && i + 1 < argv.length) {
      options.dbPath = argv[++i];
    } else if (arg === '--runs' && i + 1 < argv.length) {
      options.runsPath = argv[++i];
    } else if (arg === '--dashboard-port' && i + 1 < argv.length) {
      options.dashboardPort = Number(argv[++i]);
    } else if (arg === '--daemon-interval-ms' && i + 1 < argv.length) {
      options.daemonIntervalMs = Number(argv[++i]);
    } else if (arg === '--cli' && i + 1 < argv.length) {
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
    } else if (arg === '--startup-instructions' && i + 1 < argv.length) {
      options.startupInstructions = argv[++i];
    } else if (arg === '--disabled') {
      options.disabled = true;
    } else if (arg === '--no-dashboard') {
      options.noDashboard = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) return defaultConfig();
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function writeConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function normalizeConfigForActiveProject(config) {
  const projectRoot = getActiveProjectWorkspace().projectRoot;
  let changed = false;
  const agents = Array.isArray(config.agents) ? config.agents : [];
  for (const agent of agents) {
    if (path.resolve(agent.workspace || WORKSPACE_ROOT) === projectRoot) continue;
    agent.workspace = projectRoot;
    changed = true;
  }
  if (changed) config.updatedAt = utcNow();
  return changed;
}

// Pure read: parses the config and normalizes it in memory without touching
// disk. Returns whether normalization changed anything, so the callers that are
// allowed to write can decide to persist it.
function loadConfig(configPath) {
  const config = readConfig(configPath);
  const changed = normalizeConfigForActiveProject(config);
  return { config, changed };
}

function ensureConfig(configPath) {
  const { config, changed } = loadConfig(configPath);
  // Only write when normalization actually changed something, or when the file
  // does not exist yet. This used to write unconditionally, and listConfig runs
  // on every dashboard render: that was several disk writes per second, a
  // permanently dirty daemon-fleet.json in git, and a file both the dashboard
  // and the daemon rewrote concurrently.
  if (changed || !fs.existsSync(configPath)) {
    writeConfig(configPath, config);
  }
  return config;
}

function normalizeRoleSuffix(role) {
  const normalized = String(role || '').toLowerCase();
  if (normalized === 'sp' || normalized === 'senior pro') return 'SP';
  if (normalized === 'ss' || normalized === 'semi senior') return 'SS';
  if (normalized === 'jr' || normalized === 'junior') return 'Jr';
  if (normalized === 'pm' || normalized === 'project manager') return 'PM';
  return String(role || '').trim() || 'Agent';
}

function coordinationRoleName(role) {
  const normalized = String(role || '').toLowerCase();
  if (normalized === 'sp' || normalized === 'senior pro') return 'Senior Pro';
  if (normalized === 'ss' || normalized === 'semi senior') return 'Semi Senior';
  if (normalized === 'jr' || normalized === 'junior') return 'Junior';
  if (normalized === 'pm' || normalized === 'project manager') return 'Project Manager';
  return String(role || '');
}

function generateAgentName(role, existingAgents) {
  const suffix = normalizeRoleSuffix(role);
  const taken = new Set((existingAgents || []).map((agent) => String(agent.name || '').toLowerCase()));
  const takenBases = new Set((existingAgents || []).map((agent) => (
    String(agent.name || '')
      .replace(/\s+(SP|SS|Jr|PM)$/i, '')
      .trim()
      .toLowerCase()
  )));

  for (const adjective of NAME_ADJECTIVES) {
    for (const noun of NAME_NOUNS) {
      const base = `${adjective} ${noun}`;
      const candidate = `${base} ${suffix}`;
      if (!taken.has(candidate.toLowerCase()) && !takenBases.has(base.toLowerCase())) {
        return candidate;
      }
    }
  }

  let index = 1;
  while (true) {
    const candidate = `Agent ${suffix} ${index}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
}

function toAgentSpec(options) {
  if (!options.cli) throw new Error('--cli is required for add.');
  if (!options.role) throw new Error('--role is required for add.');
  return {
    cli: options.cli,
    role: options.role,
    name: options.name || null,
    workspace: options.workspace || WORKSPACE_ROOT,
    model: options.model || null,
    profile: options.profile || null,
    opencodeAgent: options.opencodeAgent || null,
    startupInstructions: options.startupInstructions || '',
    disabled: Boolean(options.disabled),
  };
}

function addAgent(options) {
  const config = ensureConfig(options.configPath);
  const spec = toAgentSpec(options);
  if (!Array.isArray(config.agents)) config.agents = [];
  const generatedName = !spec.name;
  if (!spec.name) {
    spec.name = generateAgentName(spec.role, config.agents);
  }
  const existingIndex = (config.agents || []).findIndex((entry) => entry.name === spec.name);
  if (existingIndex === -1) config.agents.push(spec);
  else config.agents[existingIndex] = spec;
  config.updatedAt = utcNow();
  if (Number.isInteger(options.dashboardPort)) config.dashboardPort = options.dashboardPort;
  if (Number.isInteger(options.daemonIntervalMs)) config.daemonIntervalMs = options.daemonIntervalMs;
  writeConfig(options.configPath, config);
  return { message: generatedName ? `${spec.name} auto-generated and saved to daemon fleet config.` : `${spec.name} saved to daemon fleet config.`, config };
}

function updateAgent(options) {
  if (!options.name) throw new Error('--name is required for update.');
  const config = ensureConfig(options.configPath);
  const existingIndex = (config.agents || []).findIndex((entry) => entry.name === options.name);
  if (existingIndex === -1) {
    throw new Error(`Agent preset "${options.name}" not found.`);
  }

  const existing = config.agents[existingIndex];
  const next = {
    ...existing,
  };

  if (Object.prototype.hasOwnProperty.call(options, 'cli') && options.cli !== undefined) next.cli = options.cli;
  if (Object.prototype.hasOwnProperty.call(options, 'role') && options.role !== undefined) next.role = options.role;
  if (Object.prototype.hasOwnProperty.call(options, 'workspace') && options.workspace !== undefined) next.workspace = options.workspace || WORKSPACE_ROOT;
  if (Object.prototype.hasOwnProperty.call(options, 'model')) next.model = options.model || null;
  if (Object.prototype.hasOwnProperty.call(options, 'profile')) next.profile = options.profile || null;
  if (Object.prototype.hasOwnProperty.call(options, 'opencodeAgent')) next.opencodeAgent = options.opencodeAgent || null;
  if (Object.prototype.hasOwnProperty.call(options, 'startupInstructions')) next.startupInstructions = options.startupInstructions || '';
  if (Object.prototype.hasOwnProperty.call(options, 'disabled')) next.disabled = Boolean(options.disabled);

  config.agents[existingIndex] = next;
  config.updatedAt = utcNow();
  writeConfig(options.configPath, config);
  return {
    message: `${next.name} updated.`,
    agent: next,
    config,
  };
}

function removeAgent(options) {
  if (!options.name) throw new Error('--name is required for remove.');
  const config = ensureConfig(options.configPath);
  const before = Array.isArray(config.agents) ? config.agents.length : 0;
  config.agents = (config.agents || []).filter((entry) => entry.name !== options.name);
  if (config.agents.length === before) {
    throw new Error(`Agent preset "${options.name}" not found.`);
  }
  config.updatedAt = utcNow();
  writeConfig(options.configPath, config);
  return { message: `${options.name} removed from daemon fleet config.`, config };
}

// Read-only. Never writes, so it is safe to call from the render path.
function listConfig(options) {
  return loadConfig(options.configPath).config;
}

function spawnNodeDetached(scriptPath, args, cwd) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function spawnDetachedProcess(command, args, cwd, windowsHide = true) {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide,
  });
  child.unref();
  return child.pid;
}

function launchVisibleTerminal(command, args, cwd) {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      [
        `$filePath = ${psQuote(command)}`,
        `$workingDir = ${psQuote(cwd)}`,
        `$argList = @(${args.map((arg) => psQuote(arg)).join(', ')})`,
        '$p = Start-Process -FilePath $filePath -ArgumentList $argList -WorkingDirectory $workingDir -WindowStyle Minimized -PassThru',
        'Write-Output $p.Id',
      ].join('; '),
    ], {
      encoding: 'utf8',
      windowsHide: true,
    });

    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Could not launch visible terminal for ${command}.`);
    }

    const pid = Number.parseInt(String(result.stdout || '').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Could not resolve launcher PID for ${command}.`);
    }
    return pid;
  }

  return spawnDetachedProcess(command, args, cwd, false);
}

function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return result.status === 0;
  }

  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch (_) {
    return false;
  }
}

function requestKillPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (process.platform === 'win32') {
    try {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return true;
    } catch (_) {
      return false;
    }
  }

  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch (_) {
    return false;
  }
}

function psQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function resolveManualTerminalPid(sessionId, fallbackPid = null) {
  if (process.platform !== 'win32') {
    return fallbackPid;
  }

  const escapedSessionId = String(sessionId || '').replace(/'/g, "''");
  const script = [
    `$sessionId = '${escapedSessionId}'`,
    '$match = Get-CimInstance Win32_Process',
    "  | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like ('*' + $sessionId + '*') }",
    '  | Sort-Object CreationDate -Descending',
    '  | Select-Object -First 1',
    'if ($match) { Write-Output $match.ProcessId }',
  ].join('; ');

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const pid = Number.parseInt(String(result.stdout || '').trim(), 10);
    if (Number.isInteger(pid) && pid > 0) {
      return pid;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }

  return fallbackPid;
}

function buildManualCliArgs(spec) {
  const cli = String(spec.cli || '').toLowerCase();
  if (cli === 'codex') {
    const args = ['--yolo'];
    if (spec.model) args.push('--model', spec.model);
    if (spec.profile) args.push('--profile', spec.profile);
    return { command: 'codex', args };
  }

  if (cli === 'opencode') {
    const args = [spec.workspace || WORKSPACE_ROOT, OPENCODE_AUTO_APPROVE_ARG];
    if (spec.model) args.push('--model', spec.model);
    if (spec.opencodeAgent) args.push('--agent', spec.opencodeAgent);
    return { command: 'opencode', args };
  }

  throw new Error(`Unsupported CLI "${spec.cli}" for manual launch.`);
}

function canBindPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function allocateOpencodePort(snapshot) {
  const claimedPorts = new Set((snapshot.registry.agents || [])
    .map((agent) => Number(agent.serverPort))
    .filter((port) => Number.isInteger(port) && port > 0));
  for (const port of pendingOpencodePorts) {
    claimedPorts.add(port);
  }

  for (let port = OPENCODE_PORT_START; port <= OPENCODE_PORT_END; port += 1) {
    if (claimedPorts.has(port)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await canBindPort(OPENCODE_HOST, port)) return port;
  }

  throw new Error(`No free OpenCode port is available in ${OPENCODE_PORT_START}-${OPENCODE_PORT_END}.`);
}

function buildPowerShellInvocation(command, args) {
  return `& ${[psQuote(command), ...args.map((arg) => psQuote(arg))].join(' ')}`;
}

function buildManualLaunchScript(spec, options) {
  const workspace = spec.workspace || WORKSPACE_ROOT;
  const sessionId = options.sessionId;
  const announceArgs = [
    COORDINATION_CLI,
    'anunciate',
    '--project', workspace,
    '--role', spec.role,
    '--name', spec.name,
    '--session-id', sessionId,
    '--execution-mode', 'manual',
    '--workspace', workspace,
    '--note', 'Manual terminal launched from dashboard',
  ];

  if (options.tasksPath) announceArgs.push('--tasks', options.tasksPath);
  if (options.registryPath) announceArgs.push('--registry', options.registryPath);
  if (options.dbPath) announceArgs.push('--db', options.dbPath);
  if (options.runsPath) announceArgs.push('--runs', options.runsPath);
  if (options.serverHost) announceArgs.push('--server-host', options.serverHost);
  if (options.serverPort) announceArgs.push('--server-port', String(options.serverPort));
  if (options.cartridgeId) announceArgs.push('--cartridge-id', options.cartridgeId);
  if (options.memoryPath) announceArgs.push('--memory-path', options.memoryPath);

  const manualCli = buildManualCliArgs(spec);
  if (String(spec.cli || '').toLowerCase() === 'opencode') {
    manualCli.args.push('--hostname', options.serverHost || OPENCODE_HOST);
    manualCli.args.push('--port', String(options.serverPort));
  }
  return [
    `$Host.UI.RawUI.WindowTitle = ${psQuote(spec.name)}`,
    `Set-Location ${psQuote(workspace)}`,
    String(spec.cli || '').toLowerCase() === 'opencode' ? "$env:OPENCODE_DISABLE_AUTOUPDATE = 'true'" : null,
    `Write-Host ${psQuote(`Agent Name: ${spec.name}`)}`,
    `Write-Host ${psQuote(`Role: ${coordinationRoleName(spec.role)}`)}`,
    options.memoryPath ? `Write-Host ${psQuote(`Agent Memory: ${options.memoryPath}`)}` : null,
    `Write-Host ${psQuote('Read .tiny-agent-office/AGENTS.md, .tiny-agent-office/agents-principles.md, .tiny-agent-office/general-context.md, and the assigned agent memory file, then wait for dashboard or user instructions. Use English and keep explanations brief unless more detail is requested.')}`,
    buildPowerShellInvocation(process.execPath, announceArgs),
    'if ($LASTEXITCODE -ne 0) { Write-Host "Agent announcement failed." -ForegroundColor Red }',
    buildPowerShellInvocation(manualCli.command, manualCli.args),
  ].filter(Boolean).join('; ');
}

function buildLaunchIdentityPrompt(agent, spec = {}) {
  const projectRoot = path.resolve(spec.workspace || agent.workspacePath || WORKSPACE_ROOT);
  const coordinationCli = path.join(WORKSPACE_ROOT, 'system', 'agent-coordination.js');
  const lines = [
    `Agent Name: ${agent.agentName}.`,
    `Role: ${agent.role}.`,
    `Session ID: ${agent.sessionId}.`,
    agent.cartridgeId ? `Cartridge ID: ${agent.cartridgeId}.` : null,
    agent.memoryPath ? `Agent Memory Path: ${agent.memoryPath}. Read it after the shared project instructions and before task work. Update it briefly after completing each task.` : null,
    `Project root: ${projectRoot}.`,
    `Use the coordination CLI at: ${coordinationCli}.`,
    `Every coordination CLI command must include: --project "${projectRoot}".`,
    'This manual session is already registered by the dashboard.',
    'Use exactly that Agent Name and Session ID in all coordination CLI calls.',
    'Do not invent another name for this session.',
    'For now, read .tiny-agent-office/AGENTS.md, .tiny-agent-office/agents-principles.md, and .tiny-agent-office/general-context.md, confirm the registered identity, and wait for user or dashboard instructions.',
    'Communicate in English and keep explanations brief unless more detail is requested.',
  ];
  if (String(spec.startupInstructions || '').trim()) {
    lines.push(`Custom startup instructions: ${String(spec.startupInstructions).trim()}`);
  }
  return lines.filter(Boolean).join(' ');
}

function httpGetStatus(port, pathName) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathName, timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function runDaemonStatus(options) {
  const projectRoot = getActiveProjectWorkspace().projectRoot;
  const args = [DAEMON_SCRIPT, 'status', '--json', '--workspace', projectRoot];
  if (options.tasksPath) args.push('--tasks', options.tasksPath);
  if (options.registryPath) args.push('--registry', options.registryPath);
  if (options.dbPath) args.push('--db', options.dbPath);
  if (options.runsPath) args.push('--runs', options.runsPath);

  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (_) {
    return null;
  }
}

function setDaemonStopped(options, lastError = null) {
  runtimeStore.mutateCoordination({
    tasksPath: options.tasksPath || null,
    registryPath: options.registryPath || null,
    dbPath: options.dbPath || null,
    runsPath: options.runsPath || null,
  }, (state) => {
    state.daemonStatus = {
      ...state.daemonStatus,
      running: false,
      pid: null,
      intervalMs: null,
      lastTickAt: utcNow(),
      lastError,
      updatedAt: utcNow(),
    };
  });
}

function clearDaemonSessions(options) {
  runtimeStore.mutateCoordination({
    tasksPath: options.tasksPath || null,
    registryPath: options.registryPath || null,
    dbPath: options.dbPath || null,
    runsPath: options.runsPath || null,
  }, (state) => {
    state.registry.agents = (state.registry.agents || []).filter((agent) => agent.executionMode !== 'daemon');
    state.registry.updatedAt = utcNow();
  });
}

function registerAgentSpec(spec, options) {
  const registration = {
    cli: spec.cli,
    role: spec.role,
    name: spec.name,
    workspace: spec.workspace || WORKSPACE_ROOT,
    model: spec.model || null,
    profile: spec.profile || null,
    opencodeAgent: spec.opencodeAgent || null,
    startupInstructions: spec.startupInstructions || '',
    tasksPath: options.tasksPath || null,
    registryPath: options.registryPath || null,
    dbPath: options.dbPath || null,
    runsPath: options.runsPath || null,
    disabled: Boolean(spec.disabled),
    json: true,
  };

  const command = registerHelper.buildAnnouncementCommand(registration);
  const result = spawnSync(command.executable, command.args, {
    cwd: registration.workspace,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Could not register ${spec.name}.`);
  }

  return JSON.parse(result.stdout);
}

function registerFleet(options) {
  const config = ensureConfig(options.configPath);
  const enabledAgents = (config.agents || []).filter((agent) => !agent.disabled);
  const registered = [];
  for (const spec of enabledAgents) {
    registered.push(registerAgentSpec(spec, options));
  }
  return {
    message: `Registered ${registered.length} daemon-managed agent(s).`,
    registered,
    skippedDisabled: (config.agents || []).filter((agent) => agent.disabled).map((agent) => agent.name),
    config,
  };
}

function registerOne(options) {
  const config = ensureConfig(options.configPath);
  const spec = (config.agents || []).find((agent) => agent.name === options.name);
  if (!spec) throw new Error(`Agent preset "${options.name}" not found.`);
  return {
    message: `${spec.name} registered.`,
    registered: registerAgentSpec(spec, options),
  };
}

async function launchPreset(options) {
  const config = ensureConfig(options.configPath);
  const spec = (config.agents || []).find((agent) => agent.name === options.name);
  if (!spec) throw new Error(`Agent preset "${options.name}" not found.`);
  const launchWorkspace = path.resolve(options.workspace || spec.workspace || WORKSPACE_ROOT);
  const memory = options.cartridgeId ? agentMemory.ensureAgentMemory({
    projectRoot: launchWorkspace,
    cartridgeId: options.cartridgeId,
    agentName: spec.name,
    role: coordinationRoleName(spec.role),
  }) : null;

  const runtimeOptions = {
    projectRoot: launchWorkspace,
    tasksPath: options.tasksPath || null,
    registryPath: options.registryPath || null,
    dbPath: options.dbPath || null,
    runsPath: options.runsPath || null,
  };
  const roleName = coordinationRoleName(spec.role);
  const snapshot = runtimeStore.readCoordinationState(runtimeOptions);
  const matchingSessions = (snapshot.registry.agents || []).filter((agent) => (
    agent.agentName === spec.name
    && agent.role === roleName
    && agent.executionMode === 'manual'
    && (!options.cartridgeId || agent.cartridgeId === options.cartridgeId)
  ));
  const existingSession = matchingSessions.find((agent) => (
    Number.isInteger(agent.terminalPid) && runtimeReconcile.isPidAlive(agent.terminalPid)
    && (String(spec.cli || '').toLowerCase() !== 'opencode' || Number.isInteger(agent.serverPort))
    && path.resolve(agent.workspacePath || WORKSPACE_ROOT) === launchWorkspace
  ));
  if (existingSession) {
    return {
      message: `${spec.name} is already launched.`,
      launched: {
        name: spec.name,
        cli: spec.cli,
        role: spec.role,
        pid: existingSession.terminalPid,
        sessionId: existingSession.sessionId,
        cartridgeId: existingSession.cartridgeId,
        memoryPath: existingSession.memoryPath,
      },
    };
  }

  const sessionId = sessionDispatch.createSessionId(spec.name, roleName);
  const serverPort = String(spec.cli || '').toLowerCase() === 'opencode'
    ? await allocateOpencodePort(snapshot)
    : null;
  if (Number.isInteger(serverPort) && serverPort > 0) {
    pendingOpencodePorts.add(serverPort);
  }
  const serverHost = serverPort ? OPENCODE_HOST : null;
  try {
    const beforeWindows = process.platform === 'win32'
      ? terminalWindowHost.listWindows()
      : [];
    const launchSpec = { ...spec, workspace: launchWorkspace };
    const script = buildManualLaunchScript(launchSpec, {
      ...options,
      sessionId,
      serverHost,
      serverPort,
      memoryPath: memory?.path || null,
    });
    const launchPid = launchVisibleTerminal('powershell.exe', ['-NoExit', '-Command', script], launchWorkspace);
    const pid = resolveManualTerminalPid(sessionId, launchPid);
    const hostWindow = process.platform === 'win32'
      ? terminalWindowHost.waitForWindowRegistration(beforeWindows, {
          titleHints: [spec.name, sessionId],
          timeoutMs: 4000,
        })
      : null;

    runtimeStore.mutateCoordination(runtimeOptions, (state) => {
      const now = utcNow();
      state.registry.agents = (state.registry.agents || []).filter((agent) => !(
        agent.agentName === spec.name
        && agent.role === roleName
        && agent.executionMode === 'manual'
        && !agent.activeTaskId
      ));
      state.registry.agents.push({
        sessionId,
        agentName: spec.name,
        role: roleName,
        roleAcronym: spec.role,
        status: 'available',
        activeTaskId: null,
        note: 'Manual terminal launched from dashboard',
        announcedAt: now,
        lastSeenAt: now,
        executionMode: 'manual',
        adapterType: spec.cli,
        launchCommand: null,
        launchArgs: [],
        workspacePath: launchWorkspace,
        cartridgeId: options.cartridgeId,
        memoryPath: memory?.path || null,
        disabled: false,
        terminalPid: pid,
        terminalHostPid: hostWindow && Number.isInteger(hostWindow.pid) ? hostWindow.pid : null,
        terminalWindowHandle: hostWindow && Number.isInteger(hostWindow.handle) ? hostWindow.handle : null,
        terminalHostProcessName: hostWindow ? hostWindow.processName || null : null,
        terminalWindowTitle: hostWindow ? hostWindow.title || null : null,
        serverHost,
        serverPort,
      });
      state.registry.updatedAt = now;
    });

    const launchedAgent = {
      sessionId,
      agentName: spec.name,
      role: roleName,
      adapterType: spec.cli,
      terminalPid: pid,
      terminalHostPid: hostWindow && Number.isInteger(hostWindow.pid) ? hostWindow.pid : null,
      terminalWindowHandle: hostWindow && Number.isInteger(hostWindow.handle) ? hostWindow.handle : null,
      terminalHostProcessName: hostWindow ? hostWindow.processName || null : null,
      terminalWindowTitle: hostWindow ? hostWindow.title || null : null,
      serverHost,
      serverPort,
      cartridgeId: options.cartridgeId,
      memoryPath: memory?.path || null,
    };

    if (String(spec.cli || '').toLowerCase() === 'opencode' && Number.isInteger(serverPort)) {
      try {
        const promptResult = await sessionDispatch.sendPromptToOpencode(
          launchedAgent,
          buildLaunchIdentityPrompt(launchedAgent, spec),
          { runtimeOptions, command: 'launch-identity' }
        );

        // A refusal does not throw, and on a fresh launch it also carries no
        // session id -- so without this check the launch reported success while
        // the agent was never told who it is. That is the same identity failure
        // as the broken CLI path, caused by a cap instead of a bad path.
        if (promptResult && promptResult.delivered === false) {
          throw new Error(`identity prompt refused: ${promptResult.refusedReason}`);
        }

        if (promptResult && promptResult.opencodeSessionId) {
          runtimeStore.mutateCoordination(runtimeOptions, (state) => {
            const agent = (state.registry.agents || []).find((entry) => entry.sessionId === sessionId);
            if (agent) {
              agent.opencodeSessionId = promptResult.opencodeSessionId;
              agent.opencodeSessionTitle = promptResult.opencodeSessionTitle || null;
              agent.lastSeenAt = utcNow();
            }
            state.registry.updatedAt = utcNow();
          });
        }
      } catch (error) {
        runtimeStore.mutateCoordination(runtimeOptions, (state) => {
          const agent = (state.registry.agents || []).find((entry) => entry.sessionId === sessionId);
          if (agent) {
            agent.note = `Manual terminal launched; initial identity prompt failed: ${error.message}`;
            agent.lastSeenAt = utcNow();
          }
          state.registry.updatedAt = utcNow();
        });
      }
    }

    return {
      message: `${spec.name} launched in a manual terminal.`,
      launched: {
        name: spec.name,
        cli: spec.cli,
        role: spec.role,
          pid,
          sessionId,
          terminalHostPid: hostWindow && Number.isInteger(hostWindow.pid) ? hostWindow.pid : null,
          terminalWindowHandle: hostWindow && Number.isInteger(hostWindow.handle) ? hostWindow.handle : null,
          serverHost,
          serverPort,
          cartridgeId: options.cartridgeId,
          memoryPath: memory?.path || null,
        },
      };
  } finally {
    if (Number.isInteger(serverPort) && serverPort > 0) {
      pendingOpencodePorts.delete(serverPort);
    }
  }
}

async function up(options) {
  const config = ensureConfig(options.configPath);
  const dashboardPort = Number.isInteger(options.dashboardPort) ? options.dashboardPort : (config.dashboardPort || 5189);
  const daemonIntervalMs = Number.isInteger(options.daemonIntervalMs) ? options.daemonIntervalMs : (config.daemonIntervalMs || 5000);

  let dashboardPid = null;
  const dashboardStatus = options.noDashboard ? 200 : await httpGetStatus(dashboardPort, '/api/dashboard-state');
  if (!options.noDashboard && dashboardStatus !== 200) {
    dashboardPid = spawnNodeDetached(DASHBOARD_SCRIPT, ['--port', String(dashboardPort), '--project', getActiveProjectWorkspace().projectRoot], getActiveProjectWorkspace().projectRoot);
  }

  let daemonPid = null;
  const daemonStatus = runDaemonStatus(options);
  if (!daemonStatus || !daemonStatus.daemonStatus || daemonStatus.daemonStatus.running !== true) {
    const projectRoot = getActiveProjectWorkspace().projectRoot;
    const args = ['run', '--interval-ms', String(daemonIntervalMs), '--workspace', projectRoot];
    if (options.tasksPath) args.push('--tasks', options.tasksPath);
    if (options.registryPath) args.push('--registry', options.registryPath);
    if (options.dbPath) args.push('--db', options.dbPath);
    if (options.runsPath) args.push('--runs', options.runsPath);
    daemonPid = spawnNodeDetached(DAEMON_SCRIPT, args, projectRoot);
  }

  return {
    message: 'Daemon fleet is up.',
    dashboardUrl: `http://127.0.0.1:${dashboardPort}/`,
    dashboardStarted: Boolean(dashboardPid),
    dashboardPid,
    daemonStarted: Boolean(daemonPid),
    daemonPid,
    registeredAgents: [],
    skippedDisabled: (config.agents || []).filter((agent) => agent.disabled).map((agent) => agent.name),
  };
}

function down(options) {
  const daemonStatus = runDaemonStatus(options);
  const liveRuns = daemonStatus && Array.isArray(daemonStatus.liveRuns)
    ? daemonStatus.liveRuns
    : [];

  const stoppedWorkers = [];
  for (const run of liveRuns) {
    if (killPid(run.workerPid)) {
      stoppedWorkers.push({
        runId: run.runId,
        agentName: run.agentName,
        taskId: run.taskId,
        pid: run.workerPid,
      });
    }
  }

  let daemonStopped = false;
  let daemonPid = null;
  if (daemonStatus && daemonStatus.daemonStatus && Number.isInteger(daemonStatus.daemonStatus.pid)) {
    daemonPid = daemonStatus.daemonStatus.pid;
    daemonStopped = killPid(daemonPid);
  }

  setDaemonStopped(options, 'Stopped by Stop Fleet command.');
  runtimeReconcile.reconcileCoordination({
    tasksPath: options.tasksPath || null,
    registryPath: options.registryPath || null,
    dbPath: options.dbPath || null,
    runsPath: options.runsPath || null,
  });
  clearDaemonSessions(options);

  return {
    message: 'Fleet stopped.',
    daemonStopped,
    daemonPid,
    stoppedWorkers,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let result;
  if (options.command === 'init') {
    result = { message: 'Fleet config initialized.', config: ensureConfig(options.configPath) };
  } else if (options.command === 'add') {
    result = addAgent(options);
  } else if (options.command === 'remove') {
    if (!options.name) throw new Error('--name is required for remove.');
    result = removeAgent(options);
  } else if (options.command === 'list') {
    result = listConfig(options);
  } else if (options.command === 'register') {
    result = registerFleet(options);
  } else if (options.command === 'launch') {
    if (!options.name) throw new Error('--name is required for launch.');
    result = await launchPreset(options);
  } else if (options.command === 'up') {
    result = await up(options);
  } else if (options.command === 'down') {
    result = down(options);
  } else {
    throw new Error(`Unknown command: ${options.command}`);
  }

  if (options.json || typeof result !== 'string') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  get DEFAULT_CONFIG_PATH() {
    return defaultConfigPath();
  },
  defaultConfigPath,
  defaultConfig,
  parseArgs,
  readConfig,
  writeConfig,
  ensureConfig,
  loadConfig,
  buildLaunchIdentityPrompt,
  addAgent,
  updateAgent,
  removeAgent,
  listConfig,
  registerFleet,
  registerOne,
  launchPreset,
  up,
  down,
  killPid,
  requestKillPid,
  main,
};
