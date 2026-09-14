import { useRef, type PointerEvent } from 'react';
import type { BotCartridgeData } from '../../../types/bot';
import { createPointerDragController } from '../../../drag/pointerDrag';

interface UseCartridgeDragArgs {
  bot: BotCartridgeData;
  disabled: boolean;
  onMove: (id: string, position: { x: number; y: number }) => void;
  /** The drop point matters: the tray and a slot are two targets that compete. */
  onDrop: (id: string, at: { x: number; y: number }) => void;
  onClick: () => void;
  onDragStart?: () => void;
}

export function useCartridgeDrag({ bot, disabled, onMove, onDrop, onClick, onDragStart }: UseCartridgeDragArgs) {
  const dragOffset = useRef({ x: 0, y: 0 });
  const current = useRef({ bot, disabled, onMove, onDrop, onClick, onDragStart });
  current.current = { bot, disabled, onMove, onDrop, onClick, onDragStart };
  const controller = useRef(createPointerDragController<string>({
    disabled: () => current.current.disabled,
    onPrepare: (_, point) => {
      dragOffset.current = {
        x: point.x - current.current.bot.x,
        y: point.y - current.current.bot.y,
      };
    },
    onDragStart: () => current.current.onDragStart?.(),
    onDragMove: (id, point) => {
      current.current.onMove(id, {
        x: point.x - dragOffset.current.x,
        y: point.y - dragOffset.current.y,
      });
    },
    onDrop: (id, point) => current.current.onDrop(id, point),
    onClick: () => current.current.onClick(),
  }));

  function startDrag(event: PointerEvent<HTMLElement>) {
    controller.current.begin(event, bot.id);
  }

  function drag(event: PointerEvent<HTMLElement>) {
    controller.current.move(event);
  }

  function stopDrag(event: PointerEvent<HTMLElement>) {
    controller.current.finish(event);
  }

  return {
    onPointerDown: startDrag,
    onPointerMove: drag,
    onPointerUp: stopDrag,
    onPointerCancel: stopDrag,
  };
}
