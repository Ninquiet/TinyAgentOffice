import type { DashboardEvent, DashboardPayload, DashboardThemesResponse, TelemetryPayload } from './types';

export async function postJson<T>(url: string, payload: unknown = {}): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const rawText = await response.text();
  const body = rawText ? JSON.parse(rawText) : {};
  if (!response.ok) {
    // The status has to survive. Callers that decide whether to retry cannot
    // tell a 409 -- which will never succeed -- from a 503 -- which will, once
    // the server is back -- from a message string alone.
    const error = new Error(body.error || body.reason || 'Request failed.') as Error & {
      status?: number;
      body?: unknown;
    };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body as T;
}

export async function saveBlueprint(blueprint: unknown) {
  return postJson<{ saved: boolean; reason?: string; blueprint?: unknown }>(
    '/api/blueprints/save',
    { blueprint },
  );
}

export async function deleteBlueprint(id: string) {
  return postJson<{
    deleted: boolean;
    reason?: string;
    unlinked?: number;
    unreachable?: Array<{ projectName: string; reason: string }>;
    blockedBy?: { projectName?: string; agentName?: string | null; reason?: string };
  }>('/api/blueprints/delete', { id });
}

export async function reorderBlueprints(order: Array<{ id: string; trayIndex: number }>) {
  return postJson<{ reordered: number }>('/api/blueprints/reorder', { order });
}

export async function findBlueprintInstances(blueprintId: string) {
  return postJson<{
    instances: import('./types').BlueprintInstanceSummary[];
    unreachable: Array<{ projectName: string; reason: string }>;
  }>('/api/blueprints/instances', { blueprintId });
}

export async function applyBlueprintEdit(payload: {
  id: string;
  definition: unknown;
  trayIndex?: number;
  choice?: 'stop' | 'unlink';
}) {
  return postJson<{
    applied: boolean;
    reason?: string;
    running?: number;
    instances?: import('./types').BlueprintInstanceSummary[];
    blockedBy?: { projectName?: string; agentName?: string | null; reason?: string };
  }>('/api/blueprints/apply-edit', payload);
}

export async function saveCartridgePlacement(cartridge: unknown) {
  return postJson<{ saved: boolean; reason?: string }>('/api/cartridges/save', { cartridge });
}

export async function removeCartridgePlacement(id: string) {
  return postJson<{ removed: number }>('/api/cartridges/remove', { id });
}

export async function importLegacyCartridges(cartridges: unknown[], force = false) {
  return postJson<{ imported: number; reason?: string }>('/api/cartridges/import-legacy', {
    cartridges,
    force,
  });
}

export async function getDashboardSnapshot(): Promise<DashboardPayload> {
  const response = await fetch('/api/dashboard-state', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load dashboard state.');
  return response.json();
}

export async function getTelemetry(): Promise<TelemetryPayload> {
  const response = await fetch('/api/telemetry', { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || 'Could not load telemetry.');
  }
  return body as TelemetryPayload;
}

export async function resetTelemetry(): Promise<TelemetryPayload> {
  return postJson<TelemetryPayload>('/api/telemetry/reset', {});
}

export interface RecentProject {
  root: string;
  name: string;
  openedAt?: string;
}

export interface ProjectsResponse {
  currentProject?: {
    root: string;
    officeRoot: string;
    initialized: boolean;
  };
  recentProjects: RecentProject[];
}

export async function getProjects(): Promise<ProjectsResponse> {
  const response = await fetch('/api/projects', { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || 'Could not load projects.');
  }
  return body as ProjectsResponse;
}

export async function openProject(projectRoot: string): Promise<{ message?: string; project: { root: string; officeRoot: string }; recentProjects: RecentProject[] }> {
  return postJson('/api/projects/open', { projectRoot });
}

export async function getDashboardThemes(): Promise<DashboardThemesResponse> {
  const response = await fetch('/api/themes', { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || 'Could not load dashboard themes.');
  }
  return body as DashboardThemesResponse;
}

export interface OpencodeModelsResponse {
  models: string[];
  loadedAt: string | null;
  lastError: string | null;
  cached: boolean;
}

export async function getOpencodeModels(forceRefresh = false): Promise<OpencodeModelsResponse> {
  if (forceRefresh) {
    return postJson<OpencodeModelsResponse>('/api/opencode/models/refresh');
  }
  const response = await fetch('/api/opencode/models', { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || 'Could not load OpenCode models.');
  }
  return body as OpencodeModelsResponse;
}

export interface AgentAdapterSummary {
  id: string;
  displayName: string;
  status: 'full' | 'partial';
  capabilities: Record<string, boolean>;
  limitations: string[];
}

export async function getAgentAdapters(): Promise<{ adapters: AgentAdapterSummary[] }> {
  const response = await fetch('/api/adapters', { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || 'Could not load agent adapters.');
  }
  return body as { adapters: AgentAdapterSummary[] };
}

export async function addFleetPreset(payload: {
  name: string;
  role: string;
  model: string;
  cli?: string;
  startupInstructions?: string;
  workspace?: string;
}) {
  return postJson<{ message?: string; config?: unknown }>('/api/fleet/add', {
    cli: payload.cli || 'opencode',
    role: payload.role,
    name: payload.name,
    model: payload.model,
    startupInstructions: payload.startupInstructions,
    workspace: payload.workspace,
  });
}

export async function deleteFleetPreset(name: string) {
  return postJson<{ message?: string }>('/api/fleet/delete', { name });
}

export async function launchFleetPreset(name: string, cartridgeId: string) {
  return postJson<{
    message?: string;
    launched?: {
      name: string;
      role: string;
      sessionId: string;
      pid?: number;
      terminalWindowHandle?: number;
      serverHost?: string | null;
      serverPort?: number | null;
    };
  }>('/api/fleet/launch', { name, cartridgeId });
}

export async function cleanCartridgeMemory(cartridgeId: string) {
  return postJson<{ message?: string; memoryPath?: string; archivedPath?: string | null }>(
    '/api/cartridges/memory/clean',
    { cartridgeId },
  );
}

export async function dismissSecretaryMessage(id: string) {
  return postJson<{ message?: string }>('/api/secretary/messages/dismiss', { id });
}

export async function closeAgentSession(sessionId: string) {
  return postJson<{ message?: string }>('/api/agents/remove', { sessionId });
}

export async function closeLiveAgentSessions() {
  return postJson<{ message?: string; removed?: unknown[] }>('/api/agents/close-live', {});
}

export async function focusAgentSession(sessionId: string) {
  return postJson<{ message?: string }>('/api/agents/focus', { sessionId });
}

export async function messageAgentSession(sessionId: string, text: string) {
  return postJson<{ message?: string }>('/api/agents/message', { sessionId, text });
}

export async function enqueueProjectManagerTaskRequest(payload: {
  text: string;
  attachments: Array<{ token: string; path: string }>;
}) {
  return postJson<{ message?: string; request?: unknown; queue?: unknown }>('/api/project-manager/task-requests', payload);
}

export async function attachAgentImage(payload: {
  sessionId: string;
  name: string;
  mimeType: string;
  data: string;
}) {
  return postJson<{
    message?: string;
    attachment: {
      path: string;
      name: string;
      mimeType: string;
      size: number;
    };
  }>('/api/agents/attachments', payload);
}

export async function runNextForSession(sessionId: string) {
  return postJson<{ message?: string }>('/api/dispatch/run-next', { sessionId });
}

export async function answerAgentAttention(sessionId: string, answer: string) {
  return postJson<{ message?: string }>('/api/agents/attention/respond', { sessionId, answer });
}

export async function setFleetAutomaticMode(enabled: boolean) {
  return postJson<{ message?: string }>(enabled ? '/api/fleet/up' : '/api/fleet/down', {});
}

export async function openOpencodeUpdateTerminal() {
  return postJson<{ message?: string; pid?: number | null }>('/api/maintenance/opencode-update/fix', {});
}

export function connectDashboardSocket(
  onEvent: (event: DashboardEvent) => void,
  onStatus: (status: string) => void,
): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;

  const connect = () => {
    if (closed) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}/ws/dashboard`);
    onStatus('connecting');

    socket.addEventListener('open', () => onStatus('connected'));
    socket.addEventListener('message', (message) => {
      try {
        onEvent(JSON.parse(String(message.data)) as DashboardEvent);
      } catch (error) {
        onStatus(error instanceof Error ? error.message : 'Invalid dashboard event.');
      }
    });
    socket.addEventListener('close', () => {
      onStatus('disconnected');
      if (!closed) {
        reconnectTimer = window.setTimeout(connect, 1200);
      }
    });
    socket.addEventListener('error', () => onStatus('socket error'));
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    if (socket) socket.close();
  };
}
