import type { ClipboardEventHandler, CSSProperties, FormEventHandler, PointerEventHandler, RefObject } from 'react';
import type { AgentSession, ConsoleMessage } from '../../../types';
import type { BotCartridgeData } from '../../../types/bot';
import type { TerminalGeometry } from '../types';
import { AttentionBox } from './AttentionBox';
import { TerminalComposer } from './TerminalComposer';
import { TerminalHeader } from './TerminalHeader';
import { TerminalStream } from './TerminalStream';

interface FakeTerminalProps {
  bot: BotCartridgeData;
  session?: AgentSession;
  sessionId: string | null;
  messages: ConsoleMessage[];
  geometry: TerminalGeometry;
  busy: boolean;
  prompt: string;
  canSendPrompt: boolean;
  attentionAnswer: string;
  consoleRef: RefObject<HTMLDivElement | null>;
  onSetTerminalExpanded: (id: string, expanded: boolean) => void;
  onChangeTerminalFontSize: (id: string, delta: number) => void;
  onMoveTerminalLayer: (id: string, direction: 'up' | 'down') => void;
  onPromptChange: (value: string) => void;
  onPromptPaste: ClipboardEventHandler<HTMLInputElement>;
  onPromptSubmit: FormEventHandler;
  onConsoleScroll: () => void;
  onAttentionAnswerChange: (answer: string) => void;
  onAnswerAttention: (answer: string) => void;
  terminalDragHandlers: {
    onPointerDown: PointerEventHandler<HTMLElement>;
    onPointerMove: PointerEventHandler<HTMLElement>;
    onPointerUp: PointerEventHandler<HTMLElement>;
    onPointerCancel: PointerEventHandler<HTMLElement>;
  };
  terminalResizeHandlers: {
    onPointerDown: PointerEventHandler<HTMLElement>;
    onPointerMove: PointerEventHandler<HTMLElement>;
    onPointerUp: PointerEventHandler<HTMLElement>;
    onPointerCancel: PointerEventHandler<HTMLElement>;
  };
}

export function FakeTerminal({
  bot,
  session,
  sessionId,
  messages,
  geometry,
  busy,
  prompt,
  canSendPrompt,
  attentionAnswer,
  consoleRef,
  onSetTerminalExpanded,
  onChangeTerminalFontSize,
  onMoveTerminalLayer,
  onPromptChange,
  onPromptPaste,
  onPromptSubmit,
  onConsoleScroll,
  onAttentionAnswerChange,
  onAnswerAttention,
  terminalDragHandlers,
  terminalResizeHandlers,
}: FakeTerminalProps) {
  const isProjectManager = bot.role === 'PM';
  const isSeniorPro = bot.role === 'SP';
  const expanded = Boolean(bot.terminalExpanded);
  const roleClassName = `terminal-role-${bot.role.toLowerCase()}`;

  return (
    <aside
      className={`fake-terminal ${roleClassName} ${isProjectManager ? 'fake-terminal-project-manager' : ''} ${isSeniorPro ? 'fake-terminal-senior-pro' : ''} ${expanded ? 'fake-terminal-expanded' : 'fake-terminal-docked'}`}
      style={expanded ? {
        '--terminal-x': `${geometry.terminalX}px`,
        '--terminal-y': `${geometry.terminalY}px`,
        '--terminal-width': `${geometry.terminalWidth}px`,
        '--terminal-height': `${geometry.terminalHeight}px`,
        '--terminal-font-size': `${geometry.terminalFontSize}px`,
      } as CSSProperties : undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => {
        if (!expanded) onSetTerminalExpanded(bot.id, true);
      }}
    >
      <TerminalHeader
        botId={bot.id}
        name={bot.name}
        expanded={expanded}
        dragHandlers={terminalDragHandlers}
        onChangeFontSize={onChangeTerminalFontSize}
        onMoveLayer={onMoveTerminalLayer}
        onMinimize={() => onSetTerminalExpanded(bot.id, false)}
      />

      {session?.attentionRequest ? (
        <AttentionBox
          attentionRequest={session.attentionRequest}
          expanded={expanded}
          sessionId={sessionId}
          busy={busy}
          attentionAnswer={attentionAnswer}
          setAttentionAnswer={onAttentionAnswerChange}
          onAnswer={onAnswerAttention}
        />
      ) : null}

      <TerminalStream
        sessionId={sessionId}
        consoleState={session?.sessionConsole}
        messages={messages}
        consoleRef={consoleRef}
        onScroll={onConsoleScroll}
        compact={!expanded}
      />

      {expanded ? (
        <>
          <TerminalComposer
            sessionId={sessionId}
            busy={busy}
            prompt={prompt}
            canSendPrompt={canSendPrompt}
            onPromptChange={onPromptChange}
            onPaste={onPromptPaste}
            onSubmit={onPromptSubmit}
          />
          <div
            className="fake-terminal-resize-handle"
            role="separator"
            aria-label="Resize terminal"
            {...terminalResizeHandlers}
          />
        </>
      ) : null}
    </aside>
  );
}
