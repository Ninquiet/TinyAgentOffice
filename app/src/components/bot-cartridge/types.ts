import type { BotCartridgeData, BotDraft } from '../../types/bot';
import type { AgentSession } from '../../types';

export interface BotCartridgeProps {
  bot: BotCartridgeData;
  session?: AgentSession;
  onMessage: (message: string) => void;
  onMove: (id: string, position: { x: number; y: number }) => void;
  onDrop: (id: string) => void;
  onUpdate: (id: string, patch: Partial<BotDraft>) => void;
  onDestroy: (id: string) => void;
  onCleanMemory?: (id: string) => void;
  /** Follows a blueprint. Decides what the options menu offers (Q6). */
  linked?: boolean;
  onDuplicate?: (id: string) => void;
  onUnlink?: (id: string) => void;
  onEditRequest?: (id: string) => void;
  onSaveAsBlueprint?: (id: string) => void;
  onRunNext: (slotId: string) => void;
  onSetTerminalExpanded: (id: string, expanded: boolean) => void;
  onMoveTerminal: (id: string, position: { x: number; y: number }) => void;
  onResizeTerminal: (id: string, size: { width: number; height: number }) => void;
  onChangeTerminalFontSize: (id: string, delta: number) => void;
  onMoveTerminalLayer: (id: string, direction: 'up' | 'down') => void;
  themeId: string;
  editRequestKey?: number;
  spotlight?: boolean;
  hasClaimableTasks?: boolean;
  hasRunnableTask?: boolean;
  preview?: boolean;
}

export interface PromptAttachment {
  token: string;
  path: string;
  name: string;
  mimeType: string;
}

export interface TerminalGeometry {
  terminalX: number;
  terminalY: number;
  terminalWidth: number;
  terminalHeight: number;
  terminalFontSize: number;
  terminalLayer: number;
  terminalOriginX: number;
  terminalOriginY: number;
  lineLength: number;
  lineAngle: number;
}
