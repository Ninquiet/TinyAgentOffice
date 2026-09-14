'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dashboardServer = require('../dashboard/server');
const runtimeStore = require('../runtime/runtime-store');
const { configureProjectWorkspace } = require('../core/project-workspace');
const agentMemory = require('../core/agent-memory');

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-agent-memory-route-'));
let server = null;

async function post(port, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/api/cartridges/memory/clean`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  try {
    configureProjectWorkspace(projectRoot);
    const options = { projectRoot };
    runtimeStore.ensureInitialized(options);
    runtimeStore.saveProjectCartridge(options, {
      id: 'cart-route',
      templateId: null,
      definition: { name: 'Authoritative Runner SS', role: 'SS', model: 'test-model' },
      x: 20,
      y: 30,
      slotId: null,
      activated: false,
      sessionId: null,
    });
    agentMemory.appendTaskMemory({
      projectRoot,
      cartridgeId: 'cart-route',
      agentName: 'Authoritative Runner SS',
      role: 'Semi Senior',
      taskId: 'TASK-ROUTE',
      summary: 'Content that must survive a refused clean.',
    });
    runtimeStore.mutateCoordination(options, (state) => {
      state.registry.agents = [{
        sessionId: 'route-live-session',
        agentName: 'Authoritative Runner SS',
        role: 'Semi Senior',
        roleAcronym: 'SS',
        cartridgeId: 'cart-route',
        terminalPid: process.pid,
        status: 'working',
        activeTaskId: null,
      }];
    });

    server = dashboardServer.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;

    const refused = await post(port, {
      cartridgeId: 'cart-route',
      agentName: 'Spoofed Name PM',
      role: 'PM',
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Authoritative Runner SS.*still running/i);
    assert.match(
      agentMemory.readAgentMemory({ projectRoot, cartridgeId: 'cart-route' }).content,
      /Content that must survive a refused clean/,
    );

    runtimeStore.mutateCoordination(options, (state) => {
      state.registry.agents = [];
    });
    const cleaned = await post(port, {
      cartridgeId: 'cart-route',
      agentName: 'Spoofed Name PM',
      role: 'PM',
    });
    assert.equal(cleaned.status, 200);
    assert.equal(Boolean(cleaned.body.archivedPath && fs.existsSync(cleaned.body.archivedPath)), true);
    assert.match(fs.readFileSync(cleaned.body.archivedPath, 'utf8'), /Content that must survive a refused clean/);
    const fresh = fs.readFileSync(cleaned.body.memoryPath, 'utf8');
    assert.match(fresh, /Agent Memory: Authoritative Runner SS/);
    assert.match(fresh, /^- Role: Semi Senior$/m);
    assert.doesNotMatch(fresh, /Spoofed Name PM/);
    console.log('agent memory route validation passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    dashboardServer.disposeOpencodeRuntime();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
