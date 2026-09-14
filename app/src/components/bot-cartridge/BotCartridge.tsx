import { useState } from 'react';
import { answerAgentAttention } from '../../api';
import './BotCartridge.css';
import { useCartridgeDrag } from './hooks/useCartridgeDrag';
import { useCartridgeEditor } from './hooks/useCartridgeEditor';
import { usePromptComposer } from './hooks/usePromptComposer';
import { useTerminalDragResize } from './hooks/useTerminalDragResize';
import { useTerminalGeometry } from './hooks/useTerminalGeometry';
import { useTerminalScroll } from './hooks/useTerminalScroll';
import { CartridgeContacts } from './parts/CartridgeContacts';
import { CartridgeFrame } from './parts/CartridgeFrame';
import { CartridgeLabel } from './parts/CartridgeLabel';
import { CartridgeNotch } from './parts/CartridgeNotch';
import { CartridgeOptions } from './parts/CartridgeOptions';
import { useMenuPlacement } from './hooks/useMenuPlacement';
import { CartridgeThemeCover } from './parts/CartridgeThemeCover';
import { FakeTerminal } from './parts/FakeTerminal';
import { TerminalTether } from './parts/TerminalTether';
import type { BotCartridgeProps } from './types';
import { getThemeCartridgeComposition } from '../../themes/cartridgeCompositions';
import { cartridgeCompositionToStyle } from '../../themes/cartridgeCompositionTypes';

function contactClassForRole(role: string) {
  if (role === 'PM') return 'cartridge-contacts-bottom';
  if (role === 'SP') return 'cartridge-contacts-left';
  return 'cartridge-contacts-top';
}

export function BotCartridge({
  bot,
  linked,
  onDuplicate,
  onUnlink,
  onEditRequest,
  onSaveAsBlueprint,
  session,
  onMessage,
  onMove,
  onDrop,
  onUpdate,
  onDestroy,
  onCleanMemory,
  onRunNext,
  onSetTerminalExpanded,
  onMoveTerminal,
  onResizeTerminal,
  onChangeTerminalFontSize,
  onMoveTerminalLayer,
  themeId,
  editRequestKey,
  spotlight = false,
  hasClaimableTasks = false,
  hasRunnableTask = false,
  preview = false,
}: BotCartridgeProps) {
  const [attentionAnswer, setAttentionAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const isProjectManager = bot.role === 'PM';
  const isActivated = Boolean(bot.slotId && bot.activated);
  const isConnected = Boolean(bot.slotId);
  const status = bot.status || 'idle';
  const cartridgeComposition = getThemeCartridgeComposition(themeId);
  const cartridgeThemeStyle = cartridgeCompositionToStyle(cartridgeComposition, bot.role, isConnected);
  const sessionId = session?.sessionId || bot.sessionId || null;
  const messages = session?.sessionConsole?.messages || [];
  const geometry = useTerminalGeometry(bot);
  const { consoleRef, updateStickToBottom } = useTerminalScroll({
    expanded: Boolean(bot.terminalExpanded),
    sessionId,
    messages,
  });
  const editor = useCartridgeEditor({ bot, editRequestKey, onUpdate });

  function runAction(action: () => Promise<{ message?: string }>, fallback: string) {
    setBusy(true);
    action()
      .then((result) => onMessage(result.message || fallback))
      .catch((error) => onMessage(error instanceof Error ? error.message : 'Action failed.'))
      .finally(() => setBusy(false));
  }

  const promptComposer = usePromptComposer({
    sessionId,
    busy,
    runAction,
    onMessage,
    setBusy,
  });

  const dragHandlers = useCartridgeDrag({
    bot,
    disabled: isActivated,
    onMove,
    onDrop,
    onClick: () => editor.setMenuOpen(true),
    onDragStart: () => editor.setMenuOpen(false),
  });

  const { terminalDragHandlers, terminalResizeHandlers } = useTerminalDragResize({
    botId: bot.id,
    terminalX: geometry.terminalX,
    terminalY: geometry.terminalY,
    terminalWidth: geometry.terminalWidth,
    terminalHeight: geometry.terminalHeight,
    onMoveTerminal,
    onResizeTerminal,
  });

  function sendAttentionAnswer(answer: string) {
    const text = answer.trim();
    if (!text || !sessionId) return;
    setAttentionAnswer('');
    runAction(() => answerAgentAttention(sessionId, text), 'Answer sent.');
  }

  const menuIsOpen = editor.menuOpen && (!isActivated || editor.editing);
  const menu = useMenuPlacement(menuIsOpen);

  if (preview) {
    return (
      <article
        className={`bot-cartridge bot-cartridge-preview cartridge-status-${status} ${contactClassForRole(bot.role)}`}
        data-bot-id={bot.id}
        style={cartridgeThemeStyle}
        aria-label={`${bot.name} blueprint cartridge`}
      >
        <CartridgeFrame />
        <CartridgeThemeCover />
        {!isProjectManager ? <CartridgeContacts /> : null}
        <CartridgeLabel role={bot.role} name={bot.name} model={bot.model} status={status} />
        <CartridgeNotch
          active={false}
          slotId={null}
          hasClaimableTasks={false}
          hasRunnableTask={false}
          onRunNext={onRunNext}
        />
        {isProjectManager ? <CartridgeContacts /> : null}
      </article>
    );
  }

  return (
    <article
      className={`bot-cartridge cartridge-status-${status} ${contactClassForRole(bot.role)} ${bot.slotId ? 'bot-cartridge-connected' : ''} ${isActivated ? 'bot-cartridge-activated' : ''} ${bot.terminalExpanded ? 'bot-cartridge-terminal-expanded' : ''} ${editor.menuOpen ? 'bot-cartridge-menu-open' : ''} ${editor.editing ? 'bot-cartridge-editing' : ''} ${spotlight ? 'bot-cartridge-spotlight' : ''}`}
      ref={menu.anchorRef as React.RefObject<HTMLElement>}
      data-bot-id={bot.id}
      style={{
        ...cartridgeThemeStyle,
        transform: `translate(${bot.x}px, ${bot.y}px)`,
        zIndex: bot.terminalExpanded ? geometry.terminalLayer : undefined,
      }}
      {...dragHandlers}
      aria-label={`${bot.name} bot cartridge`}
    >
      <CartridgeFrame />
      <CartridgeThemeCover />
      {!isProjectManager ? <CartridgeContacts /> : null}
      <CartridgeLabel role={bot.role} name={bot.name} model={bot.model} status={status} />
      <CartridgeNotch
        active={isActivated}
        slotId={bot.slotId}
        hasClaimableTasks={hasClaimableTasks}
        hasRunnableTask={hasRunnableTask}
        onRunNext={onRunNext}
      />
      {isProjectManager ? <CartridgeContacts /> : null}

      {menuIsOpen ? (
        <CartridgeOptions
          botId={bot.id}
          linked={linked}
          onDuplicate={onDuplicate}
          onUnlink={onUnlink}
          onEditRequest={() => {
            if (linked && onEditRequest) {
              editor.setMenuOpen(false);
              onEditRequest(bot.id);
              return;
            }
            editor.setEditing(true);
          }}
          onSaveAsBlueprint={onSaveAsBlueprint}
          editing={editor.editing}
          draft={editor.draft}
          modelOptions={editor.modelOptions}
          setDraft={editor.setDraft}
          setEditing={editor.setEditing}
          setMenuOpen={editor.setMenuOpen}
          onDestroy={onDestroy}
          onCleanMemory={onCleanMemory}
          onSave={editor.saveEdit}
          menuRef={menu.menuRef}
          placement={menu.placement}
        />
      ) : null}

      {isActivated ? (
        <>
          {bot.terminalExpanded ? (
            <TerminalTether
              originX={geometry.terminalOriginX}
              originY={geometry.terminalOriginY}
              lineLength={geometry.lineLength}
              lineAngle={geometry.lineAngle}
              onMinimize={() => onSetTerminalExpanded(bot.id, false)}
            />
          ) : null}
          <FakeTerminal
            bot={bot}
            session={session}
            sessionId={sessionId}
            messages={messages}
            geometry={geometry}
            busy={busy}
            prompt={promptComposer.prompt}
            canSendPrompt={promptComposer.canSendPrompt}
            attentionAnswer={attentionAnswer}
            consoleRef={consoleRef}
            onSetTerminalExpanded={onSetTerminalExpanded}
            onChangeTerminalFontSize={onChangeTerminalFontSize}
            onMoveTerminalLayer={onMoveTerminalLayer}
            onPromptChange={promptComposer.setPrompt}
            onPromptPaste={promptComposer.handlePromptPaste}
            onPromptSubmit={promptComposer.sendPrompt}
            onConsoleScroll={updateStickToBottom}
            onAttentionAnswerChange={setAttentionAnswer}
            onAnswerAttention={sendAttentionAnswer}
            terminalDragHandlers={terminalDragHandlers}
            terminalResizeHandlers={terminalResizeHandlers}
          />
        </>
      ) : null}
    </article>
  );
}
