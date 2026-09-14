export const CLICK_DRAG_THRESHOLD = 5;

export interface PointerDragEvent {
  pointerId: number;
  clientX: number;
  clientY: number;
  currentTarget: {
    setPointerCapture(pointerId: number): void;
    releasePointerCapture(pointerId: number): void;
    hasPointerCapture(pointerId: number): boolean;
  };
}

export interface PointerDragPoint {
  x: number;
  y: number;
}

interface PointerDragControllerOptions<TContext> {
  disabled?: () => boolean;
  onPrepare?: (context: TContext, point: PointerDragPoint) => void;
  onDragStart?: (context: TContext, point: PointerDragPoint) => void;
  onDragMove?: (context: TContext, point: PointerDragPoint) => void;
  onDrop?: (context: TContext, point: PointerDragPoint) => void;
  onClick?: (context: TContext, point: PointerDragPoint) => void;
}

export function createPointerDragController<TContext>({
  disabled = () => false,
  onPrepare,
  onDragStart,
  onDragMove,
  onDrop,
  onClick,
}: PointerDragControllerOptions<TContext>) {
  let context: TContext | null = null;
  let start: PointerDragPoint | null = null;
  let moved = false;

  function begin(event: PointerDragEvent, nextContext: TContext) {
    if (disabled()) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    context = nextContext;
    start = { x: event.clientX, y: event.clientY };
    moved = false;
    onPrepare?.(nextContext, start);
  }

  function move(event: PointerDragEvent) {
    if (disabled() || !context || !start) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;

    const point = { x: event.clientX, y: event.clientY };
    const distance = Math.hypot(point.x - start.x, point.y - start.y);
    if (!moved && distance <= CLICK_DRAG_THRESHOLD) return;
    if (!moved) {
      moved = true;
      onDragStart?.(context, point);
    }
    onDragMove?.(context, point);
  }

  function finish(event: PointerDragEvent) {
    if (disabled() || !context) return;
    const finalContext = context;
    const point = { x: event.clientX, y: event.clientY };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    context = null;
    start = null;

    if (moved) {
      onDrop?.(finalContext, point);
    } else {
      onClick?.(finalContext, point);
    }
    moved = false;
  }

  return { begin, move, finish };
}
