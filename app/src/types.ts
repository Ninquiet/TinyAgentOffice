export type AgentStatus =
  | 'available'
  | 'working'
  | 'assigned'
  | 'stalled'
  | 'attention'
  | 'blocked'
  | 'waiting'
  | 'no-tasks'
  | 'unavailable';

export interface AgentSession {
  sessionId: string | null;
  agentName: string;
  role: string;
  roleAcronym?: string;
  status: AgentStatus;
  activeTaskId?: string | null;
  activeTaskStatus?: string | null;
  lastSeenAt?: string | null;
  lastActivityAt?: string | null;
  lastAgentResponseAt?: string | null;
  activityState?: 'working' | 'assigned' | 'stalled' | null;
  note?: string;
  operationalStatus?: 'ok' | 'error' | 'unknown' | null;
  operationalError?: string | null;
  presetModel?: string | null;
  sourceLabel?: string;
  modeLabel?: string;
  hasLiveTerminal?: boolean;
  pendingQuestions?: number;
  pendingPermissions?: number;
  attentionRequired?: boolean;
  attentionRequest?: {
    question?: string;
    options?: string[];
    taskId?: string | null;
  } | null;
  sessionConsole?: ConsoleState;
}

export interface ConsoleMessage {
  id?: string | null;
  role: string;
  preview: string;
  createdAt?: string | null;
  source?: string;
}

export interface ConsoleState {
  connected: boolean;
  currentSessionId: string | null;
  currentSessionTitle: string | null;
  todoCount: number;
  messages: ConsoleMessage[];
  lastEventAt?: string | null;
  error?: string | null;
  usingLiveEvents?: boolean;
}

export interface RoleAvailability {
  role: string;
  label: AgentStatus;
  detail: string;
  claimableTasks?: number;
}

export interface QueueTask {
  id: string;
  title: string;
  claimableRole?: string | null;
  recommendedRole?: string | null;
  priority?: string | null;
  status: string;
  reason?: string;
  source?: string | null;
  attentionType?: string | null;
  followUpTaskId?: string | null;
  createdByAgentName?: string | null;
  createdByRole?: string | null;
  createdBySessionId?: string | null;
  contextHints?: string[];
  contextProposal?: {
    state: 'pending' | 'no-change' | 'applied' | 'discarded';
    operation?: 'append' | 'replace' | 'remove' | 'merge' | 'no-change';
    target?: string;
    text?: string;
    reason?: string;
    proposedBy?: string | null;
    proposedByRole?: string | null;
    createdAt?: string;
    appliedAt?: string;
    discardedAt?: string;
  } | null;
}

export interface FleetPreset {
  name: string;
  cli: string;
  role: string;
  workspace?: string;
  model?: string | null;
  startupInstructions?: string;
  enabled?: boolean;
}

export interface DashboardSummary {
  activeAgents: number;
  openTasks: number;
  blockedAgents: number;
  reviewNeeded: number;
}

export interface MaintenanceNotification {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  actionLabel?: string;
  currentVersion?: string;
  latestVersion?: string;
  manager?: string;
  updateCommand?: string;
  installCommand?: string;
}

export interface UserTaskRequest {
  id: string;
  text: string;
  attachments: Array<{ token: string; path: string }>;
  status: 'pending' | 'dispatching' | 'sent' | 'completed' | 'failed';
  sessionId?: string | null;
  agentName?: string | null;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string | null;
  sentAt?: string | null;
  completedAt?: string | null;
}

export interface UserTaskQueue {
  pending: UserTaskRequest[];
  inFlight: UserTaskRequest | null;
  history: UserTaskRequest[];
  updatedAt?: string | null;
}

export interface SecretaryInboxItem {
  id: string;
  type: 'message' | 'question';
  agentName: string;
  role: string;
  cartridgeId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  body: string;
  options: string[];
  createdAt: string;
}

export interface SecretaryInbox {
  schemaVersion: number;
  items: SecretaryInboxItem[];
  updatedAt?: string | null;
}

export interface CartridgePlacementView {
  id: string;
  templateId: string | null;
  linked: boolean;
  // The resolved definition: from its blueprint while linked, its own snapshot
  // once unlinked. Typed rather than left as a bag, because everything that
  // duplicates, stores or renders a cartridge reads these fields by name.
  definition: BlueprintDefinition | null;
  x: number;
  y: number;
  slotId: string | null;
  activated: boolean;
  sessionId: string | null;
  live: boolean;
  presence: 'running' | 'stopped' | 'idle';
  /** Which blueprint version this instance shows; null when it follows none. */
  blueprintRevision: number | null;
}

export interface BlueprintDefinition {
  name: string;
  role: string;
  model: string;
  adapter: string | null;
  cli: string | null;
  startupInstructions: string | null;
}

export interface Blueprint {
  id: string;
  definition: BlueprintDefinition;
  trayIndex: number;
  /** Advances on a definition change, not on a tray rearrangement. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface BlueprintInstanceSummary {
  projectRoot: string;
  projectName: string;
  cartridgeId: string;
  sessionId: string | null;
  activated: boolean;
  running: boolean;
  agentName: string | null;
}

export interface DashboardPayload {
  generatedAt?: string;
  summary?: DashboardSummary;
  roles?: RoleAvailability[];
  agents?: AgentSession[];
  alerts?: string[];
  activeTaskQueue?: QueueTask[];
  planningQueue?: QueueTask[];
  availableWork?: QueueTask[];
  helpQueue?: QueueTask[];
  followUpWaitQueue?: QueueTask[];
  supersededReviewQueue?: QueueTask[];
  pmReviewQueue?: QueueTask[];
  seniorReviewQueue?: QueueTask[];
  nextTodo?: QueueTask[];
  userTaskQueue?: UserTaskQueue;
  secretaryInbox?: SecretaryInbox;
  maintenanceNotifications?: MaintenanceNotification[];
  runningWorkers?: unknown[];
  runs?: unknown[];
  /**
   * Cartridge placement, joined with what is actually running. `activated` is
   * the user's intent and `live` is the observation; they are reported side by
   * side, never collapsed into one field.
   */
  cartridges?: CartridgePlacementView[];
  /** App-level, not per project: the same tray is there whichever project is open. */
  blueprints?: Blueprint[];
  daemonStatus?: {
    running?: boolean;
    pid?: number | null;
    lastTickAt?: string | null;
    lastError?: string | null;
  };
  fleetConfig?: {
    agents?: FleetPreset[];
  };
  project?: {
    root: string;
    officeRoot: string;
  };
}

export interface DashboardTheme {
  id: string;
  name: string;
  description?: string;
  cssVariables: Record<string, string>;
}

export interface DashboardThemesResponse {
  defaultThemeId: string;
  themes: DashboardTheme[];
}

export interface TelemetryRoleMetrics {
  role: string;
  dispatches: number;
  completions: number;
  reviews: number;
  reports: number;
  prompts: number;
  duplicateDispatches: number;
  lastActivityAt?: string | null;
}

export interface TelemetryAnomaly {
  kind: string;
  severity: 'info' | 'warning' | 'error';
  role?: string | null;
  agentName?: string | null;
  taskId?: string | null;
  message: string;
  at?: string | null;
}

export interface TelemetryPayload {
  generatedAt: string;
  resetAt?: string | null;
  roles: TelemetryRoleMetrics[];
  totals: {
    dispatches: number;
    completions: number;
    reviews: number;
    reports: number;
    prompts: number;
    duplicateDispatches: number;
  };
  anomalies: TelemetryAnomaly[];
}

export type DashboardEvent =
  | { type: 'dashboard.snapshot'; payload: DashboardPayload }
  | { type: 'agents.changed'; payload: AgentSession[] }
  | { type: 'agent.upserted'; payload: { key: string; agent: AgentSession } }
  | { type: 'agent.removed'; payload: { key: string } }
  | { type: 'agents.order.changed'; payload: string[] }
  | { type: 'roles.changed'; payload: RoleAvailability[] }
  | { type: 'queues.changed'; payload: Partial<DashboardPayload> }
  | { type: 'queue.changed'; payload: { queue: QueueName; rows: QueueTask[] } }
  | { type: 'fleet.changed'; payload: DashboardPayload['fleetConfig'] }
  | { type: 'daemon.changed'; payload: DashboardPayload['daemonStatus'] }
  | { type: 'alerts.changed'; payload: string[] }
  | { type: 'maintenance.changed'; payload: MaintenanceNotification[] }
  | { type: 'secretary.changed'; payload: SecretaryInbox }
  | { type: 'cartridges.changed'; payload: CartridgePlacementView[] }
  | { type: 'blueprints.changed'; payload: Blueprint[] }
  | { type: 'summary.changed'; payload: DashboardSummary }
  | { type: 'dashboard.error'; payload: { error: string } };

export type QueueName =
  | 'activeTaskQueue'
  | 'planningQueue'
  | 'availableWork'
  | 'helpQueue'
  | 'followUpWaitQueue'
  | 'supersededReviewQueue'
  | 'pmReviewQueue'
  | 'seniorReviewQueue'
  | 'nextTodo';
