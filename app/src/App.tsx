import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AgentSlots } from './components/AgentSlots';
import { AutoModeToggle } from './components/AutoModeToggle';
import { BotCartridge } from './components/BotCartridge';
import { BotBuilderButton } from './components/BotBuilderButton';
import { BotBuilderScreen } from './components/BotBuilderScreen';
import { CloseApplicationDialog } from './components/CloseApplicationDialog';
import { CleanMemoryDialog } from './components/CleanMemoryDialog';
import { NewTaskDialog } from './components/NewTaskDialog';
import { OpenCodeMissingDialog } from './components/OpenCodeMissingDialog';
import { OptionsMenu } from './components/OptionsMenu';
import { PaperFlightLayer, type PaperFlight } from './components/PaperFlightLayer';
import { ProjectManagerSlot } from './components/ProjectManagerSlot';
import { ReviewerUnavailableDialog } from './components/ReviewerUnavailableDialog';
import { SecretaryButton } from './components/SecretaryButton';
import { SecretaryPanel } from './components/SecretaryPanel';
import type { AgentAttentionNotification } from './components/SecretaryPanel';
import { SecretaryGuideLayer, type SecretaryGuide } from './components/SecretaryGuideLayer';
import { SeniorProSlot } from './components/SeniorProSlot';
import { StartWindow } from './components/StartWindow';
import { BlueprintTray, type IncomingBlueprint } from './components/BlueprintTray';
import {
  BlueprintEditPrompt,
  BreakTheLinkPrompt,
  DeleteBlueprintPrompt,
  RunningInstancesPrompt,
} from './components/BlueprintPrompts';
import { TaskSlidePanels } from './components/TaskSlidePanels';
import { TelemetryPalette } from './components/TelemetryPalette';
import { ThemeBackgroundLayer } from './components/ThemeBackgroundLayer';
import {
  addFleetPreset,
  applyBlueprintEdit,
  cleanCartridgeMemory,
  closeAgentSession,
  closeLiveAgentSessions,
  enqueueProjectManagerTaskRequest,
  focusAgentSession,
  launchFleetPreset,
  deleteBlueprint as deleteBlueprintApi,
  deleteFleetPreset,
  findBlueprintInstances,
  getTelemetry,
  messageAgentSession,
  runNextForSession,
  resetTelemetry,
  setFleetAutomaticMode,
  reorderBlueprints,
  removeCartridgePlacement,
  saveBlueprint,
  saveCartridgePlacement,
} from './api';
import { useCartridgeSync } from './cartridges/useCartridgeSync';
import {
  alignConnectedCartridgePlacements,
  materializeCartridgePlacement,
} from './cartridges/placement';
import {
  duplicateCartridge,
  instanceFromBlueprint,
  saveAsBlueprint,
  unlink,
} from './cartridges/instancing';
import { useDashboardData } from './hooks/useDashboardData';
import { useDashboardThemes } from './hooks/useDashboardThemes';
import { useDashboardWindows } from './hooks/useDashboardWindows';
import { trayCompositionToStyle } from './themes/trayCompositionTypes';
import { getThemeTrayComposition } from './themes/trayCompositions';
import { socketCompositionToStyle } from './themes/socketCompositionTypes';
import { getThemeSocketComposition } from './themes/socketCompositions';
import type {
  AgentSession,
  Blueprint,
  BlueprintDefinition,
  BlueprintInstanceSummary,
  DashboardPayload,
  FleetPreset,
  QueueTask,
  TelemetryPayload,
} from './types';
import type { BotCartridgeData, BotDraft, BotRuntimeStatus } from './types/bot';
import { getDesktopApi } from './desktop-api';
import './styles.css';
import './animations.css';
import './themes/cyberpunk/theme.css';

const SELECTED_PROJECT_STORAGE_KEY = 'tiny-agent-office:selected-project';
const BOT_STORAGE_KEY_PREFIX = 'tiny-agent-office:new-ui:bot-cartridges';
const AUTO_MODE_STORAGE_KEY_PREFIX = 'tiny-agent-office:new-ui:auto-mode';
const CARTRIDGE_WIDTH = 224;
const CARTRIDGE_HEIGHT = 174;
const CONNECTOR_OFFSET_X = CARTRIDGE_WIDTH / 2;
const LEFT_CONNECTOR_OFFSET_X = 10;
const TOP_CONNECTOR_OFFSET_Y = 12;
const BOTTOM_CONNECTOR_OFFSET_Y = 138;
const SIDE_CONNECTOR_OFFSET_Y = CARTRIDGE_HEIGHT / 2;
const SLOT_SNAP_DISTANCE = 72;
const CARTRIDGE_VIEWPORT_MARGIN = 16;
const PM_SLOT_VISUAL_LIFT = 34;
const SP_SLOT_INSERT_DEPTH = 15;
const TERMINAL_MIN_WIDTH = 448;
const TERMINAL_MIN_HEIGHT = 300;
const TERMINAL_DEFAULT_FONT_SIZE = 11;
const TERMINAL_MIN_FONT_SIZE = 9;
const TERMINAL_MAX_FONT_SIZE = 18;
const TERMINAL_BASE_LAYER = 28;

function clampBotPosition(position: { x: number; y: number }) {
  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 720 : window.innerHeight;
  return {
    x: Math.min(
      Math.max(position.x, CARTRIDGE_VIEWPORT_MARGIN),
      Math.max(CARTRIDGE_VIEWPORT_MARGIN, viewportWidth - CARTRIDGE_WIDTH - CARTRIDGE_VIEWPORT_MARGIN),
    ),
    y: Math.min(
      Math.max(position.y, CARTRIDGE_VIEWPORT_MARGIN),
      Math.max(CARTRIDGE_VIEWPORT_MARGIN, viewportHeight - CARTRIDGE_HEIGHT - CARTRIDGE_VIEWPORT_MARGIN),
    ),
  };
}

function projectStorageSuffix(projectRoot: string) {
  return btoa(unescape(encodeURIComponent(projectRoot))).replace(/=+$/u, '');
}

function botStorageKey(projectRoot: string) {
  return `${BOT_STORAGE_KEY_PREFIX}:${projectStorageSuffix(projectRoot)}`;
}

function autoModeStorageKey(projectRoot: string) {
  return `${AUTO_MODE_STORAGE_KEY_PREFIX}:${projectStorageSuffix(projectRoot)}`;
}

function loadStoredBots(storageKey: string): BotCartridgeData[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((bot) => (
        bot
        && typeof bot.id === 'string'
        && typeof bot.name === 'string'
        && typeof bot.role === 'string'
        && typeof bot.model === 'string'
        && typeof bot.x === 'number'
        && typeof bot.y === 'number'
      ))
      .map((bot) => {
        const clamped = clampBotPosition({ x: bot.x, y: bot.y });
        const validStoredSlot = (
          (bot.role === 'PM' && bot.slotId === 'pm-slot')
          || (bot.role === 'SP' && bot.slotId === 'sp-slot')
          || (bot.role !== 'PM' && bot.role !== 'SP' && typeof bot.slotId === 'string' && bot.slotId.startsWith('slot-'))
        );
        return {
          ...bot,
          ...clamped,
          slotId: validStoredSlot ? bot.slotId : null,
          sessionId: null,
          activated: false,
          terminalExpanded: false,
          terminalWidth: Math.max(TERMINAL_MIN_WIDTH, Number(bot.terminalWidth) || TERMINAL_MIN_WIDTH),
          terminalHeight: Math.max(TERMINAL_MIN_HEIGHT, Number(bot.terminalHeight) || TERMINAL_MIN_HEIGHT),
          terminalFontSize: Math.min(
            TERMINAL_MAX_FONT_SIZE,
            Math.max(TERMINAL_MIN_FONT_SIZE, Number(bot.terminalFontSize) || TERMINAL_DEFAULT_FONT_SIZE),
          ),
          terminalLayer: Number(bot.terminalLayer) || TERMINAL_BASE_LAYER,
          status: 'idle',
        };
      });
  } catch (_) {
    return [];
  }
}

function connectorPoint(bot: BotCartridgeData) {
  if (bot.role === 'SP') {
    return {
      x: bot.x + LEFT_CONNECTOR_OFFSET_X,
      y: bot.y + SIDE_CONNECTOR_OFFSET_Y,
    };
  }

  return {
    x: bot.x + CONNECTOR_OFFSET_X,
    y: bot.y + (bot.role === 'PM' ? BOTTOM_CONNECTOR_OFFSET_Y : TOP_CONNECTOR_OFFSET_Y),
  };
}

function slotPortCenter(slot: Element) {
  const port = slot.querySelector('.slot-port');
  const rect = (port || slot).getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function botPositionForPortCenter(bot: BotCartridgeData, center: { x: number; y: number }) {
  const visualLift = bot.role === 'PM' ? PM_SLOT_VISUAL_LIFT : 0;
  if (bot.role === 'SP') {
    return {
      x: center.x - LEFT_CONNECTOR_OFFSET_X - SP_SLOT_INSERT_DEPTH,
      y: center.y - SIDE_CONNECTOR_OFFSET_Y,
    };
  }

  return {
    x: center.x - CONNECTOR_OFFSET_X,
    y: center.y - (bot.role === 'PM' ? BOTTOM_CONNECTOR_OFFSET_Y : TOP_CONNECTOR_OFFSET_Y) - visualLift,
  };
}

function connectedBotPosition(bot: BotCartridgeData, slot: Element) {
  return botPositionForPortCenter(bot, slotPortCenter(slot));
}

function alignConnectedBotsToSlots(bots: BotCartridgeData[]) {
  return alignConnectedCartridgePlacements(bots, (bot, slotId) => {
    const slot = document.querySelector<HTMLElement>(`.agent-slot[data-slot-id="${slotId}"]`);
    return slot ? connectedBotPosition(bot, slot) : null;
  });
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function centeredBotPosition() {
  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 950 : window.innerHeight;
  return clampBotPosition({
    x: (viewportWidth - CARTRIDGE_WIDTH) / 2,
    y: (viewportHeight - CARTRIDGE_HEIGHT) / 2,
  });
}

function roleLabel(role: string) {
  if (role === 'PM') return 'Project Manager';
  if (role === 'SP') return 'Senior Pro';
  if (role === 'SS') return 'Semi Senior';
  if (role === 'Jr') return 'Junior';
  return role;
}

function roleMatches(agent: AgentSession, role: string) {
  return agent.roleAcronym === role || agent.role === role || agent.role === roleLabel(role);
}

function queueRoleMatches(taskRole: string | null | undefined, role: string) {
  return taskRole === role || taskRole === roleLabel(role);
}

function claimableQueueCountForRole(role: string, dashboard: DashboardPayload) {
  const queues = roleLabel(role) === 'Project Manager'
    ? [dashboard.planningQueue || []]
    : [
      dashboard.availableWork || [],
      dashboard.seniorReviewQueue || [],
    ];
  const taskIds = new Set<string>();
  for (const task of queues.flat()) {
    if (queueRoleMatches(task.claimableRole, role)) {
      taskIds.add(task.id);
    }
  }
  return taskIds.size;
}

function sessionIsIdleForClaim(session?: AgentSession) {
  if (!session) return false;
  if (session.operationalStatus === 'error') return false;
  if (session.activeTaskId) return false;
  if (session.attentionRequired) return false;
  return !['working', 'assigned', 'stalled', 'blocked', 'attention'].includes(session.status);
}

function sessionCanClaimRoleWork(session: AgentSession | undefined, role: string, dashboard: DashboardPayload) {
  return Boolean(
    session
    && session.hasLiveTerminal
    && roleMatches(session, role)
    && sessionIsIdleForClaim(session)
    && claimableQueueCountForRole(role, dashboard) > 0
  );
}

function sessionHasRunnableAssignedTask(session?: AgentSession) {
  if (!session) return false;
  if (!session.activeTaskId) return false;
  if (session.operationalStatus === 'error') return false;
  if (session.attentionRequired) return false;
  if (session.activityState === 'assigned' || session.activityState === 'stalled') return true;
  if (['working', 'blocked', 'attention'].includes(session.status)) return false;
  return session.status === 'assigned';
}

function readyBotIdsForClaimableWork(
  bots: BotCartridgeData[],
  dashboard: DashboardPayload,
  agents: AgentSession[],
) {
  const readyIds = new Set<string>();

  for (const bot of bots) {
    if (!bot.slotId || !bot.activated) continue;
    const session = sessionForBot(bot, agents);
    if (sessionCanClaimRoleWork(session, bot.role, dashboard)) {
      readyIds.add(bot.id);
    }
  }

  return readyIds;
}

function sessionForBot(bot: BotCartridgeData, agents: AgentSession[] = []) {
  if (bot.sessionId) {
    const bySessionId = agents.find((agent) => agent.sessionId === bot.sessionId);
    if (bySessionId?.hasLiveTerminal) return bySessionId;
  }
  return agents.find((agent) => agent.hasLiveTerminal && agent.agentName === bot.name && roleMatches(agent, bot.role));
}

function botElement(botId: string) {
  return document.querySelector<HTMLElement>(`.bot-cartridge[data-bot-id="${CSS.escape(botId)}"]`);
}

function roleSlotElement(role: string | null | undefined) {
  if (role === 'Project Manager' || role === 'PM') return document.querySelector<HTMLElement>('.project-manager-slot');
  if (role === 'Senior Pro' || role === 'SP') return document.querySelector<HTMLElement>('.senior-pro-slot');
  return null;
}

function handoffSourceElement(
  task: QueueTask | undefined,
  targetBot: BotCartridgeData,
  bots: BotCartridgeData[],
  agents: AgentSession[],
) {
  const createdByRole = task?.createdByRole || (targetBot.role === 'PM' ? 'Senior Pro' : 'Project Manager');
  const creatorBot = bots.find((bot) => {
    if (!bot.slotId || !bot.activated) return false;
    if (task?.createdByAgentName && bot.name !== task.createdByAgentName) return false;
    if (task?.createdByRole && roleLabel(bot.role) !== task.createdByRole) return false;
    if (!task?.createdByAgentName && roleLabel(bot.role) !== createdByRole) return false;
    return Boolean(sessionForBot(bot, agents));
  });

  if (creatorBot) return botElement(creatorBot.id);
  return roleSlotElement(createdByRole);
}

function runtimeStatusForBot(
  bot: BotCartridgeData,
  agents: AgentSession[] = [],
  hasClaimableTurn = false,
): BotRuntimeStatus {
  if (!bot.slotId) return 'idle';
  const session = sessionForBot(bot, agents);
  if (!bot.activated || !session) return 'idle';
  if (session?.operationalStatus === 'error') return 'attention';
  if (session?.attentionRequired || session?.status === 'attention') return 'attention';
  if (session?.activityState === 'stalled' || session?.status === 'stalled' || session?.status === 'blocked') return 'stalled';
  if (session?.activeTaskId && (session?.status === 'working' || session?.activityState === 'working')) return 'working';
  if (session?.activeTaskId && (session?.status === 'assigned' || session?.activityState === 'assigned')) return 'has-tasks';

  if (hasClaimableTurn) return 'has-tasks';
  return 'idle';
}

function BlueprintInstanceLine({
  blueprintId,
  dashboard,
  themeId,
}: {
  blueprintId: string | null;
  dashboard: DashboardPayload;
  themeId: string;
}) {
  const [line, setLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  useLayoutEffect(() => {
    if (!blueprintId) {
      setLine(null);
      return undefined;
    }

    const instance = (dashboard.cartridges || []).find((entry) => entry.templateId === blueprintId);
    if (!instance) {
      setLine(null);
      return undefined;
    }

    const update = () => {
      const traySlot = document.querySelector<HTMLElement>(`[data-blueprint-id="${CSS.escape(blueprintId)}"]`);
      const cartridge = document.querySelector<HTMLElement>(`.bot-cartridge[data-bot-id="${CSS.escape(instance.id)}"]`);
      if (!traySlot || !cartridge) {
        setLine(null);
        return;
      }

      const from = traySlot.getBoundingClientRect();
      const to = cartridge.getBoundingClientRect();
      setLine({
        x1: from.left + from.width / 2,
        y1: from.top + from.height / 2,
        x2: to.left + to.width / 2,
        y2: to.top + to.height / 2,
      });
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [blueprintId, dashboard.cartridges]);

  if (!line) return null;

  return (
    <svg
      className="blueprint-instance-line-layer"
      aria-hidden="true"
      style={trayCompositionToStyle('tray', getThemeTrayComposition(themeId))}
    >
      <line
        className="blueprint-instance-line"
        x1={line.x1}
        y1={line.y1}
        x2={line.x2}
        y2={line.y2}
      />
    </svg>
  );
}

function attentionAdviceForSession(session: AgentSession) {
  const text = [
    session.operationalError || '',
    session.note || '',
    session.attentionRequest?.question || '',
  ].join(' ').toLowerCase();

  if (text.includes('model') || text.includes('unsupported')) {
    return 'This looks like a model compatibility problem. Try changing this cartridge model and launch it again.';
  }

  if (
    text.includes('credit')
    || text.includes('quota')
    || text.includes('billing')
    || text.includes('payment')
    || text.includes('insufficient')
    || text.includes('rate limit')
  ) {
    return 'This may be a credits, billing, quota, or rate-limit issue. Check the provider account, then retry or switch model.';
  }

  return 'Review this agent. If the issue is not clear, try changing the model or checking provider credits.';
}

function botFromPreset(preset: FleetPreset, index: number): BotCartridgeData {
  return {
    id: `preset-${preset.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${preset.role}`,
    name: preset.name,
    role: preset.role,
    model: preset.model || 'opencode',
    adapter: preset.cli || 'opencode',
    cli: preset.cli || 'opencode',
    startupInstructions: preset.startupInstructions || '',
    sessionId: null,
    x: 152 + index * 24,
    y: 220 + index * 24,
    status: 'idle',
    terminalExpanded: false,
    terminalX: 0,
    terminalY: 0,
    terminalWidth: TERMINAL_MIN_WIDTH,
    terminalHeight: TERMINAL_MIN_HEIGHT,
    terminalFontSize: TERMINAL_DEFAULT_FONT_SIZE,
    terminalLayer: TERMINAL_BASE_LAYER,
  };
}

function blueprintOperationError(error: unknown, fallback: string) {
  const operationError = error as Error & {
    body?: {
      reason?: string;
      unreachable?: Array<{ projectName?: string; reason?: string }>;
      blockedBy?: { projectName?: string; agentName?: string | null; reason?: string };
    };
  };
  const unreachable = operationError.body?.unreachable || [];
  if (unreachable.length > 0) {
    const projects = unreachable.map((entry) => entry.projectName || 'unknown project').join(', ');
    return `Could not reach ${projects}. No blueprint changes were made.`;
  }
  if (operationError.body?.blockedBy) {
    const blocked = operationError.body.blockedBy;
    const owner = blocked.agentName || blocked.projectName || 'a running instance';
    return `${owner} blocked this operation${blocked.reason ? `: ${blocked.reason}` : '.'}`;
  }
  return operationError instanceof Error ? operationError.message : fallback;
}

function DashboardApp({ projectRoot }: { projectRoot: string }) {
  const currentBotStorageKey = useMemo(() => botStorageKey(projectRoot), [projectRoot]);
  const currentAutoModeStorageKey = useMemo(() => autoModeStorageKey(projectRoot), [projectRoot]);
  // Placement comes from the coordinator now. localStorage is read once, by the
  // migration inside useCartridgeSync, and never again.
  const [bots, setBots] = useState<BotCartridgeData[]>([]);
  const [autoMode, setAutoMode] = useState(() => window.localStorage.getItem(currentAutoModeStorageKey) === 'true');
  const [reviewerDialogOpen, setReviewerDialogOpen] = useState(false);
  const [openCodeMissingDismissed, setOpenCodeMissingDismissed] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [closeAppDialogOpen, setCloseAppDialogOpen] = useState(false);
  const [memoryCleanTargetId, setMemoryCleanTargetId] = useState<string | null>(null);
  const [memoryCleanBusy, setMemoryCleanBusy] = useState(false);
  const [memoryCleanError, setMemoryCleanError] = useState<string | null>(null);
  const [linkedEditTargetId, setLinkedEditTargetId] = useState<string | null>(null);
  const [linkedEditBusy, setLinkedEditBusy] = useState(false);
  const [linkedEditError, setLinkedEditError] = useState<string | null>(null);
  const [blueprintEdit, setBlueprintEdit] = useState<{
    id: string;
    trayIndex: number;
    draft: BlueprintDefinition;
    runningInstances: BlueprintInstanceSummary[];
    busy: boolean;
    error: string | null;
  } | null>(null);
  const [blueprintDelete, setBlueprintDelete] = useState<{
    id: string;
    instanceCount: number;
    busy: boolean;
    error: string | null;
  } | null>(null);
  const [closingApp, setClosingApp] = useState(false);
  const [telemetryOpen, setTelemetryOpen] = useState(false);
  const [telemetryBusy, setTelemetryBusy] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryPayload | null>(null);
  const [paperFlights, setPaperFlights] = useState<PaperFlight[]>([]);
  const [secretaryGuides, setSecretaryGuides] = useState<SecretaryGuide[]>([]);
  const [cartridgeEditRequests, setCartridgeEditRequests] = useState<Record<string, number>>({});
  const [spotlightBotId, setSpotlightBotId] = useState<string | null>(null);
  const [secretaryToastQueue, setSecretaryToastQueue] = useState<Array<{ id: string; message: string }>>([]);
  const [activeSecretaryToast, setActiveSecretaryToast] = useState<{ id: string; message: string } | null>(null);
  const [hoveredBlueprintId, setHoveredBlueprintId] = useState<string | null>(null);
  const [blueprintIntake, setBlueprintIntake] = useState<(IncomingBlueprint & { animationDone: boolean }) | null>(null);
  const knownNextTodoIds = useRef<Set<string> | null>(null);
  const knownAgentAssignments = useRef<Map<string, string | null> | null>(null);
  const previousUserReviewCount = useRef<number | null>(null);
  const previousMaintenanceIds = useRef<Set<string> | null>(null);
  const previousAttentionIds = useRef<Set<string> | null>(null);
  const previousSecretaryInboxIds = useRef<Set<string> | null>(null);
  const previousProjectManagerConnected = useRef<boolean | null>(null);
  const {
    payload: dashboard,
    message: dashboardMessage,
    setMessage: setDashboardMessage,
    promoteNextTodoLocally,
  } = useDashboardData();
  const windows = useDashboardWindows();
  const dashboardThemes = useDashboardThemes();
  const desktopApi = getDesktopApi();
  const socketThemeStyle = useMemo(
    () => socketCompositionToStyle('socket', getThemeSocketComposition(dashboardThemes.selectedThemeId)),
    [dashboardThemes.selectedThemeId],
  );

  const liveAgentCount = useMemo(
    () => (dashboard.agents || []).filter((agent) => agent.hasLiveTerminal).length,
    [dashboard.agents],
  );

  const enqueueSecretaryToast = useCallback((message: string) => {
    const cleanMessage = message.trim();
    if (!cleanMessage) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setSecretaryToastQueue((current) => {
      const last = current[current.length - 1];
      if (last && last.message === cleanMessage) return current;
      return [...current, { id, message: cleanMessage }];
    });
  }, []);

  const refreshTelemetry = useCallback(() => {
    setTelemetryBusy(true);
    setTelemetryError(null);
    void getTelemetry()
      .then((payload) => setTelemetry(payload))
      .catch((error) => setTelemetryError(error instanceof Error ? error.message : 'Could not load telemetry.'))
      .finally(() => setTelemetryBusy(false));
  }, []);

  const clearTelemetry = useCallback(() => {
    setTelemetryBusy(true);
    setTelemetryError(null);
    void resetTelemetry()
      .then((payload) => setTelemetry(payload))
      .catch((error) => setTelemetryError(error instanceof Error ? error.message : 'Could not reset telemetry.'))
      .finally(() => setTelemetryBusy(false));
  }, []);

  useEffect(() => {
    function handleTelemetryShortcut(event: KeyboardEvent) {
      if (!event.ctrlKey || event.key.toLowerCase() !== 'p') return;
      event.preventDefault();
      setTelemetryOpen((open) => {
        const nextOpen = !open;
        if (nextOpen) refreshTelemetry();
        return nextOpen;
      });
    }

    window.addEventListener('keydown', handleTelemetryShortcut);
    return () => window.removeEventListener('keydown', handleTelemetryShortcut);
  }, [refreshTelemetry]);

  useEffect(() => {
    if (activeSecretaryToast || secretaryToastQueue.length === 0) return;
    setActiveSecretaryToast(secretaryToastQueue[0]);
    setSecretaryToastQueue((current) => current.slice(1));
  }, [activeSecretaryToast, secretaryToastQueue]);

  useEffect(() => {
    if (!activeSecretaryToast) return undefined;
    const timeoutId = window.setTimeout(() => {
      setActiveSecretaryToast(null);
    }, 3000);

    return () => window.clearTimeout(timeoutId);
  }, [activeSecretaryToast]);

  useEffect(() => {
    if (dashboardMessage) enqueueSecretaryToast(dashboardMessage);
  }, [dashboardMessage, enqueueSecretaryToast]);

  // Was: write every bot to localStorage on every change. Placement is
  // coordinator state now, and the hook below owns both directions.
  // A cartridge row and a bot are not the same shape, and the difference is
  // exactly the fourth seam trap: the bot keeps name, role and model at the top
  // level, the row keeps them inside `definition` because a linked instance has
  // none of its own. Migrating without this mapping stores rows with no
  // definition at all, and the first render of one crashes on a missing role.
  const legacyCartridges = useCallback(
    () => loadStoredBots(currentBotStorageKey).map((bot) => ({
      id: bot.id,
      templateId: null,
      definition: {
        name: bot.name,
        role: bot.role,
        model: bot.model,
        adapter: bot.adapter,
        cli: bot.cli,
        startupInstructions: bot.startupInstructions,
      },
      x: bot.x,
      y: bot.y,
      slotId: bot.slotId ?? null,
      activated: false,
      sessionId: null,
    })) as unknown as BotCartridgeData[],
    [currentBotStorageKey],
  );

  // The server owns placement and the link to a session. Terminal geometry is a
  // property of the screen in front of you, so it stays local and is carried
  // across from the bot already on screen -- dropping it here would resize every
  // terminal once a second.
  const placementFromServer = useCallback(
    (entry: BotCartridgeData, local: BotCartridgeData | undefined): BotCartridgeData => ({
      // The definition lives on the row for an unlinked cartridge and on its
      // blueprint for a linked one; either way it is what carries name, role and
      // model back onto the bot. Undefined transport fields must not erase that
      // resolved identity; the label reads it synchronously while rendering.
      ...materializeCartridgePlacement(
        entry as BotCartridgeData & { definition?: Partial<BotCartridgeData> | null },
        local,
      ),
      terminalExpanded: local?.terminalExpanded ?? false,
      terminalX: local?.terminalX,
      terminalY: local?.terminalY,
      terminalWidth: local?.terminalWidth ?? TERMINAL_MIN_WIDTH,
      terminalHeight: local?.terminalHeight ?? TERMINAL_MIN_HEIGHT,
      terminalFontSize: local?.terminalFontSize ?? TERMINAL_DEFAULT_FONT_SIZE,
      terminalLayer: local?.terminalLayer ?? TERMINAL_BASE_LAYER,
    }),
    [],
  );

  const cartridgeSync = useCartridgeSync<BotCartridgeData>({
    // The project the PAYLOAD describes, not the one this component was mounted
    // with. They are normally the same -- DashboardApp is keyed on projectRoot,
    // so choosing a project remounts everything -- but the dashboard server has a
    // single active project, so another window switching projects changes what
    // this one is being sent without remounting it. Comparing against the prop
    // would miss that entirely and merge one project's cartridges into another's
    // state, then commit them there.
    projectRoot: dashboard.project?.root || projectRoot,
    // The payload's cartridges are placement records, not bots. `placementFrom`
    // below is what turns one into the other, carrying the local terminal
    // geometry across.
    incoming: dashboard.cartridges as unknown as BotCartridgeData[] | undefined,
    bots,
    setBots,
    legacyCartridges,
    placementFrom: placementFromServer,
  });

  const connectedPlacementKey = useMemo(
    () => bots
      .filter((bot) => bot.slotId)
      .map((bot) => `${bot.id}:${bot.role}:${bot.slotId}`)
      .join('|'),
    [bots],
  );

  // Placement rows arrive after the dashboard mounts. Reconcile a restored
  // connection as soon as it materializes so stale coordinates from an older
  // window/socket layout never reach the first useful paint.
  useLayoutEffect(() => {
    setBots((current) => alignConnectedBotsToSlots(current));
  }, [connectedPlacementKey, dashboardThemes.selectedThemeId]);

  useEffect(() => {
    window.localStorage.setItem(currentAutoModeStorageKey, String(autoMode));
  }, [autoMode, currentAutoModeStorageKey]);

  useEffect(() => {
    if (typeof dashboard.daemonStatus?.running !== 'boolean') return;
    setAutoMode(dashboard.daemonStatus.running);
  }, [dashboard.daemonStatus?.running]);

  useEffect(() => {
    const presets = dashboard.fleetConfig?.agents || [];
    if (presets.length === 0) return;

    setBots((current) => {
      let changed = false;
      const next = [...current];
      for (const preset of presets) {
        const exists = next.some((bot) => bot.name === preset.name && bot.role === preset.role);
        if (exists) continue;
        next.push(botFromPreset(preset, next.length));
        changed = true;
      }
      return changed ? next : current;
    });
  }, [dashboard.fleetConfig?.agents]);

  useEffect(() => {
    let animationFrame = 0;

    function handleResize() {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        setBots((current) => alignConnectedBotsToSlots(current));
      });
    }

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    setBots((current) => {
      let changed = false;
      const readyIds = readyBotIdsForClaimableWork(current, dashboard, dashboard.agents || []);
      const next = current.map((bot) => {
        if (!bot.slotId) return bot;
        const liveSession = sessionForBot(bot, dashboard.agents || []);
        if (liveSession) {
          const sessionId = liveSession.sessionId || null;
          const status = runtimeStatusForBot(bot, dashboard.agents || [], readyIds.has(bot.id));
          if (bot.activated && bot.sessionId === sessionId && bot.status === status) return bot;
          changed = true;
          return {
            ...bot,
            activated: true,
            sessionId,
            status,
          };
        }
        if (bot.activated || bot.sessionId) {
          if (bot.status === 'attention') return bot;
          changed = true;
          return {
            ...bot,
            status: 'attention' as BotRuntimeStatus,
          };
        }
        if (!bot.activated && !bot.sessionId) return bot;
        return bot;
      });
      return changed ? next : current;
    });
  }, [dashboard]);

  const readyBotIds = useMemo(
    () => readyBotIdsForClaimableWork(bots, dashboard, dashboard.agents || []),
    [bots, dashboard],
  );

  const connectedBySlot = useMemo(() => {
    const bySlot: Record<string, { name: string; role: string; activated: boolean; sessionId?: string | null; hasClaimableTasks: boolean } | undefined> = {};
    for (const bot of bots) {
      if (bot.slotId) {
        const session = sessionForBot(bot, dashboard.agents || []);
        bySlot[bot.slotId] = {
          name: bot.name,
          role: bot.role,
          activated: Boolean(bot.activated && session),
          sessionId: session?.sessionId || null,
          hasClaimableTasks: readyBotIds.has(bot.id),
        };
      }
    }
    return bySlot;
  }, [bots, dashboard.agents, readyBotIds]);

  useEffect(() => {
    const nextIds = new Set((dashboard.nextTodo || []).map((task) => task.id));
    if (!knownNextTodoIds.current) {
      knownNextTodoIds.current = nextIds;
      return;
    }

    const added = [...nextIds].filter((id) => !knownNextTodoIds.current?.has(id));
    knownNextTodoIds.current = nextIds;
    if (added.length === 0) return;

    const pmSlot = document.querySelector<HTMLElement>('.project-manager-slot');
    const nextTab = document.querySelector<HTMLElement>('[data-task-panel-tab="next"]');
    if (pmSlot && nextTab) {
      addPaperFlight(pmSlot.getBoundingClientRect(), nextTab.getBoundingClientRect());
    }
  }, [dashboard.nextTodo]);

  useEffect(() => {
    const agents = dashboard.agents || [];
    const nextAssignments = new Map<string, string | null>();
    for (const agent of agents) {
      const key = agent.sessionId || `${agent.agentName}:${agent.role}`;
      nextAssignments.set(key, agent.activeTaskId || null);
    }

    if (!knownAgentAssignments.current) {
      knownAgentAssignments.current = nextAssignments;
      return;
    }

    for (const agent of agents) {
      if (!agent.activeTaskId) continue;
      const key = agent.sessionId || `${agent.agentName}:${agent.role}`;
      const previousTaskId = knownAgentAssignments.current.get(key) || null;
      if (previousTaskId === agent.activeTaskId) continue;

      const task = (dashboard.activeTaskQueue || []).find((entry) => entry.id === agent.activeTaskId);
      const targetBot = bots.find((bot) => {
        const session = sessionForBot(bot, agents);
        return session?.sessionId === agent.sessionId;
      });
      if (!targetBot) continue;

      const targetElement = document.querySelector<HTMLElement>(`.bot-cartridge[data-bot-id="${CSS.escape(targetBot.id)}"]`);
      const sourceElement = handoffSourceElement(task, targetBot, bots, agents);
      if (sourceElement && targetElement && sourceElement !== targetElement) {
        addPaperFlight(sourceElement.getBoundingClientRect(), targetElement.getBoundingClientRect());
      }
    }

    knownAgentAssignments.current = nextAssignments;
  }, [dashboard.agents, dashboard.activeTaskQueue, bots]);

  const hasProjectManager = Boolean(connectedBySlot['pm-slot']);
  const projectManagerBusy = (dashboard.agents || []).some((agent) => roleMatches(agent, 'PM') && agent.status === 'working')
    || bots.some((bot) => (
      bot.role === 'PM'
      && bot.activated
      && runtimeStatusForBot(bot, dashboard.agents || [], readyBotIds.has(bot.id)) === 'working'
    ));
  const localReviewerConnected = bots.some((bot) => bot.activated && (bot.role === 'PM' || bot.role === 'SP'));
  const runtimeReviewerConnected = (dashboard.agents || []).some((agent) => (
    Boolean(agent.sessionId)
    && (agent.role === 'PM' || agent.role === 'SP' || agent.roleAcronym === 'PM' || agent.roleAcronym === 'SP')
    && agent.status !== 'unavailable'
  ));
  const reviewerAvailable = localReviewerConnected || runtimeReviewerConnected;
  const agentAttentionNotifications: AgentAttentionNotification[] = bots
    .map((bot) => {
      if (!bot.slotId || !bot.activated) return null;
      const session = sessionForBot(bot, dashboard.agents || []);
      if (!session) return null;
      const status = runtimeStatusForBot(bot, dashboard.agents || [], readyBotIds.has(bot.id));
      if (status !== 'attention') return null;
      if (session.attentionRequest && !session.operationalError) return null;
      const issue = session.operationalError || session.attentionRequest?.question || session.note || 'This agent needs your attention.';
      return {
        id: `${bot.id}:${session.sessionId || bot.name}:attention`,
        botId: bot.id,
        title: `${bot.name} needs attention`,
        body: issue,
        advice: attentionAdviceForSession(session),
      };
    })
    .filter((notification): notification is AgentAttentionNotification => Boolean(notification));
  const agentAttentionCount = agentAttentionNotifications.length;
  const userReviewCount = dashboard.pmReviewQueue?.length || 0;
  const maintenanceNotificationCount = dashboard.maintenanceNotifications?.length || 0;
  const secretaryInboxCount = dashboard.secretaryInbox?.items.length || 0;
  const openCodeMissingNotification = (dashboard.maintenanceNotifications || []).find((notification) => notification.type === 'opencode-missing') || null;
  const secretaryNotificationCount = userReviewCount + maintenanceNotificationCount + agentAttentionCount + secretaryInboxCount;
  const secretaryMessage = activeSecretaryToast?.message;

  useEffect(() => {
    const previous = previousUserReviewCount.current;
    previousUserReviewCount.current = userReviewCount;

    if (previous === null) {
      if (userReviewCount > 0) enqueueSecretaryToast(`${userReviewCount} task(s) need your review.`);
      return;
    }

    if (userReviewCount > previous) {
      enqueueSecretaryToast(`${userReviewCount} task(s) need your review.`);
    }
  }, [userReviewCount, enqueueSecretaryToast]);

  useEffect(() => {
    const currentIds = new Set((dashboard.maintenanceNotifications || []).map((notification) => notification.id));
    const previousIds = previousMaintenanceIds.current;
    previousMaintenanceIds.current = currentIds;

    const newNotifications = (dashboard.maintenanceNotifications || []).filter((notification) => (
      !previousIds || !previousIds.has(notification.id)
    ));

    for (const notification of newNotifications) {
      enqueueSecretaryToast(notification.title);
    }
  }, [dashboard.maintenanceNotifications, enqueueSecretaryToast]);

  useEffect(() => {
    const currentIds = new Set(agentAttentionNotifications.map((notification) => notification.id));
    const previousIds = previousAttentionIds.current;
    previousAttentionIds.current = currentIds;

    const newNotifications = agentAttentionNotifications.filter((notification) => (
      !previousIds || !previousIds.has(notification.id)
    ));

    for (const notification of newNotifications) {
      enqueueSecretaryToast(`${notification.title}. Review it or try changing model.`);
    }
  }, [agentAttentionNotifications, enqueueSecretaryToast]);

  useEffect(() => {
    const items = dashboard.secretaryInbox?.items || [];
    const currentIds = new Set(items.map((item) => item.id));
    const previousIds = previousSecretaryInboxIds.current;
    previousSecretaryInboxIds.current = currentIds;
    for (const item of items) {
      if (previousIds?.has(item.id)) continue;
      enqueueSecretaryToast(item.type === 'question' ? `${item.agentName} has a question.` : `${item.agentName} sent a message.`);
    }
  }, [dashboard.secretaryInbox, enqueueSecretaryToast]);

  useEffect(() => {
    const previous = previousProjectManagerConnected.current;
    previousProjectManagerConnected.current = hasProjectManager;
    if (previous === null || previous === true) {
      if (!hasProjectManager) enqueueSecretaryToast('No Project Manager connected.');
    }
  }, [hasProjectManager, enqueueSecretaryToast]);

  function createBot(bot: BotDraft) {
    const name = bot.name.trim();
    void addFleetPreset({
      name,
      role: bot.role,
      model: bot.model,
      cli: bot.adapter || 'opencode',
      startupInstructions: bot.startupInstructions,
    })
      .then((result) => setDashboardMessage(result.message || `${name} saved.`))
      .catch((error) => setDashboardMessage(error instanceof Error ? error.message : 'Could not save bot preset.'));

    setBots((current) => {
      const offset = current.length * 24;
      return [
        ...current,
        {
          ...bot,
          name,
          id: `bot-${Date.now()}-${current.length}`,
          cli: bot.adapter || 'opencode',
          sessionId: null,
          x: 152 + offset,
          y: 220 + offset,
          status: 'idle',
          terminalExpanded: false,
          terminalX: 0,
          terminalY: 0,
          terminalWidth: TERMINAL_MIN_WIDTH,
          terminalHeight: TERMINAL_MIN_HEIGHT,
          terminalFontSize: TERMINAL_DEFAULT_FONT_SIZE,
          terminalLayer: TERMINAL_BASE_LAYER,
        },
      ];
    });
  }

  function moveBot(id: string, position: { x: number; y: number }) {
    // Held locally for the length of the gesture; the incoming payload must not
    // land on a cartridge under the cursor.
    cartridgeSync.beginDrag(id);
    setBots((current) => current.map((bot) => (
      bot.id === id ? { ...bot, ...clampBotPosition(position), slotId: null, activated: false, status: 'idle', terminalExpanded: false } : bot
    )));
  }

  // A blueprint dragged out of the tray becomes an instance here. What that
  // means is decided in instancing.ts; this is the wiring, and the refusal is
  // surfaced rather than swallowed -- dropping a duplicate is something a user
  // can simply do, and it deserves the hint the plan specifies.
  async function instanceBlueprint(blueprintId: string, at: { x: number; y: number }) {
    const result = instanceFromBlueprint({
      blueprint: (dashboard.blueprints || []).find((entry) => entry.id === blueprintId),
      cartridges: dashboard.cartridges || [],
      at: clampBotPosition(at),
      newId: () => `cart-${crypto.randomUUID()}`,
    });

    if (!result.created || !result.cartridge) {
      enqueueSecretaryToast(
        result.reason === 'already-instanced'
          ? 'This project already has an instance of this blueprint.'
          : 'That blueprint is no longer in the tray.',
      );
      return;
    }

    try {
      await saveCartridgePlacement(result.cartridge);
    } catch (error) {
      enqueueSecretaryToast(error instanceof Error ? error.message : 'Could not place that blueprint.');
    }
  }

  // A cartridge dropped into the tray becomes a blueprint. Checked before the
  // slot search below, because the tray and a slot are two drop targets and a
  // drag ending near both needs a defined winner rather than whatever z-order
  // happens to be.
  async function saveCartridgeAsBlueprint(
    bot: BotCartridgeData,
    intakeSource?: { left: number; top: number },
  ) {
    const liveSession = sessionForBot(bot, dashboard.agents || []);
    const result = saveAsBlueprint({
      cartridge: {
        ...bot,
        live: Boolean(liveSession?.sessionId),
      },
      trayIndex: (dashboard.blueprints || []).length,
    });

    if (!result.saved || !result.blueprint) {
      enqueueSecretaryToast(
        result.reason === 'running'
          ? 'Eject this cartridge before saving it as a blueprint.'
          : result.reason === 'already-a-blueprint'
          ? 'This cartridge already follows a blueprint.'
          : 'That cartridge has nothing to save yet.',
      );
      return;
    }

    try {
      const saved = await saveBlueprint(result.blueprint);
      const created = saved.blueprint as Blueprint | undefined;
      if (!created?.id) throw new Error('The blueprint was saved without an id.');

      if (intakeSource) {
        // Replace the board cartridge with a fixed copy at the exact same pixel
        // before consuming its placement. The copy waits there until removal
        // succeeds, so persistence failure can restore the real cartridge
        // without a jump or a misleading completed animation.
        setBlueprintIntake({
          blueprint: created,
          sourceCartridgeId: bot.id,
          source: intakeSource,
          moving: false,
          animationDone: false,
        });
      }

      const placement = (dashboard.cartridges || []).find((entry) => entry.id === bot.id);
      if (placement) {
        // Shelf model: save the blueprint first, then consume the source
        // placement. Removing first would make a failed blueprint save lose the
        // only copy the user had.
        await removeCartridgePlacement(placement.id);
      }

      if (intakeSource) {
        cartridgeSync.consumeDrag(bot.id);
        setBlueprintIntake((current) => (
          current?.sourceCartridgeId === bot.id
            ? { ...current, moving: true }
            : current
        ));
      }
    } catch (error) {
      if (intakeSource) {
        cartridgeSync.endDrag();
        setBlueprintIntake((current) => (
          current?.sourceCartridgeId === bot.id ? null : current
        ));
      }
      enqueueSecretaryToast(error instanceof Error ? error.message : 'Could not save that blueprint.');
    }
  }

  // A reorder is one write for the whole column: the gesture already produced
  // every place, so sending them one at a time would be N round trips and N
  // chances to end up half reordered.
  async function reorderTray(order: Array<{ id: string; trayIndex: number }>) {
    try {
      await reorderBlueprints(order);
    } catch (error) {
      enqueueSecretaryToast(error instanceof Error ? error.message : 'Could not reorder the tray.');
    }
  }

  function requestBlueprintEdit(id: string) {
    const blueprint = (dashboard.blueprints || []).find((entry) => entry.id === id);
    if (!blueprint) {
      enqueueSecretaryToast('That blueprint is no longer in the tray.');
      return;
    }
    setBlueprintEdit({
      id: blueprint.id,
      trayIndex: blueprint.trayIndex,
      draft: { ...blueprint.definition },
      runningInstances: [],
      busy: false,
      error: null,
    });
  }

  async function submitBlueprintEdit() {
    if (!blueprintEdit) return;
    const draft = {
      ...blueprintEdit.draft,
      name: blueprintEdit.draft.name.trim(),
      model: blueprintEdit.draft.model.trim(),
      startupInstructions: blueprintEdit.draft.startupInstructions?.trim() || null,
    };
    if (!draft.name || !draft.model) return;

    setBlueprintEdit((current) => (current ? { ...current, draft, busy: true, error: null } : current));
    try {
      const found = await findBlueprintInstances(blueprintEdit.id);
      if (found.unreachable.length > 0) {
        const projects = found.unreachable.map((entry) => entry.projectName).join(', ');
        throw new Error(`Could not reach ${projects}. No blueprint changes were made.`);
      }
      const running = found.instances.filter((instance) => instance.running);
      if (running.length > 0) {
        setBlueprintEdit((current) => (
          current ? { ...current, draft, runningInstances: running, busy: false, error: null } : current
        ));
        return;
      }
      await applyBlueprintEdit({ id: blueprintEdit.id, definition: draft, trayIndex: blueprintEdit.trayIndex });
      setBlueprintEdit(null);
      enqueueSecretaryToast('Blueprint updated.');
    } catch (error) {
      const message = blueprintOperationError(error, 'Could not update that blueprint.');
      setBlueprintEdit((current) => (current ? { ...current, busy: false, error: message } : current));
    }
  }

  async function applyPendingBlueprintEdit(choice: 'stop' | 'unlink') {
    if (!blueprintEdit) return;
    setBlueprintEdit((current) => (current ? { ...current, busy: true, error: null } : current));
    try {
      await applyBlueprintEdit({
        id: blueprintEdit.id,
        definition: blueprintEdit.draft,
        trayIndex: blueprintEdit.trayIndex,
        choice,
      });
      setBlueprintEdit(null);
      enqueueSecretaryToast('Blueprint updated.');
    } catch (error) {
      const message = blueprintOperationError(error, 'Could not update that blueprint.');
      setBlueprintEdit((current) => (current ? { ...current, busy: false, error: message } : current));
    }
  }

  async function requestBlueprintDelete(id: string) {
    const blueprint = (dashboard.blueprints || []).find((entry) => entry.id === id);
    if (!blueprint) {
      enqueueSecretaryToast('That blueprint is no longer in the tray.');
      return;
    }
    setBlueprintDelete({ id, instanceCount: 0, busy: true, error: null });
    try {
      const found = await findBlueprintInstances(id);
      const error = found.unreachable.length > 0
        ? `Could not reach ${found.unreachable.map((entry) => entry.projectName).join(', ')}. Deletion may be refused.`
        : null;
      setBlueprintDelete((current) => (
        current?.id === id
          ? { ...current, instanceCount: found.instances.length, busy: false, error }
          : current
      ));
    } catch (error) {
      const message = blueprintOperationError(error, 'Could not inspect that blueprint.');
      setBlueprintDelete((current) => (
        current?.id === id ? { ...current, busy: false, error: message } : current
      ));
    }
  }

  async function confirmBlueprintDelete() {
    if (!blueprintDelete) return;
    const targetId = blueprintDelete.id;
    setBlueprintDelete((current) => (current ? { ...current, busy: true, error: null } : current));
    try {
      await deleteBlueprintApi(targetId);
      setBlueprintDelete(null);
      enqueueSecretaryToast('Blueprint deleted.');
    } catch (error) {
      const message = blueprintOperationError(error, 'Could not delete that blueprint.');
      setBlueprintDelete((current) => (current ? { ...current, busy: false, error: message } : current));
    }
  }

  const renderTrayBlueprint = useCallback((blueprint: NonNullable<DashboardPayload['blueprints']>[number]) => {
    const definition = blueprint.definition;
    return (
      <BotCartridge
        preview
        themeId={dashboardThemes.selectedThemeId}
        bot={{
          id: `blueprint-preview-${blueprint.id}`,
          name: definition.name,
          role: definition.role,
          model: definition.model,
          adapter: definition.adapter || undefined,
          cli: definition.cli || undefined,
          startupInstructions: definition.startupInstructions || undefined,
          x: 0,
          y: 0,
          sessionId: null,
          slotId: null,
          activated: false,
          status: 'idle',
          terminalExpanded: false,
        }}
        linked={false}
        onMessage={setDashboardMessage}
        onMove={() => {}}
        onDrop={() => {}}
        onUpdate={() => {}}
        onDestroy={() => {}}
        onRunNext={() => {}}
        onSetTerminalExpanded={() => {}}
        onMoveTerminal={() => {}}
        onResizeTerminal={() => {}}
        onChangeTerminalFontSize={() => {}}
        onMoveTerminalLayer={() => {}}
      />
    );
  }, [dashboardThemes.selectedThemeId, setDashboardMessage]);

  const usedBlueprintIds = useMemo(
    () => new Set((dashboard.cartridges || [])
      .map((entry) => entry.templateId)
      .filter((id): id is string => Boolean(id))),
    [dashboard.cartridges],
  );

  useEffect(() => {
    if (!blueprintIntake?.animationDone) return;
    if (!(dashboard.blueprints || []).some((blueprint) => blueprint.id === blueprintIntake.blueprint.id)) return;
    setBlueprintIntake(null);
  }, [blueprintIntake, dashboard.blueprints]);

  // Q6: duplicate is the path to a variant, and it is the only thing offered on
  // an instance besides unlinking. The copy is clean and unlinked, so it can then
  // be dropped into the tray to become a blueprint of its own.
  async function duplicateCartridgeById(id: string) {
    const placement = (dashboard.cartridges || []).find((entry) => entry.id === id);
    if (!placement) return;

    const result = duplicateCartridge({
      cartridge: placement,
      // Every name already in this project. The uniqueness is not cosmetic:
      // agent names appear in task claims, and two cartridges sharing one make
      // the claim ambiguous.
      takenNames: (dashboard.cartridges || [])
        .map((entry) => entry.definition?.name)
        .filter((name): name is string => Boolean(name)),
      at: clampBotPosition({ x: placement.x + 32, y: placement.y + 32 }),
      newId: () => `cart-${crypto.randomUUID()}`,
    });

    if (!result.created || !result.cartridge) {
      enqueueSecretaryToast('That cartridge has nothing to duplicate yet.');
      return;
    }

    try {
      await saveCartridgePlacement(result.cartridge);
    } catch (error) {
      enqueueSecretaryToast(error instanceof Error ? error.message : 'Could not duplicate that cartridge.');
    }
  }

  // The instance-side trigger of the one unlink operation (Q1, Q3, Q4).
  async function unlinkCartridgeById(id: string): Promise<{ unlinked: boolean; error?: string }> {
    const placement = (dashboard.cartridges || []).find((entry) => entry.id === id);
    if (!placement || !placement.templateId) return { unlinked: false, error: 'That cartridge is no longer linked.' };

    try {
      await saveCartridgePlacement(unlink(placement, dashboard.blueprints || []));
      return { unlinked: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not unlink that cartridge.';
      enqueueSecretaryToast(message);
      return { unlinked: false, error: message };
    }
  }

  function requestCartridgeEdit(id: string) {
    setLinkedEditError(null);
    setLinkedEditTargetId(id);
  }

  async function confirmLinkedCartridgeEdit() {
    if (!linkedEditTargetId) return;
    const targetId = linkedEditTargetId;
    setLinkedEditBusy(true);
    setLinkedEditError(null);
    const result = await unlinkCartridgeById(targetId);
    setLinkedEditBusy(false);
    if (!result.unlinked) {
      setLinkedEditError(result.error || 'Could not unlink that cartridge.');
      return;
    }
    setLinkedEditTargetId(null);
    setCartridgeEditRequests((current) => ({ ...current, [targetId]: Date.now() }));
  }

  function connectBotIfNearSlot(id: string, dropPoint?: { x: number; y: number }) {
    // Two drop targets now compete: a slot, and the tray. A drag ending near
    // both needs a defined winner rather than whichever happens to be on top,
    // so the tray is checked first and explicitly -- it is the smaller, more
    // deliberate target, and a cartridge dropped on it was aimed at it.
    const panel = document.getElementById('blueprint-tray');
    const rect = panel && panel.dataset.open === 'true' ? panel.getBoundingClientRect() : null;
    if (rect && dropPoint
      && dropPoint.x >= rect.left && dropPoint.x <= rect.right
      && dropPoint.y >= rect.top && dropPoint.y <= rect.bottom) {
      const dropped = bots.find((item) => item.id === id);
      const sourceRect = botElement(id)?.getBoundingClientRect();
      if (dropped) {
        void saveCartridgeAsBlueprint(
          dropped,
          sourceRect ? { left: sourceRect.left, top: sourceRect.top } : undefined,
        );
      }
      return;
    }

    // Normal board/slot drops release the drag lock and let the commit effect
    // persist the final position. Tray drops returned above and instead use
    // consumeDrag after both blueprint save and placement removal succeed.
    cartridgeSync.endDrag();
    setBots((current) => {
      const bot = current.find((item) => item.id === id);
      if (!bot) return current;

      const point = connectorPoint(bot);
      const occupiedSlots = new Set(current.filter((item) => item.id !== id).map((item) => item.slotId).filter(Boolean));
      let bestMatch: { slotId: string; center: { x: number; y: number }; distance: number } | null = null;

      for (const slot of Array.from(document.querySelectorAll<HTMLElement>('.agent-slot[data-slot-id]'))) {
        const slotId = slot.dataset.slotId;
        if (!slotId || occupiedSlots.has(slotId)) continue;
        const acceptRole = slot.dataset.acceptRole;
        if (acceptRole === 'PM' && bot.role !== 'PM') continue;
        if (acceptRole === 'SP' && bot.role !== 'SP') continue;
        if (acceptRole === 'non-pm' && (bot.role === 'PM' || bot.role === 'SP')) continue;
        const center = slotPortCenter(slot);
        const nextDistance = distance(point, center);
        if (nextDistance <= SLOT_SNAP_DISTANCE && (!bestMatch || nextDistance < bestMatch.distance)) {
          bestMatch = { slotId, center, distance: nextDistance };
        }
      }

      if (!bestMatch) return current;

      const snappedPosition = botPositionForPortCenter(bot, bestMatch.center);

      return current.map((item) => (
        item.id === id
          ? { ...item, ...snappedPosition, slotId: bestMatch.slotId, activated: false, status: 'has-tasks', terminalExpanded: false }
          : item
      ));
    });
  }

  async function activateSlot(slotId: string) {
    const bot = bots.find((item) => item.slotId === slotId);
    if (!bot) return;

    setBots((current) => current.map((bot) => (
      bot.slotId === slotId ? { ...bot, activated: true, status: 'working', terminalExpanded: false } : bot
    )));

    try {
      await addFleetPreset({
        name: bot.name,
        role: bot.role,
        model: bot.model,
        cli: bot.adapter || bot.cli || 'opencode',
        startupInstructions: bot.startupInstructions,
      });
      const result = await launchFleetPreset(bot.name, bot.id);
      setDashboardMessage(result.message || `${bot.name} launched.`);
      setBots((current) => current.map((item) => (
        item.id === bot.id
          ? { ...item, activated: true, sessionId: result.launched?.sessionId || item.sessionId || null, status: 'working' }
          : item
      )));
    } catch (error) {
      setDashboardMessage(error instanceof Error ? error.message : `Could not activate ${bot.name}.`);
      setBots((current) => current.map((item) => (
        item.id === bot.id ? { ...item, activated: false, status: 'idle' } : item
      )));
    }
  }

  function setTerminalExpanded(id: string, expanded: boolean) {
    setBots((current) => current.map((bot) => (
      bot.id === id ? { ...bot, terminalExpanded: expanded } : bot
    )));
  }

  function moveTerminal(id: string, position: { x: number; y: number }) {
    setBots((current) => current.map((bot) => (
      bot.id === id ? { ...bot, terminalX: position.x, terminalY: position.y } : bot
    )));
  }

  function resizeTerminal(id: string, size: { width: number; height: number }) {
    setBots((current) => current.map((bot) => (
      bot.id === id
        ? {
          ...bot,
          terminalWidth: Math.max(TERMINAL_MIN_WIDTH, Math.round(size.width)),
          terminalHeight: Math.max(TERMINAL_MIN_HEIGHT, Math.round(size.height)),
        }
        : bot
    )));
  }

  function changeTerminalFontSize(id: string, delta: number) {
    setBots((current) => current.map((bot) => {
      if (bot.id !== id) return bot;
      const currentSize = bot.terminalFontSize || TERMINAL_DEFAULT_FONT_SIZE;
      return {
        ...bot,
        terminalFontSize: Math.min(TERMINAL_MAX_FONT_SIZE, Math.max(TERMINAL_MIN_FONT_SIZE, currentSize + delta)),
      };
    }));
  }

  function moveTerminalLayer(id: string, direction: 'up' | 'down') {
    setBots((current) => {
      const layers = current.map((bot) => bot.terminalLayer || TERMINAL_BASE_LAYER);
      const maxLayer = Math.max(TERMINAL_BASE_LAYER, ...layers);
      const minLayer = Math.min(TERMINAL_BASE_LAYER, ...layers);
      return current.map((bot) => {
        if (bot.id !== id) return bot;
        return {
          ...bot,
          terminalLayer: direction === 'up'
            ? maxLayer + 1
            : Math.max(1, minLayer - 1),
        };
      });
    });
  }

  function updateBot(id: string, patch: Partial<BotDraft>) {
    const previousBot = bots.find((bot) => bot.id === id);
    if (!previousBot || previousBot.activated) return;
    const updatedBot = { ...previousBot, ...patch };

    setBots((current) => current.map((bot) => (bot.id === id ? updatedBot : bot)));

    void Promise.resolve()
      .then(async () => {
        if (previousBot.name !== updatedBot.name) {
          await deleteFleetPreset(previousBot.name);
        }
        return addFleetPreset({
          name: updatedBot.name,
          role: updatedBot.role,
          model: updatedBot.model,
          cli: updatedBot.adapter || updatedBot.cli || 'opencode',
          startupInstructions: updatedBot.startupInstructions,
        });
      })
      .then((result) => setDashboardMessage(result.message || `${updatedBot.name} updated.`))
      .catch((error) => setDashboardMessage(error instanceof Error ? error.message : 'Could not update bot preset.'));
  }

  function destroyBot(id: string) {
    const bot = bots.find((item) => item.id === id);
    if (!bot || bot.activated) return;
    setBots((current) => current.filter((item) => item.id !== id));
    void deleteFleetPreset(bot.name)
      .then((result) => setDashboardMessage(result.message || `${bot.name} deleted.`))
      .catch((error) => setDashboardMessage(error instanceof Error ? error.message : 'Could not delete bot preset.'));
  }

  async function confirmCleanMemory() {
    const bot = bots.find((item) => item.id === memoryCleanTargetId);
    if (!bot) {
      setMemoryCleanError('That cartridge is no longer available.');
      return;
    }
    if (bot.activated || sessionForBot(bot, dashboard.agents || [])) {
      setMemoryCleanError('Stop the agent before cleaning its memory.');
      return;
    }
    setMemoryCleanBusy(true);
    setMemoryCleanError(null);
    try {
      const result = await cleanCartridgeMemory(bot.id);
      setDashboardMessage(result.message || `${bot.name}'s memory was cleaned.`);
      setMemoryCleanTargetId(null);
    } catch (error) {
      setMemoryCleanError(error instanceof Error ? error.message : 'Could not clean agent memory.');
    } finally {
      setMemoryCleanBusy(false);
    }
  }

  async function ejectSlot(slotId: string) {
    const botForSlot = bots.find((item) => item.slotId === slotId);
    const session = botForSlot ? sessionForBot(botForSlot, dashboard.agents || []) : null;
    if (session?.sessionId) {
      try {
        const result = await closeAgentSession(session.sessionId);
        setDashboardMessage(result.message || `${session.agentName} closed.`);
      } catch (error) {
        setDashboardMessage(error instanceof Error ? error.message : 'Could not close session.');
      }
    }

    const slot = document.querySelector<HTMLElement>(`.agent-slot[data-slot-id="${slotId}"]`);
    const rect = slot?.getBoundingClientRect();
    setBots((current) => current.map((bot) => {
      if (bot.slotId !== slotId) return bot;
      if (!rect) return { ...bot, sessionId: null, slotId: null, activated: false, status: 'idle', terminalExpanded: false };
      const ejectedPosition = clampBotPosition({
        x: bot.role === 'SP'
          ? rect.right + 24
          : rect.left + rect.width / 2 - CONNECTOR_OFFSET_X,
        y: bot.role === 'PM'
          ? rect.top - CARTRIDGE_HEIGHT - 24
          : bot.role === 'SP'
            ? rect.top + rect.height / 2 - SIDE_CONNECTOR_OFFSET_Y
          : rect.bottom + 24,
      });
      return {
        ...bot,
        sessionId: null,
        slotId: null,
        activated: false,
        status: 'idle',
        terminalExpanded: false,
        ...ejectedPosition,
      };
    }));
  }

  async function focusSlotSession(slotId: string) {
    const bot = bots.find((item) => item.slotId === slotId);
    const session = bot ? sessionForBot(bot, dashboard.agents || []) : null;
    if (!session?.sessionId) return;
    try {
      const result = await focusAgentSession(session.sessionId);
      setDashboardMessage(result.message || 'Window focused.');
    } catch (error) {
      setDashboardMessage(error instanceof Error ? error.message : 'Could not focus session.');
    }
  }

  async function runNextForSlot(slotId: string) {
    const bot = bots.find((item) => item.slotId === slotId);
    const session = bot ? sessionForBot(bot, dashboard.agents || []) : null;
    if (!session?.sessionId) return;
    try {
      const result = await runNextForSession(session.sessionId);
      setDashboardMessage(result.message || 'Todo task dispatched.');
    } catch (error) {
      setDashboardMessage(error instanceof Error ? error.message : 'Could not run todo task.');
    }
  }

  function toggleAutoMode() {
    const next = !autoMode;
    setAutoMode(next);
    void setFleetAutomaticMode(next)
      .then((result) => setDashboardMessage(result.message || (next ? 'Auto mode enabled.' : 'Auto mode disabled.')))
      .catch((error) => {
        setAutoMode(!next);
        setDashboardMessage(error instanceof Error ? error.message : 'Could not change auto mode.');
      });
  }

  function requestCloseApplication() {
    windows.closeOptions();
    setCloseAppDialogOpen(true);
  }

  async function closeApplication(closeAgents: boolean) {
    setClosingApp(true);
    try {
      if (closeAgents) {
        await closeLiveAgentSessions();
      }
      // Without the bridge there is nothing to quit, and `await undefined`
      // resolves happily -- which would leave the dialog spinning forever with
      // no explanation, the same failure this dialog already had.
      if (!desktopApi) {
        throw new Error('TinyAgentOffice can only close itself from the desktop app.');
      }
      await desktopApi.closeApp();
    } catch (error) {
      setClosingApp(false);
      setDashboardMessage(error instanceof Error ? error.message : 'Could not close TinyAgentOffice.');
    }
  }

  function addPaperFlight(from: DOMRect, to: DOMRect) {
    const id = `paper-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPaperFlights((current) => [...current, { id, from, to }]);
    window.setTimeout(() => {
      setPaperFlights((current) => current.filter((flight) => flight.id !== id));
    }, 950);
  }

  function addSecretaryGuide(from: DOMRect, to: DOMRect) {
    const id = `secretary-guide-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setSecretaryGuides((current) => [...current, { id, from, to }]);
    window.setTimeout(() => {
      setSecretaryGuides((current) => current.filter((guide) => guide.id !== id));
    }, 900);
  }

  function connectedProjectManagerSessionId() {
    const pmSlot = connectedBySlot['pm-slot'];
    if (pmSlot?.activated && pmSlot.sessionId) return pmSlot.sessionId;
    return null;
  }

  function connectedOperationalProjectManagerSession() {
    const sessionId = connectedProjectManagerSessionId();
    if (!sessionId) return null;
    const session = (dashboard.agents || []).find((agent) => agent.sessionId === sessionId);
    if (!session) return null;
    if (session.operationalStatus === 'error') return null;
    if (session.attentionRequired || session.status === 'attention') return null;
    return session;
  }

  function connectedQueueableProjectManagerSession() {
    const sessionId = connectedProjectManagerSessionId();
    if (!sessionId) return null;
    const session = (dashboard.agents || []).find((agent) => agent.sessionId === sessionId);
    if (!session) return null;
    if (session.operationalStatus === 'error') return null;
    if (session.attentionRequired || session.status === 'attention') return null;
    return session;
  }

  function openNewTaskDialog() {
    const pmSlot = connectedBySlot['pm-slot'];
    const rawSession = pmSlot?.sessionId
      ? (dashboard.agents || []).find((agent) => agent.sessionId === pmSlot.sessionId)
      : null;
    if (!connectedQueueableProjectManagerSession()) {
      const error = rawSession?.operationalError || rawSession?.note || 'Cannot create a new task because no Project Manager is connected.';
      if (rawSession?.operationalStatus === 'error') {
        setDashboardMessage(`Cannot create a new task because the Project Manager is not operational. ${error}`);
        return;
      }
      setDashboardMessage('Cannot create a new task because no Project Manager is connected.');
      return;
    }
    setNewTaskOpen(true);
  }

  async function createTaskWithProjectManager(payload: {
    text: string;
    attachments: Array<{ token: string; path: string }>;
    sourceElement: HTMLElement;
  }) {
    const pmSession = connectedQueueableProjectManagerSession();
    const sessionId = pmSession?.sessionId || null;
    if (!sessionId) {
      setDashboardMessage('Cannot create a new task because no Project Manager is connected.');
      return;
    }

    const pmSlot = document.querySelector<HTMLElement>('.project-manager-slot');
    if (pmSlot) {
      addPaperFlight(payload.sourceElement.getBoundingClientRect(), pmSlot.getBoundingClientRect());
    }

    setNewTaskOpen(false);
    setBots((current) => current.map((bot) => (
      bot.slotId === 'pm-slot' ? { ...bot, terminalExpanded: true } : bot
    )));

    try {
      const result = await enqueueProjectManagerTaskRequest({
        text: payload.text,
        attachments: payload.attachments,
      });
      setDashboardMessage(result.message || 'New task request queued for Project Manager.');
    } catch (error) {
      setDashboardMessage(error instanceof Error ? error.message : 'Could not queue task request for Project Manager.');
    }
  }

  function findConnectedSeniorProBot() {
    for (const bot of bots) {
      if (bot.role !== 'SP' || !bot.slotId || !bot.activated) continue;
      const session = sessionForBot(bot, dashboard.agents || []);
      if (session?.sessionId) return { bot, session };
    }
    return null;
  }

  async function openSeniorProConsoleWithPrompt(task: QueueTask, prompt: string) {
    const target = findConnectedSeniorProBot();
    const sessionId = target?.session.sessionId || null;
    if (!target || !sessionId) {
      setReviewerDialogOpen(true);
      return;
    }

    windows.focusMainWindow();
    setBots((current) => current.map((bot) => (
      bot.id === target.bot.id ? { ...bot, terminalExpanded: true } : bot
    )));

    try {
      const result = await messageAgentSession(sessionId, prompt);
      setDashboardMessage(result.message || `Sent ${task.id} to Senior Pro.`);
    } catch (error) {
      setDashboardMessage(error instanceof Error ? error.message : `Could not message Senior Pro about ${task.id}.`);
    }
  }

  function askSeniorProHowToTest(task: QueueTask) {
    void openSeniorProConsoleWithPrompt(
      task,
      `Please explain briefly how to test task ${task.id} - ${task.title}. Focus on concrete validation steps and expected results.`,
    );
  }

  function discussTaskWithSeniorPro(task: QueueTask) {
    void openSeniorProConsoleWithPrompt(
      task,
      `Let's discuss about task ${task.id} - ${task.title}. Give me concise context, current status, risks, and what decision you need from me.`,
    );
  }

  function openAgentAttention(botId: string) {
    windows.closeSecretary();
    windows.focusMainWindow();
    setBots((current) => current.map((bot) => (
      bot.id === botId ? { ...bot, terminalExpanded: true } : bot
    )));
  }

  async function changeAttentionAgentModel(botId: string) {
    const bot = bots.find((item) => item.id === botId);
    if (!bot) {
      setDashboardMessage('Could not find the cartridge to edit.');
      return;
    }

    windows.closeSecretary();
    windows.focusMainWindow();

    const session = sessionForBot(bot, dashboard.agents || []);
    if (session?.sessionId) {
      try {
        await closeAgentSession(session.sessionId);
      } catch (error) {
        setDashboardMessage(error instanceof Error ? error.message : 'Could not close the agent session before editing.');
      }
    }

    setSpotlightBotId(botId);
    window.setTimeout(() => {
      const centeredPosition = centeredBotPosition();
      setBots((current) => current.map((item) => (
        item.id === botId
          ? {
            ...item,
            ...centeredPosition,
            sessionId: null,
            slotId: null,
            activated: false,
            status: 'idle',
            terminalExpanded: false,
            terminalX: 0,
            terminalY: 0,
          }
          : item
      )));
    }, 20);

    window.setTimeout(() => {
      setCartridgeEditRequests((current) => ({ ...current, [botId]: Date.now() }));
    }, 360);

    window.setTimeout(() => {
      const secretaryButton = document.querySelector<HTMLElement>('.secretary-button');
      const cartridge = document.querySelector<HTMLElement>(`.bot-cartridge[data-bot-id="${CSS.escape(botId)}"]`);
      const editTarget = cartridge?.querySelector<HTMLElement>('.cartridge-options') || cartridge;
      if (secretaryButton && editTarget) {
        addSecretaryGuide(secretaryButton.getBoundingClientRect(), editTarget.getBoundingClientRect());
      }
    }, 440);

    window.setTimeout(() => {
      setSpotlightBotId((current) => (current === botId ? null : current));
    }, 1400);
  }

  return (
    <main className="dashboard-shell" aria-label="Agent Coordination Dashboard" style={socketThemeStyle}>
      <ThemeBackgroundLayer themeId={dashboardThemes.selectedThemeId} />
      <OptionsMenu
        open={windows.optionsOpen}
        closing={windows.optionsClosing}
        themes={dashboardThemes.themes}
        selectedThemeId={dashboardThemes.selectedThemeId}
        themeStatus={dashboardThemes.status}
        onOpen={windows.openOptions}
        onClose={windows.closeOptions}
        onSelectTheme={dashboardThemes.selectTheme}
        onCloseApp={desktopApi?.isDesktop ? requestCloseApplication : undefined}
      />
      {closeAppDialogOpen ? (
        <CloseApplicationDialog
          busy={closingApp}
          liveAgentCount={liveAgentCount}
          onCancel={() => {
            if (!closingApp) setCloseAppDialogOpen(false);
          }}
          onCloseAppOnly={() => void closeApplication(false)}
          onCloseAppAndAgents={() => void closeApplication(true)}
        />
      ) : null}
      {memoryCleanTargetId && bots.find((bot) => bot.id === memoryCleanTargetId) ? (
        <CleanMemoryDialog
          agentName={bots.find((bot) => bot.id === memoryCleanTargetId)?.name || 'this agent'}
          busy={memoryCleanBusy}
          error={memoryCleanError}
          onCancel={() => {
            if (!memoryCleanBusy) {
              setMemoryCleanTargetId(null);
              setMemoryCleanError(null);
            }
          }}
          onConfirm={() => void confirmCleanMemory()}
        />
      ) : null}
      {linkedEditTargetId ? (
        <BreakTheLinkPrompt
          busy={linkedEditBusy}
          error={linkedEditError}
          onCancel={() => {
            if (!linkedEditBusy) {
              setLinkedEditTargetId(null);
              setLinkedEditError(null);
            }
          }}
          onConfirm={() => void confirmLinkedCartridgeEdit()}
        />
      ) : null}
      {blueprintEdit?.runningInstances.length ? (
        <RunningInstancesPrompt
          instances={blueprintEdit.runningInstances}
          busy={blueprintEdit.busy}
          error={blueprintEdit.error}
          onUnlinkThem={() => void applyPendingBlueprintEdit('unlink')}
          onStopThem={() => void applyPendingBlueprintEdit('stop')}
          onCancel={() => {
            if (!blueprintEdit.busy) {
              setBlueprintEdit((current) => (
                current ? { ...current, runningInstances: [], error: null } : current
              ));
            }
          }}
        />
      ) : blueprintEdit ? (
        <BlueprintEditPrompt
          draft={blueprintEdit.draft}
          busy={blueprintEdit.busy}
          error={blueprintEdit.error}
          onChange={(draft) => setBlueprintEdit((current) => (
            current ? { ...current, draft, error: null } : current
          ))}
          onSubmit={() => void submitBlueprintEdit()}
          onCancel={() => {
            if (!blueprintEdit.busy) setBlueprintEdit(null);
          }}
        />
      ) : null}
      {blueprintDelete ? (
        <DeleteBlueprintPrompt
          instanceCount={blueprintDelete.instanceCount}
          busy={blueprintDelete.busy}
          error={blueprintDelete.error}
          onConfirm={() => void confirmBlueprintDelete()}
          onCancel={() => {
            if (!blueprintDelete.busy) setBlueprintDelete(null);
          }}
        />
      ) : null}
      <TelemetryPalette
        open={telemetryOpen}
        busy={telemetryBusy}
        telemetry={telemetry}
        error={telemetryError}
        onClose={() => setTelemetryOpen(false)}
        onRefresh={refreshTelemetry}
        onReset={clearTelemetry}
      />
      {desktopApi?.isDesktop ? <div className="desktop-drag-region" aria-hidden="true" /> : null}
      <aside className="auto-mode-control" aria-label="Automatic mode">
        <AutoModeToggle enabled={autoMode} onToggle={toggleAutoMode} />
      </aside>
      <aside className="secretary-task-control" aria-label="Secretary">
        <SecretaryButton message={secretaryMessage} notificationCount={secretaryNotificationCount} onOpen={windows.openSecretary} />
      </aside>
      {windows.secretaryOpen ? (
        <SecretaryPanel
          reviewTasks={dashboard.pmReviewQueue || []}
          maintenanceNotifications={dashboard.maintenanceNotifications || []}
          agentAttentionNotifications={agentAttentionNotifications}
          inboxItems={dashboard.secretaryInbox?.items || []}
          closing={windows.secretaryClosing}
          onClose={windows.closeSecretary}
          onHowToTest={askSeniorProHowToTest}
          onDiscussWithSenior={discussTaskWithSeniorPro}
          onOpenAgentAttention={openAgentAttention}
          onChangeAgentModel={changeAttentionAgentModel}
          onMessage={setDashboardMessage}
        />
      ) : null}
      {openCodeMissingNotification && !openCodeMissingDismissed ? (
        <OpenCodeMissingDialog
          notification={openCodeMissingNotification}
          onClose={() => setOpenCodeMissingDismissed(true)}
          onMessage={setDashboardMessage}
        />
      ) : null}
      {reviewerDialogOpen ? <ReviewerUnavailableDialog onClose={() => setReviewerDialogOpen(false)} /> : null}
      {windows.builderOpen ? (
        <div
          className={`builder-overlay ${windows.builderClosing ? 'builder-overlay-closing' : ''}`}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) windows.closeBuilder();
          }}
        >
          <BotBuilderScreen closing={windows.builderClosing} onClose={windows.closeBuilder} onCreate={createBot} />
        </div>
      ) : null}
      {newTaskOpen && connectedOperationalProjectManagerSession() ? (
        <NewTaskDialog
          projectManagerSessionId={connectedOperationalProjectManagerSession()?.sessionId || ''}
          onClose={() => setNewTaskOpen(false)}
          onCreate={createTaskWithProjectManager}
          onMessage={setDashboardMessage}
        />
      ) : null}
      <PaperFlightLayer flights={paperFlights} />
      <SecretaryGuideLayer guides={secretaryGuides} />
      <div className="top-dock" aria-label="Agent dock">
        <AgentSlots
          connectedBySlot={connectedBySlot}
          onActivate={activateSlot}
          onEject={ejectSlot}
          onFocus={focusSlotSession}
        />
        <div className="builder-control-stack">
          <BotBuilderButton themeId={dashboardThemes.selectedThemeId} onOpen={windows.openBuilder} />
          <BlueprintTray
            themeId={dashboardThemes.selectedThemeId}
            blueprints={dashboard.blueprints || []}
            usedBlueprintIds={usedBlueprintIds}
            renderBlueprint={renderTrayBlueprint}
            onInstance={instanceBlueprint}
            onReorder={reorderTray}
            onBlueprintHover={setHoveredBlueprintId}
            onEditBlueprint={requestBlueprintEdit}
            onDeleteBlueprint={(blueprintId) => void requestBlueprintDelete(blueprintId)}
            incomingBlueprint={blueprintIntake}
            onIntakeSettled={(blueprintId) => {
              setBlueprintIntake((current) => (
                current?.blueprint.id === blueprintId
                  ? { ...current, animationDone: true }
                  : current
              ));
            }}
          />
        </div>
      </div>
      <div className="leadership-dock" aria-label="Leadership docks">
        <SeniorProSlot
          connected={connectedBySlot['sp-slot']}
          onActivate={activateSlot}
          onEject={ejectSlot}
          onFocus={focusSlotSession}
        />
        <div className="pm-control-row">
          <ProjectManagerSlot
            connected={connectedBySlot['pm-slot']}
            onActivate={activateSlot}
            onEject={ejectSlot}
            onFocus={focusSlotSession}
            onNewTask={openNewTaskDialog}
          />
        </div>
      </div>
      <BlueprintInstanceLine
        blueprintId={hoveredBlueprintId}
        dashboard={dashboard}
        themeId={dashboardThemes.selectedThemeId}
      />

      <TaskSlidePanels
        dashboard={dashboard}
        projectManagerBusy={projectManagerBusy}
        openPanel={windows.taskPanelOpen}
        closing={windows.taskPanelClosing}
        onOpenPanel={windows.openTaskPanel}
        onClosePanel={windows.closeTaskPanel}
        onMessage={setDashboardMessage}
        onPromoteNextTodo={promoteNextTodoLocally}
        themeId={dashboardThemes.selectedThemeId}
      />
      <section className="cartridge-layer" aria-label="Created bot cartridges">
        {bots.filter((bot) => bot.id !== blueprintIntake?.sourceCartridgeId).map((bot) => {
          const session = bot.slotId && bot.activated ? sessionForBot(bot, dashboard.agents || []) : undefined;
          return (
            <BotCartridge
              key={bot.id}
              themeId={dashboardThemes.selectedThemeId}
              linked={Boolean((dashboard.cartridges || []).find((entry) => entry.id === bot.id)?.linked)}
              onDuplicate={duplicateCartridgeById}
              onUnlink={unlinkCartridgeById}
              onEditRequest={requestCartridgeEdit}
              onSaveAsBlueprint={(id) => {
                const target = bots.find((item) => item.id === id);
                if (target) void saveCartridgeAsBlueprint(target);
              }}
              bot={{
                ...bot,
                sessionId: session?.sessionId || bot.sessionId || null,
                status: runtimeStatusForBot(bot, dashboard.agents || [], readyBotIds.has(bot.id)),
              }}
              spotlight={spotlightBotId === bot.id}
              session={session}
              onMessage={setDashboardMessage}
              onMove={moveBot}
              onDrop={connectBotIfNearSlot}
              onUpdate={updateBot}
              onDestroy={destroyBot}
              onCleanMemory={(id) => {
                setMemoryCleanError(null);
                setMemoryCleanTargetId(id);
              }}
              onRunNext={runNextForSlot}
              onSetTerminalExpanded={setTerminalExpanded}
              onMoveTerminal={moveTerminal}
              onResizeTerminal={resizeTerminal}
              onChangeTerminalFontSize={changeTerminalFontSize}
              onMoveTerminalLayer={moveTerminalLayer}
              editRequestKey={cartridgeEditRequests[bot.id]}
              hasClaimableTasks={readyBotIds.has(bot.id)}
              hasRunnableTask={sessionHasRunnableAssignedTask(session)}
            />
          );
        })}
      </section>
    </main>
  );
}

export function App() {
  const [projectRoot, setProjectRoot] = useState<string | null>(null);

  if (!projectRoot) {
    return (
      <StartWindow
        onProjectOpened={(root) => {
          window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, root);
          setProjectRoot(root);
        }}
      />
    );
  }

  return <DashboardApp key={projectRoot} projectRoot={projectRoot} />;
}
