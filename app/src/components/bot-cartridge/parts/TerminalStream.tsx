import type { RefObject } from 'react';
import type { ConsoleMessage, ConsoleState } from '../../../types';
import { roleClass } from '../utils';

interface TerminalStreamProps {
  sessionId: string | null;
  consoleState?: ConsoleState;
  messages: ConsoleMessage[];
  consoleRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  compact?: boolean;
}

export function TerminalStream({ sessionId, consoleState, messages, consoleRef, onScroll, compact = false }: TerminalStreamProps) {
  const visibleMessages = compact && messages.length > 0
    ? [messages[messages.length - 1]]
    : messages;

  return (
    <div className={`fake-terminal-stream ${compact ? 'fake-terminal-stream-compact' : ''}`} ref={consoleRef} onScroll={onScroll}>
      {consoleState ? (
        visibleMessages.length > 0 ? visibleMessages.map((entry, index) => (
          <div className={`fake-console-message role-${roleClass(entry.role)}`} key={`${entry.id || index}:${entry.role}`}>
            <span>{entry.role}</span>
            <pre>{entry.preview}</pre>
          </div>
        )) : <p className="terminal-muted">No session messages available yet.</p>
      ) : (
        <p className="terminal-muted">
          {sessionId ? 'Waiting for live console stream...' : 'Launch this cartridge to open a live agent session.'}
        </p>
      )}
    </div>
  );
}
