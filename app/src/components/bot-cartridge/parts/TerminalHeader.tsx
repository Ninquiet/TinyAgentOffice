import type { PointerEventHandler } from 'react';

interface TerminalHeaderProps {
  botId: string;
  name: string;
  expanded: boolean;
  dragHandlers?: {
    onPointerDown: PointerEventHandler<HTMLElement>;
    onPointerMove: PointerEventHandler<HTMLElement>;
    onPointerUp: PointerEventHandler<HTMLElement>;
    onPointerCancel: PointerEventHandler<HTMLElement>;
  };
  onChangeFontSize: (id: string, delta: number) => void;
  onMoveLayer: (id: string, direction: 'up' | 'down') => void;
  onMinimize: () => void;
}

export function TerminalHeader({
  botId,
  name,
  expanded,
  dragHandlers,
  onChangeFontSize,
  onMoveLayer,
  onMinimize,
}: TerminalHeaderProps) {
  return (
    <header {...(expanded ? dragHandlers : undefined)}>
      <span>{name} terminal</span>
      {expanded ? (
        <div className="fake-terminal-header-actions">
          <button
            type="button"
            aria-label="Decrease terminal font size"
            title="Decrease font"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onChangeFontSize(botId, -1);
            }}
          >
            -
          </button>
          <button
            type="button"
            aria-label="Increase terminal font size"
            title="Increase font"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onChangeFontSize(botId, 1);
            }}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Send terminal backward"
            title="Send backward"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onMoveLayer(botId, 'down');
            }}
          >
            ↓
          </button>
          <button
            type="button"
            aria-label="Bring terminal forward"
            title="Bring forward"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onMoveLayer(botId, 'up');
            }}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Minimize terminal"
            title="Minimize"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onMinimize();
            }}
          >
            -
          </button>
        </div>
      ) : null}
    </header>
  );
}
