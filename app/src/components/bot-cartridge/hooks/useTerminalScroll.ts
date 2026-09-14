import { useLayoutEffect, useRef } from 'react';

export function useTerminalScroll(args: { expanded: boolean; sessionId: string | null; messages: Array<{ id?: string | null; preview?: string }> }) {
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const wasTerminalExpanded = useRef(false);
  const lastMessage = args.messages[args.messages.length - 1];
  const consoleScrollKey = `${args.messages.length}:${lastMessage?.id || ''}:${lastMessage?.preview || ''}`;

  function scrollConsoleToBottom() {
    const el = consoleRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function updateStickToBottom() {
    const el = consoleRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distanceFromBottom <= 8;
  }

  useLayoutEffect(() => {
    const justExpanded = args.expanded && !wasTerminalExpanded.current;
    wasTerminalExpanded.current = Boolean(args.expanded);

    if (justExpanded) {
      stickToBottom.current = true;
      window.requestAnimationFrame(scrollConsoleToBottom);
      return;
    }

    if (stickToBottom.current) {
      window.requestAnimationFrame(scrollConsoleToBottom);
    }
  }, [consoleScrollKey, args.expanded, args.sessionId]);

  return { consoleRef, updateStickToBottom };
}
