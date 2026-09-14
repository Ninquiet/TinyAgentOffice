'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('../core/agent-memory');
const runtimeStore = require('../runtime/runtime-store');
const { executeCommand } = require('../cli/main');
const { parseArgs } = require('../cli/args');
const daemonFleet = require('../daemon/daemon-fleet');
const { ProjectWorkspace } = require('../core/project-workspace');

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-agent-memory-'));

try {
  const first = memory.ensureAgentMemory({ projectRoot, cartridgeId: 'cart-alpha', agentName: 'Iron Runner SS', role: 'Semi Senior' });
  assert.equal(first.created, true);
  assert.equal(path.dirname(first.path), path.join(projectRoot, '.tiny-agent-office', 'agent-memory'));
  assert.match(fs.readFileSync(first.path, 'utf8'), /Cartridge ID: cart-alpha/);

  memory.appendTaskMemory({
    projectRoot,
    cartridgeId: 'cart-alpha',
    agentName: 'Iron Runner SS',
    role: 'Semi Senior',
    taskId: 'TASK-101',
    summary: 'Added persistent cartridge memory.',
    highlights: ['Memory follows the cartridge, not the terminal session.'],
  });
  const recorded = memory.readAgentMemory({ projectRoot, cartridgeId: 'cart-alpha' }).content;
  assert.match(recorded, /TASK-101/);
  assert(
    recorded.indexOf('TASK-101') > recorded.indexOf('## Recent Task Outcomes')
      && recorded.indexOf('TASK-101') < recorded.indexOf('## Pending Follow-ups'),
    'task outcomes must be written inside Recent Task Outcomes',
  );

  const second = memory.ensureAgentMemory({ projectRoot, cartridgeId: 'cart-alpha', agentName: 'Renamed Runner SP', role: 'Senior Pro' });
  assert.equal(second.created, false);
  const renamedMemory = fs.readFileSync(second.path, 'utf8');
  assert.match(renamedMemory, /^# Agent Memory: Renamed Runner SP$/m);
  assert.match(renamedMemory, /^- Role: Senior Pro$/m);
  assert.match(renamedMemory, /Added persistent cartridge memory/);

  const other = memory.ensureAgentMemory({ projectRoot, cartridgeId: 'cart-beta', agentName: 'Iron Runner SS', role: 'Semi Senior' });
  assert.notEqual(other.path, first.path);
  assert.doesNotMatch(fs.readFileSync(other.path, 'utf8'), /TASK-101/);

  const cleaned = memory.cleanAgentMemory({ projectRoot, cartridgeId: 'cart-alpha', agentName: 'Renamed Runner SP', role: 'Senior Pro' });
  assert.equal(Boolean(cleaned.archivedPath && fs.existsSync(cleaned.archivedPath)), true);
  assert.match(fs.readFileSync(cleaned.archivedPath, 'utf8'), /TASK-101/);
  assert.doesNotMatch(fs.readFileSync(cleaned.path, 'utf8'), /TASK-101/);

  runtimeStore.ensureInitialized({ projectRoot });
  runtimeStore.mutateCoordination({ projectRoot }, (state) => {
    state.tasksStore.tasks = [{
      id: 'TASK-MEMORY', title: 'Persist completion memory', type: 'subtask', status: 'IN_PROGRESS',
      recommendedRole: 'Semi Senior', prerequisites: [], notes: [],
      claim: { agentName: 'Memory Runner SS', role: 'Semi Senior' },
    }];
    state.registry.agents = [{
      sessionId: 'memory-session', agentName: 'Memory Runner SS', role: 'Semi Senior', roleAcronym: 'SS',
      cartridgeId: 'cart-gamma', status: 'working', activeTaskId: 'TASK-MEMORY',
    }];
  });
  const completion = executeCommand(parseArgs([
    'complete', '--project', projectRoot, '--role', 'SS', '--name', 'Memory Runner SS',
    '--session-id', 'memory-session', '--task', 'TASK-MEMORY', '--summary', 'Remembered from task completion.',
  ]));
  assert.equal(completion.memoryUpdated, true);
  assert.match(memory.readAgentMemory({ projectRoot, cartridgeId: 'cart-gamma' }).content, /Remembered from task completion/);

  const identityPrompt = daemonFleet.buildLaunchIdentityPrompt({
    agentName: 'Memory Runner SS', role: 'Semi Senior', sessionId: 'memory-session',
    cartridgeId: 'cart-gamma', memoryPath: path.join(projectRoot, '.tiny-agent-office', 'agent-memory', 'cart-gamma.md'),
  }, { workspace: projectRoot });
  assert.match(identityPrompt, /Cartridge ID: cart-gamma/);
  assert.match(identityPrompt, /Agent Memory Path:/);
  assert.match(identityPrompt, /Read it .* before task work/);

  assert.throws(
    () => memory.ensureAgentMemory({ projectRoot, cartridgeId: '../escape', agentName: 'Bad', role: 'Junior' }),
    /cartridge id/i,
  );

  assert.throws(
    () => memory.assertMemoryCanBeCleaned({
      cartridge: { id: 'cart-live', activated: false, sessionId: null },
      agents: [{
        sessionId: 'live-session',
        agentName: 'Live Runner SS',
        cartridgeId: 'cart-live',
        terminalPid: 4242,
      }],
      isPidAlive: (pid) => pid === 4242,
    }),
    /Live Runner SS.*still running/i,
    'the live registry session must block cleaning even when the cartridge row is stale',
  );

  assert.doesNotThrow(() => memory.assertMemoryCanBeCleaned({
    cartridge: { id: 'cart-stopped', activated: false, sessionId: null },
    agents: [{
      sessionId: 'dead-session',
      agentName: 'Stopped Runner SS',
      cartridgeId: 'cart-stopped',
      terminalPid: 4243,
    }],
    isPidAlive: () => false,
  }));

  const legacyProject = path.join(projectRoot, 'legacy-office');
  const legacyOffice = path.join(legacyProject, '.tiny-agent-office');
  fs.mkdirSync(legacyOffice, { recursive: true });
  fs.writeFileSync(path.join(legacyOffice, 'AGENTS.md'), '# Legacy agent rules\n', 'utf8');
  new ProjectWorkspace(legacyProject).initialize();
  const upgradedRules = fs.readFileSync(path.join(legacyOffice, 'AGENTS.md'), 'utf8');
  assert.match(upgradedRules, /^## Project-Local Agent Memory$/m);
  assert.match(upgradedRules, /agent-memory\/<cartridge-id>\.md/);
  new ProjectWorkspace(legacyProject).initialize();
  assert.equal(
    fs.readFileSync(path.join(legacyOffice, 'AGENTS.md'), 'utf8').match(/^## Project-Local Agent Memory$/gm)?.length,
    1,
    'workspace initialization must not duplicate the managed memory instructions',
  );

  const optionsSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'app', 'src', 'components', 'bot-cartridge', 'parts', 'CartridgeOptions.tsx'),
    'utf8',
  );
  const primaryMenuStart = optionsSource.indexOf('      ) : (\n        <>');
  const primaryMenuEnd = optionsSource.indexOf('        </>', primaryMenuStart);
  assert(primaryMenuStart >= 0 && primaryMenuEnd > primaryMenuStart, 'could not locate the primary cartridge options menu');
  assert.match(
    optionsSource.slice(primaryMenuStart, primaryMenuEnd),
    /Clean local memory/,
    'clean memory must be visible in the primary cartridge options menu, not hidden behind Edit',
  );

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'server.js'), 'utf8');
  const cleanRouteStart = serverSource.indexOf("req.url === '/api/cartridges/memory/clean'");
  const cleanRouteEnd = serverSource.indexOf("req.url === '/api/fleet/add'", cleanRouteStart);
  assert(cleanRouteStart >= 0 && cleanRouteEnd > cleanRouteStart, 'could not locate the clean-memory HTTP route');
  const cleanRoute = serverSource.slice(cleanRouteStart, cleanRouteEnd);
  assert.match(cleanRoute, /assertMemoryCanBeCleaned/);
  assert.doesNotMatch(cleanRoute, /payload\.agentName|payload\.role/,
    'memory headers must come from the authoritative cartridge definition');
  console.log('agent memory validation passed');
} finally {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
