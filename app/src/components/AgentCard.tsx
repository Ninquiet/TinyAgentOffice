import { FormEvent, useEffect, useRef, useState } from 'react';
import { postJson } from '../api';
import { useDashboardStore } from '../store';
import type { AgentSession, FleetPreset } from '../types';
import { StatusBadge } from './StatusBadge';

interface AgentCardProps {
  preset: FleetPreset;
  session?: AgentSession;
}

function roleLabel(role: string) {
  if (role === 'SP') return 'Senior Pro';
  if (role === 'SS') return 'Semi Senior';
  if (role === 'Jr') return 'Junior';
  if (role === 'PM') return 'Project Manager';
  return role;
}

export function AgentCard({ preset, session }: AgentCardProps) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const setLastMessage = useDashboardStore((state) => state.setLastMessage);
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const messages = session?.sessionConsole?.messages || [];

  useEffect(() => {
    const el = consoleRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 40) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  async function runAction(url: string, payload: unknown) {
    setBusy(true);
    try {
      const result = await postJson<{ message?: string }>(url, payload);
      if (result.message) setLastMessage(result.message);
    } catch (error) {
      setLastMessage(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || !session?.sessionId) return;
    setMessage('');
    void runAction('/api/agents/message', { sessionId: session.sessionId, text });
  }

  const canMessage = Boolean(session?.sessionId);

  return (
    <article className={`agent-card agent-${session?.status || 'unavailable'}`}>
      <div className="agent-state-bar" />
      <header className="agent-card-header">
        <div>
          <h3>{preset.name}</h3>
          <p>{roleLabel(preset.role)} · {preset.cli}{preset.model ? ` · ${preset.model}` : ''}</p>
        </div>
        <details className="card-menu">
          <summary aria-label="Open actions">...</summary>
          <div className="card-menu-items">
            <button disabled={!session?.sessionId || busy} onClick={() => runAction('/api/agents/remove', { sessionId: session?.sessionId })}>
              Close Session
            </button>
            <button disabled={busy} onClick={() => runAction('/api/fleet/delete', { name: preset.name })}>
              Delete Preset
            </button>
          </div>
        </details>
      </header>

      <div className="agent-actions">
        {session?.sessionId ? (
          <button disabled={busy} onClick={() => runAction('/api/agents/focus', { sessionId: session.sessionId })}>Focus Window</button>
        ) : (
          <button disabled={busy} onClick={() => runAction('/api/fleet/launch', { name: preset.name })}>Launch</button>
        )}
        {session?.sessionId ? <button disabled={busy} onClick={() => runAction('/api/dispatch/run-next', { sessionId: session.sessionId })}>Run Next</button> : null}
        {session ? <StatusBadge status={session.status} /> : <StatusBadge status="unavailable" />}
      </div>

      {session?.attentionRequest ? (
        <section className="attention-box">
          <strong>Needs your answer</strong>
          <p>{session.attentionRequest.question}</p>
          <div className="attention-options">
            {(session.attentionRequest.options || []).map((option) => (
              <button key={option} onClick={() => runAction('/api/agents/attention/respond', { sessionId: session.sessionId, answer: option })}>
                {option}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <form className="console-composer" onSubmit={sendMessage}>
        <input
          disabled={!canMessage || busy}
          value={message}
          placeholder={canMessage ? 'Message agent...' : 'Launch this preset to message the agent'}
          onChange={(event) => setMessage(event.target.value)}
        />
        <button disabled={!message.trim() || !canMessage || busy}>Send</button>
      </form>

      <div className="agent-console" ref={consoleRef}>
        {session?.sessionConsole ? (
          messages.length > 0 ? messages.map((entry, index) => (
            <div className={`console-message role-${entry.role.replace(/[^a-z0-9_-]/gi, '-')}`} key={`${entry.id || index}:${entry.role}`}>
              <span>{entry.role}</span>
              <pre>{entry.preview}</pre>
            </div>
          )) : <p className="muted">No session messages available yet.</p>
        ) : <p className="muted">No live session.</p>}
      </div>
    </article>
  );
}
