'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');

function hashValue(value) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(value || null))
    .digest('hex');
}

function sendJson(socket, event) {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(event));
}

function queuePayload(payload) {
  return {
    activeTaskQueue: payload.activeTaskQueue || [],
    planningQueue: payload.planningQueue || [],
    availableWork: payload.availableWork || [],
    helpQueue: payload.helpQueue || [],
    followUpWaitQueue: payload.followUpWaitQueue || [],
    supersededReviewQueue: payload.supersededReviewQueue || [],
    pmReviewQueue: payload.pmReviewQueue || [],
    seniorReviewQueue: payload.seniorReviewQueue || [],
    nextTodo: payload.nextTodo || [],
  };
}

function agentKey(agent) {
  return agent.sessionId || `${agent.agentName}:${agent.roleAcronym || agent.role}`;
}

function indexAgents(agents) {
  const byKey = {};
  const order = [];
  for (const agent of agents || []) {
    const key = agentKey(agent);
    byKey[key] = agent;
    order.push(key);
  }
  return { byKey, order };
}

// Every section listed here is diffed and broadcast; anything else in the
// payload reaches a client only on its initial snapshot. A section added to the
// payload but not to this list looks like it works on load and then never
// updates again -- so when you add one, add it here in the same change.
function splitPayload(payload) {
  return {
    summary: payload.summary || {},
    roles: payload.roles || [],
    agents: indexAgents(payload.agents || []),
    alerts: payload.alerts || [],
    queues: queuePayload(payload),
    fleet: payload.fleetConfig || {},
    daemon: payload.daemonStatus || {},
    maintenance: payload.maintenanceNotifications || [],
    secretary: payload.secretaryInbox || {},
    cartridges: payload.cartridges || [],
    blueprints: payload.blueprints || [],
  };
}

class DashboardWebSocketHub {
  constructor(options) {
    this.buildPayload = options.buildPayload;
    this.intervalMs = options.intervalMs || 1000;
    this.wss = null;
    this.timer = null;
    this.lastHashes = {};
    this.lastPayload = null;
  }

  attach(server) {
    this.wss = new WebSocketServer({ server, path: '/ws/dashboard' });
    this.wss.on('connection', (socket) => {
      this.sendSnapshot(socket).catch((error) => {
        sendJson(socket, { type: 'dashboard.error', payload: { error: error.message } });
      });
    });
    this.start();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.broadcastChanges().catch((error) => {
        this.broadcast({ type: 'dashboard.error', payload: { error: error.message } });
      });
    }, this.intervalMs);
  }

  close() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  async sendSnapshot(socket) {
    const payload = await this.buildPayload();
    this.lastPayload = payload;
    this.lastHashes = this.computeHashes(payload);
    sendJson(socket, { type: 'dashboard.snapshot', payload });
  }

  computeHashes(payload) {
    const parts = splitPayload(payload);
    return Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, hashValue(value)]));
  }

  broadcast(event) {
    if (!this.wss) return;
    for (const socket of this.wss.clients) {
      sendJson(socket, event);
    }
  }

  async broadcastSnapshot() {
    const payload = await this.buildPayload();
    this.lastPayload = payload;
    this.lastHashes = this.computeHashes(payload);
    this.broadcast({ type: 'dashboard.snapshot', payload });
  }

  async broadcastChanges() {
    if (!this.wss || this.wss.clients.size === 0) return;
    const payload = await this.buildPayload();
    const hashes = this.computeHashes(payload);
    const parts = splitPayload(payload);
    const previousParts = this.lastPayload ? splitPayload(this.lastPayload) : null;

    if (!this.lastPayload) {
      this.lastPayload = payload;
      this.lastHashes = hashes;
      this.broadcast({ type: 'dashboard.snapshot', payload });
      return;
    }

    if (hashes.summary !== this.lastHashes.summary) {
      this.broadcast({ type: 'summary.changed', payload: parts.summary });
    }
    if (hashes.roles !== this.lastHashes.roles) {
      this.broadcast({ type: 'roles.changed', payload: parts.roles });
    }
    if (hashes.agents !== this.lastHashes.agents) {
      this.broadcastAgentDiff(previousParts.agents, parts.agents);
    }
    if (hashes.alerts !== this.lastHashes.alerts) {
      this.broadcast({ type: 'alerts.changed', payload: parts.alerts });
    }
    if (hashes.queues !== this.lastHashes.queues) {
      this.broadcastQueueDiff(previousParts.queues, parts.queues);
    }
    if (hashes.fleet !== this.lastHashes.fleet) {
      this.broadcast({ type: 'fleet.changed', payload: parts.fleet });
    }
    if (hashes.daemon !== this.lastHashes.daemon) {
      this.broadcast({ type: 'daemon.changed', payload: parts.daemon });
    }
    if (hashes.maintenance !== this.lastHashes.maintenance) {
      this.broadcast({ type: 'maintenance.changed', payload: parts.maintenance });
    }
    if (hashes.secretary !== this.lastHashes.secretary) {
      this.broadcast({ type: 'secretary.changed', payload: parts.secretary });
    }
    if (hashes.cartridges !== this.lastHashes.cartridges) {
      this.broadcast({ type: 'cartridges.changed', payload: parts.cartridges });
    }
    if (hashes.blueprints !== this.lastHashes.blueprints) {
      this.broadcast({ type: 'blueprints.changed', payload: parts.blueprints });
    }

    this.lastPayload = payload;
    this.lastHashes = hashes;
  }

  broadcastAgentDiff(previousAgents, nextAgents) {
    const previousByKey = previousAgents.byKey || {};
    const nextByKey = nextAgents.byKey || {};
    const previousOrder = previousAgents.order || [];
    const nextOrder = nextAgents.order || [];

    for (const key of previousOrder) {
      if (!Object.prototype.hasOwnProperty.call(nextByKey, key)) {
        this.broadcast({ type: 'agent.removed', payload: { key } });
      }
    }

    for (const key of nextOrder) {
      const nextAgent = nextByKey[key];
      if (hashValue(previousByKey[key]) !== hashValue(nextAgent)) {
        this.broadcast({ type: 'agent.upserted', payload: { key, agent: nextAgent } });
      }
    }

    if (hashValue(previousOrder) !== hashValue(nextOrder)) {
      this.broadcast({ type: 'agents.order.changed', payload: nextOrder });
    }
  }

  broadcastQueueDiff(previousQueues, nextQueues) {
    for (const [queue, rows] of Object.entries(nextQueues)) {
      if (hashValue(previousQueues[queue]) !== hashValue(rows)) {
        this.broadcast({ type: 'queue.changed', payload: { queue, rows } });
      }
    }
  }
}

module.exports = {
  DashboardWebSocketHub,
};
