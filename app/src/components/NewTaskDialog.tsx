import { FormEvent, useRef, useState, type ClipboardEvent } from 'react';
import { attachAgentImage } from '../api';

interface TaskAttachment {
  token: string;
  path: string;
  name: string;
  mimeType: string;
}

interface NewTaskDialogProps {
  projectManagerSessionId: string;
  onClose: () => void;
  onCreate: (payload: { text: string; attachments: TaskAttachment[]; sourceElement: HTMLElement }) => Promise<void>;
  onMessage: (message: string) => void;
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read image.'));
    reader.readAsDataURL(file);
  });
}

export function NewTaskDialog({ projectManagerSessionId, onClose, onCreate, onMessage }: NewTaskDialogProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const hasDraft = text.trim().length > 0 || attachments.length > 0;

  async function attachImage(file: File) {
    const token = `[image${attachments.length + 1}]`;
    setBusy(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      const result = await attachAgentImage({
        sessionId: projectManagerSessionId,
        name: file.name || `${token}.png`,
        mimeType: file.type || 'image/png',
        data: dataUrl,
      });
      setAttachments((current) => [
        ...current,
        {
          token,
          path: result.attachment.path,
          name: result.attachment.name,
          mimeType: result.attachment.mimeType,
        },
      ]);
      setText((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${token} `);
      onMessage(`${token} attached.`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Could not attach pasted image.');
    } finally {
      setBusy(false);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files || []);
    const image = files.find((file) => file.type.startsWith('image/'));
    if (!image) return;
    event.preventDefault();
    void attachImage(image);
  }

  function requestClose() {
    if (hasDraft) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() && attachments.length === 0) return;
    const sourceElement = panelRef.current;
    if (!sourceElement) return;
    setBusy(true);
    setSending(true);
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 230));
      await onCreate({ text: text.trim(), attachments, sourceElement });
      setText('');
      setAttachments([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="new-task-overlay" role="presentation">
      <section className={`new-task-dialog ${sending ? 'new-task-dialog-sending' : ''}`} ref={panelRef} role="dialog" aria-modal="true" aria-label="New task">
        <header>
          <h2>New Task</h2>
          <button type="button" aria-label="Close new task dialog" onClick={requestClose}>X</button>
        </header>
        <form onSubmit={submit}>
          <label>
            <span>Task request</span>
            <textarea
              value={text}
              disabled={busy}
              placeholder="Describe what you want the Project Manager to analyze..."
              onChange={(event) => setText(event.target.value)}
              onPaste={handlePaste}
            />
          </label>
          <div className="new-task-attachments">
            {attachments.length === 0 ? (
              <small>Paste images with Ctrl+V to add context.</small>
            ) : attachments.map((attachment) => (
              <span key={attachment.path}>{attachment.token} {attachment.name}</span>
            ))}
          </div>
          <button className="create-task-button" type="submit" disabled={busy || (!text.trim() && attachments.length === 0)}>
            Create Task
          </button>
        </form>
      </section>

      {discardOpen ? (
        <div className="discard-task-overlay" role="presentation">
          <section className="discard-task-dialog" role="dialog" aria-modal="true" aria-label="Discard task draft">
            <h3>Discard task draft?</h3>
            <p>Your text and attached images will be removed.</p>
            <div>
              <button type="button" onClick={() => setDiscardOpen(false)}>Keep Editing</button>
              <button
                className="danger-action"
                type="button"
                onClick={() => {
                  setDiscardOpen(false);
                  onClose();
                }}
              >
                Discard
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
