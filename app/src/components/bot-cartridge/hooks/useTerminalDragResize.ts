import { useRef, type PointerEvent } from 'react';
import { TERMINAL_MIN_HEIGHT, TERMINAL_MIN_WIDTH } from '../constants';

interface UseTerminalDragResizeArgs {
  botId: string;
  terminalX: number;
  terminalY: number;
  terminalWidth: number;
  terminalHeight: number;
  onMoveTerminal: (id: string, position: { x: number; y: number }) => void;
  onResizeTerminal: (id: string, size: { width: number; height: number }) => void;
}

export function useTerminalDragResize({
  botId,
  terminalX,
  terminalY,
  terminalWidth,
  terminalHeight,
  onMoveTerminal,
  onResizeTerminal,
}: UseTerminalDragResizeArgs) {
  const terminalDragOffset = useRef({ x: 0, y: 0 });
  const terminalResizeStart = useRef({ x: 0, y: 0, width: TERMINAL_MIN_WIDTH, height: TERMINAL_MIN_HEIGHT });

  function startTerminalDrag(event: PointerEvent<HTMLElement>) {
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    terminalDragOffset.current = {
      x: event.clientX - terminalX,
      y: event.clientY - terminalY,
    };
  }

  function dragTerminal(event: PointerEvent<HTMLElement>) {
    event.stopPropagation();
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onMoveTerminal(botId, {
      x: event.clientX - terminalDragOffset.current.x,
      y: event.clientY - terminalDragOffset.current.y,
    });
  }

  function stopTerminalDrag(event: PointerEvent<HTMLElement>) {
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function startTerminalResize(event: PointerEvent<HTMLElement>) {
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    terminalResizeStart.current = {
      x: event.clientX,
      y: event.clientY,
      width: terminalWidth,
      height: terminalHeight,
    };
  }

  function resizeTerminal(event: PointerEvent<HTMLElement>) {
    event.stopPropagation();
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const start = terminalResizeStart.current;
    onResizeTerminal(botId, {
      width: start.width + event.clientX - start.x,
      height: start.height + event.clientY - start.y,
    });
  }

  function stopTerminalResize(event: PointerEvent<HTMLElement>) {
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return {
    terminalDragHandlers: {
      onPointerDown: startTerminalDrag,
      onPointerMove: dragTerminal,
      onPointerUp: stopTerminalDrag,
      onPointerCancel: stopTerminalDrag,
    },
    terminalResizeHandlers: {
      onPointerDown: startTerminalResize,
      onPointerMove: resizeTerminal,
      onPointerUp: stopTerminalResize,
      onPointerCancel: stopTerminalResize,
    },
  };
}
