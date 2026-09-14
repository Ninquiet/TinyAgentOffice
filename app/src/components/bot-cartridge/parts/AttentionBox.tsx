import type { AgentSession } from '../../../types';

interface AttentionBoxProps {
  attentionRequest: NonNullable<AgentSession['attentionRequest']>;
  expanded: boolean;
  sessionId: string | null;
  busy: boolean;
  attentionAnswer: string;
  setAttentionAnswer: (answer: string) => void;
  onAnswer: (answer: string) => void;
}

export function AttentionBox({
  attentionRequest,
  expanded,
  sessionId,
  busy,
  attentionAnswer,
  setAttentionAnswer,
  onAnswer,
}: AttentionBoxProps) {
  return (
    <section className="fake-attention-box">
      <strong>Needs answer</strong>
      <p>{attentionRequest.question}</p>
      <div className="fake-attention-options">
        {(attentionRequest.options || []).map((option) => (
          <button
            key={option}
            type="button"
            disabled={!sessionId || busy}
            onClick={(event) => {
              event.stopPropagation();
              onAnswer(option);
            }}
          >
            {option}
          </button>
        ))}
      </div>
      {expanded ? (
        <form
          className="fake-attention-answer"
          onSubmit={(event) => {
            event.preventDefault();
            onAnswer(attentionAnswer);
          }}
        >
          <input
            disabled={!sessionId || busy}
            value={attentionAnswer}
            placeholder="Custom answer..."
            onChange={(event) => setAttentionAnswer(event.target.value)}
          />
          <button type="submit" disabled={!attentionAnswer.trim() || !sessionId || busy}>
            Answer
          </button>
        </form>
      ) : null}
    </section>
  );
}
