import { useState, type ClipboardEvent, type FormEvent } from 'react';
import { attachAgentImage, messageAgentSession } from '../../../api';
import type { PromptAttachment } from '../types';

interface UsePromptComposerArgs {
  sessionId: string | null;
  busy: boolean;
  runAction: (action: () => Promise<{ message?: string }>, fallback: string) => void;
  onMessage: (message: string) => void;
  setBusy: (busy: boolean) => void;
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read image.'));
    reader.readAsDataURL(file);
  });
}

export function usePromptComposer({ sessionId, busy, runAction, onMessage, setBusy }: UsePromptComposerArgs) {
  const [prompt, setPrompt] = useState('');
  const [promptAttachments, setPromptAttachments] = useState<PromptAttachment[]>([]);

  async function attachPastedImage(file: File) {
    if (!sessionId) {
      onMessage('Launch the cartridge before attaching images.');
      return;
    }
    const token = `[image${promptAttachments.length + 1}]`;
    setBusy(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      const result = await attachAgentImage({
        sessionId,
        name: file.name || `${token}.png`,
        mimeType: file.type || 'image/png',
        data: dataUrl,
      });
      setPromptAttachments((current) => [
        ...current,
        {
          token,
          path: result.attachment.path,
          name: result.attachment.name,
          mimeType: result.attachment.mimeType,
        },
      ]);
      setPrompt((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${token} `);
      onMessage(`${token} attached.`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Could not attach pasted image.');
    } finally {
      setBusy(false);
    }
  }

  function handlePromptPaste(event: ClipboardEvent<HTMLInputElement>) {
    const files = Array.from(event.clipboardData.files || []);
    const image = files.find((file) => file.type.startsWith('image/'));
    if (!image) return;
    event.preventDefault();
    void attachPastedImage(image);
  }

  function sendPrompt(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if ((!text && promptAttachments.length === 0) || !sessionId) return;
    const attachmentLines = promptAttachments.map((attachment) => `${attachment.token}: ${attachment.path}`);
    const finalText = attachmentLines.length > 0
      ? `${text}\n\nAttached image paths:\n${attachmentLines.join('\n')}`.trim()
      : text;
    setPrompt('');
    setPromptAttachments([]);
    runAction(() => messageAgentSession(sessionId, finalText), 'Message sent.');
  }

  return {
    prompt,
    promptAttachments,
    setPrompt,
    handlePromptPaste,
    sendPrompt,
    canSendPrompt: (prompt.trim().length > 0 || promptAttachments.length > 0) && Boolean(sessionId) && !busy,
  };
}
