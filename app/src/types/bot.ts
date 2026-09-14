export interface BotDraft {
  name: string;
  role: string;
  model: string;
  adapter?: string;
  startupInstructions?: string;
}

export type BotRuntimeStatus =
  | 'idle'
  | 'has-tasks'
  | 'working'
  | 'attention'
  | 'stalled';

export interface BotCartridgeData extends BotDraft {
  id: string;
  x: number;
  y: number;
  cli?: string;
  sessionId?: string | null;
  slotId?: string | null;
  activated?: boolean;
  status?: BotRuntimeStatus;
  terminalExpanded?: boolean;
  terminalX?: number;
  terminalY?: number;
  terminalWidth?: number;
  terminalHeight?: number;
  terminalFontSize?: number;
  terminalLayer?: number;
}
