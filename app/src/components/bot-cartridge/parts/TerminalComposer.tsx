import type { ClipboardEventHandler, FormEventHandler } from 'react';

interface TerminalComposerProps {
  sessionId: string | null;
  busy: boolean;
  prompt: string;
  canSendPrompt: boolean;
  onPromptChange: (value: string) => void;
  onPaste: ClipboardEventHandler<HTMLInputElement>;
  onSubmit: FormEventHandler;
}

export function TerminalComposer({
  sessionId,
  busy,
  prompt,
  canSendPrompt,
  onPromptChange,
  onPaste,
  onSubmit,
}: TerminalComposerProps) {
  return (
    <form className="fake-terminal-composer" onSubmit={onSubmit} onPointerDown={(event) => event.stopPropagation()}>
      <input
        disabled={!sessionId || busy}
        value={prompt}
        placeholder={sessionId ? 'Message agent... paste image with Ctrl+V' : 'No live session'}
        onChange={(event) => onPromptChange(event.target.value)}
        onPaste={onPaste}
      />
      <button type="submit" disabled={!canSendPrompt}>
        Send
      </button>
    </form>
  );
}
