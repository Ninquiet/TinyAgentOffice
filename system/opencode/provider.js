'use strict';

// The single place that knows what "an OpenCode agent" is.
//
// OpenCode is the committed runtime. Everything that used to ask
// `String(agent.adapterType || '').toLowerCase() === 'opencode'` in nine
// different files should ask here instead, so that the day a second runtime
// appears there is one module to change rather than nine predicates to find.

const ADAPTER_TYPE = 'opencode';

const CAPABILITIES = {
  liveSession: true,
  sendPrompt: true,
  streamEvents: true,
  focusWindow: true,
  closeSession: true,
  imageInput: true,
  modelDiscovery: true,
};

function normalizeAdapterType(value) {
  return String(value || '').trim().toLowerCase();
}

function isOpencodeAgent(agent) {
  return Boolean(agent) && normalizeAdapterType(agent.adapterType) === ADAPTER_TYPE;
}

// An OpenCode agent whose terminal is alive and whose local server port is
// known, i.e. one we can actually talk to over HTTP or subscribe to over SSE.
function hasReachableServer(agent) {
  if (!isOpencodeAgent(agent)) return false;
  if (!agent.hasLiveTerminal) return false;
  return Number.isInteger(agent.serverPort) && agent.serverPort > 0;
}

function serverEndpoint(agent) {
  if (!hasReachableServer(agent)) return null;
  return {
    hostname: agent.serverHost || '127.0.0.1',
    port: agent.serverPort,
  };
}

function requireOpencodeAgent(agent) {
  if (isOpencodeAgent(agent)) return agent;
  const name = (agent && agent.agentName) || 'agent';
  const type = (agent && agent.adapterType) || 'unknown';
  throw new Error(`${name} runs on "${type}", and OpenCode is the only supported runtime.`);
}

// Replaces the old adapter registry, which advertised capability matrices for
// three runtimes nobody had implemented. One runtime, described once.
function describe() {
  return {
    id: ADAPTER_TYPE,
    displayName: 'OpenCode',
    status: 'full',
    capabilities: { ...CAPABILITIES },
    limitations: [],
  };
}

module.exports = {
  ADAPTER_TYPE,
  isOpencodeAgent,
  hasReachableServer,
  serverEndpoint,
  requireOpencodeAgent,
  describe,
};
