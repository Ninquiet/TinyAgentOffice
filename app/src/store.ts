import { create } from 'zustand';
import type {
  AgentSession,
  DashboardEvent,
  DashboardPayload,
  DashboardSummary,
  FleetPreset,
  QueueTask,
  RoleAvailability,
} from './types';

interface DashboardStore {
  generatedAt: string | null;
  socketStatus: string;
  lastMessage: string;
  summary: DashboardSummary;
  roles: RoleAvailability[];
  agentsById: Record<string, AgentSession>;
  agentOrder: string[];
  agentKeyByPresetKey: Record<string, string>;
  alerts: string[];
  activeTaskQueue: QueueTask[];
  planningQueue: QueueTask[];
  availableWork: QueueTask[];
  helpQueue: QueueTask[];
  userReviewQueue: QueueTask[];
  seniorReviewQueue: QueueTask[];
  nextTodo: QueueTask[];
  fleetPresets: FleetPreset[];
  daemonRunning: boolean;
  applySnapshot: (payload: DashboardPayload) => void;
  applyEvent: (event: DashboardEvent) => void;
  setSocketStatus: (status: string) => void;
  setLastMessage: (message: string) => void;
}

const emptySummary: DashboardSummary = {
  activeAgents: 0,
  openTasks: 0,
  blockedAgents: 0,
  reviewNeeded: 0,
};

export function presetKey(name: string, role: string) {
  return `${name}:${role}`;
}

function agentKey(agent: AgentSession) {
  return agent.sessionId || `${agent.agentName}:${agent.roleAcronym || agent.role}`;
}

function normalizeAgents(agents: AgentSession[] = []) {
  const agentsById: Record<string, AgentSession> = {};
  const agentOrder: string[] = [];
  const agentKeyByPresetKey: Record<string, string> = {};
  for (const agent of agents) {
    const key = agentKey(agent);
    agentsById[key] = agent;
    agentOrder.push(key);
    agentKeyByPresetKey[presetKey(agent.agentName, agent.roleAcronym || agent.role)] = key;
  }
  return { agentsById, agentOrder, agentKeyByPresetKey };
}

function rebuildPresetIndex(agentsById: Record<string, AgentSession>) {
  const agentKeyByPresetKey: Record<string, string> = {};
  for (const [key, agent] of Object.entries(agentsById)) {
    agentKeyByPresetKey[presetKey(agent.agentName, agent.roleAcronym || agent.role)] = key;
  }
  return agentKeyByPresetKey;
}

function applyQueueChange(queue: string, rows: QueueTask[]) {
  if (queue === 'activeTaskQueue') return { activeTaskQueue: rows };
  if (queue === 'planningQueue') return { planningQueue: rows };
  if (queue === 'availableWork') return { availableWork: rows };
  if (queue === 'helpQueue') return { helpQueue: rows };
  if (queue === 'pmReviewQueue') return { userReviewQueue: rows };
  if (queue === 'seniorReviewQueue') return { seniorReviewQueue: rows };
  if (queue === 'nextTodo') return { nextTodo: rows };
  return {};
}

export const useDashboardStore = create<DashboardStore>((set, get) => ({
  generatedAt: null,
  socketStatus: 'idle',
  lastMessage: '',
  summary: emptySummary,
  roles: [],
  agentsById: {},
  agentOrder: [],
  agentKeyByPresetKey: {},
  alerts: [],
  activeTaskQueue: [],
  planningQueue: [],
  availableWork: [],
  helpQueue: [],
  userReviewQueue: [],
  seniorReviewQueue: [],
  nextTodo: [],
  fleetPresets: [],
  daemonRunning: false,
  applySnapshot: (payload) => {
    const normalized = normalizeAgents(payload.agents || []);
    set({
      generatedAt: payload.generatedAt || new Date().toISOString(),
      summary: payload.summary || emptySummary,
      roles: payload.roles || [],
      ...normalized,
      alerts: payload.alerts || [],
      activeTaskQueue: payload.activeTaskQueue || [],
      planningQueue: payload.planningQueue || [],
      availableWork: payload.availableWork || [],
      helpQueue: payload.helpQueue || [],
      userReviewQueue: payload.pmReviewQueue || [],
      seniorReviewQueue: payload.seniorReviewQueue || [],
      nextTodo: payload.nextTodo || [],
      fleetPresets: payload.fleetConfig?.agents || [],
      daemonRunning: Boolean(payload.daemonStatus?.running),
    });
  },
  applyEvent: (event) => {
    if (event.type === 'dashboard.snapshot') {
      get().applySnapshot(event.payload);
      return;
    }
    if (event.type === 'agents.changed') {
      set(normalizeAgents(event.payload || []));
    } else if (event.type === 'agent.upserted') {
      set((state) => {
        const agentsById = { ...state.agentsById, [event.payload.key]: event.payload.agent };
        const agentOrder = state.agentOrder.includes(event.payload.key)
          ? state.agentOrder
          : [...state.agentOrder, event.payload.key];
        return {
          agentsById,
          agentOrder,
          agentKeyByPresetKey: rebuildPresetIndex(agentsById),
        };
      });
    } else if (event.type === 'agent.removed') {
      set((state) => {
        const agentsById = { ...state.agentsById };
        delete agentsById[event.payload.key];
        return {
          agentsById,
          agentOrder: state.agentOrder.filter((key) => key !== event.payload.key),
          agentKeyByPresetKey: rebuildPresetIndex(agentsById),
        };
      });
    } else if (event.type === 'agents.order.changed') {
      set({ agentOrder: event.payload || [] });
    } else if (event.type === 'roles.changed') {
      set({ roles: event.payload || [] });
    } else if (event.type === 'queues.changed') {
      set({
        activeTaskQueue: event.payload.activeTaskQueue || get().activeTaskQueue,
        planningQueue: event.payload.planningQueue || get().planningQueue,
        availableWork: event.payload.availableWork || get().availableWork,
        helpQueue: event.payload.helpQueue || get().helpQueue,
        userReviewQueue: event.payload.pmReviewQueue || get().userReviewQueue,
        seniorReviewQueue: event.payload.seniorReviewQueue || get().seniorReviewQueue,
        nextTodo: event.payload.nextTodo || get().nextTodo,
      });
    } else if (event.type === 'queue.changed') {
      set(applyQueueChange(event.payload.queue, event.payload.rows));
    } else if (event.type === 'fleet.changed') {
      set({ fleetPresets: event.payload?.agents || [] });
    } else if (event.type === 'daemon.changed') {
      set({ daemonRunning: Boolean(event.payload?.running) });
    } else if (event.type === 'alerts.changed') {
      set({ alerts: event.payload || [] });
    } else if (event.type === 'summary.changed') {
      set({ summary: event.payload || emptySummary });
    } else if (event.type === 'dashboard.error') {
      set({ lastMessage: event.payload.error });
    }
  },
  setSocketStatus: (socketStatus) => set({ socketStatus }),
  setLastMessage: (lastMessage) => set({ lastMessage }),
}));
