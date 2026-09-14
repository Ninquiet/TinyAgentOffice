'use strict';

const {
  ROLE_ACRONYMS,
  requireRole,
  createEmptyRegistry,
  readRuntimeState,
  mutateRuntime,
  slugify,
  utcNow,
} = require('./common');

const VALID_AGENT_STATUSES = new Set([
  'available',
  'working',
  'attention',
  'blocked',
  'waiting',
  'done',
  'inactive',
]);

function findAgent(registry, options) {
  if (options.sessionId) {
    return (registry.agents || []).find((agent) => agent.sessionId === options.sessionId);
  }
  return (registry.agents || []).find((agent) => (
    agent.agentName === options.name && agent.role === requireRole(options.role)
  ));
}

function upsertAgentInRegistry(registry, options, mutate) {
  if (!Array.isArray(registry.agents)) registry.agents = [];
  const role = requireRole(options.role);
  let agent = findAgent(registry, options);
  if (!agent) {
    agent = {
      sessionId: options.sessionId || `${slugify(options.name)}-${ROLE_ACRONYMS[role].toLowerCase()}-${Date.now()}`,
      agentName: options.name,
      role,
      roleAcronym: ROLE_ACRONYMS[role],
      status: 'available',
      activeTaskId: null,
      note: '',
      announcedAt: utcNow(),
      lastSeenAt: utcNow(),
      executionMode: 'manual',
      adapterType: null,
      launchCommand: null,
      launchArgs: [],
      workspacePath: null,
      cartridgeId: null,
      memoryPath: null,
      disabled: false,
    };
    registry.agents.push(agent);
  }

  mutate(agent, registry);
  agent.role = role;
  agent.roleAcronym = ROLE_ACRONYMS[role];
  agent.lastSeenAt = utcNow();
  registry.updatedAt = utcNow();
  return { registry, agent };
}

function applyAgentState(registry, kind, options, taskId) {
  if (!options.name || !options.role) return null;
  return upsertAgentInRegistry(registry, options, (agent) => {
    if (kind === 'claim' || kind === 'start') {
      agent.status = 'working';
      agent.activeTaskId = taskId || options.taskId || null;
      agent.note = options.note || '';
    } else if (kind === 'block') {
      agent.status = 'blocked';
      agent.activeTaskId = taskId || options.taskId || null;
      agent.note = options.reason || options.note || '';
    } else if (kind === 'attention') {
      agent.status = 'attention';
      agent.activeTaskId = taskId || options.taskId || agent.activeTaskId || null;
      agent.note = options.note || agent.note || '';
    } else if (kind === 'done') {
      agent.status = 'available';
      agent.activeTaskId = null;
      agent.note = 'Available for next task';
    } else if (kind === 'review') {
      agent.status = 'available';
      agent.activeTaskId = null;
      agent.note = 'Available for next task';
    } else if (kind === 'available') {
      agent.status = 'available';
      agent.activeTaskId = null;
      agent.note = options.note || '';
    }
  });
}

function anunciate(options) {
  if (!options.name) throw new Error('--name is required.');
  const role = requireRole(options.role);
  const status = options.status || 'available';
  if (!VALID_AGENT_STATUSES.has(status)) {
    throw new Error(`Invalid agent status "${status}".`);
  }

  const result = mutateRuntime(options, (state) => {
    const upserted = upsertAgentInRegistry(state.registry, { ...options, role }, (agent) => {
      agent.status = status;
      agent.activeTaskId = options.taskId || agent.activeTaskId || null;
      agent.note = options.note || agent.note || '';
      agent.executionMode = options.executionMode || agent.executionMode || 'manual';
      agent.adapterType = options.adapterType || agent.adapterType || null;
      agent.launchCommand = options.launchCommand || agent.launchCommand || null;
      agent.launchArgs = options.launchArgs.length > 0 ? [...options.launchArgs] : (agent.launchArgs || []);
      agent.workspacePath = options.workspacePath || agent.workspacePath || null;
      agent.cartridgeId = options.cartridgeId || agent.cartridgeId || null;
      agent.memoryPath = options.memoryPath || agent.memoryPath || null;
      agent.serverHost = options.serverHost || agent.serverHost || null;
      agent.serverPort = Number.isInteger(options.serverPort) ? options.serverPort : (Number.isInteger(agent.serverPort) ? agent.serverPort : null);
      agent.disabled = options.disabled ? true : Boolean(agent.disabled);
      if (!agent.announcedAt) agent.announcedAt = utcNow();
    });
    return {
      registryPath: state.paths.registryPath,
      agent: upserted.agent,
    };
  });

  return {
    message: `${result.agent.agentName} announced.`,
    registryPath: result.registryPath,
    agent: result.agent,
  };
}

function heartbeat(options) {
  if (!options.name) throw new Error('--name is required.');
  if (!options.role) throw new Error('--role is required.');

  const result = mutateRuntime(options, (state) => {
    const upserted = upsertAgentInRegistry(state.registry, options, () => {});
    return {
      registryPath: state.paths.registryPath,
      agent: upserted.agent,
    };
  });
  return {
    message: `${result.agent.agentName} heartbeat recorded.`,
    registryPath: result.registryPath,
    agent: result.agent,
  };
}

function clearRegistry(options) {
  return mutateRuntime(options, (state) => {
    state.registry = createEmptyRegistry();
    return {
      message: 'Registry cleared. Task data was not modified.',
      registryPath: state.paths.registryPath,
      agent: null,
    };
  });
}

function listRegistry(options) {
  const snapshot = readRuntimeState(options);
  const registry = snapshot.registry;
  const nowMs = Date.now();
  const staleMs = options.staleMinutes * 60 * 1000;

  const agents = (registry.agents || []).map((agent) => {
    const lastSeenMs = Date.parse(agent.lastSeenAt);
    return {
      ...agent,
      stale: Number.isFinite(lastSeenMs) ? nowMs - lastSeenMs > staleMs : true,
    };
  });

  return {
    registryPath: snapshot.paths.registryPath,
    schemaVersion: registry.schemaVersion,
    resetAt: registry.resetAt,
    updatedAt: registry.updatedAt,
    agents,
  };
}

module.exports = {
  VALID_AGENT_STATUSES,
  findAgent,
  upsertAgentInRegistry,
  applyAgentState,
  anunciate,
  heartbeat,
  clearRegistry,
  listRegistry,
};
