import { SocketOutline } from './SocketOutline';

const SLOT_COUNT = 4;

interface ConnectedSlot {
  name: string;
  role: string;
  activated: boolean;
  sessionId?: string | null;
  hasClaimableTasks: boolean;
}

interface AgentSlotsProps {
  connectedBySlot: Record<string, ConnectedSlot | undefined>;
  onActivate: (slotId: string) => void;
  onEject: (slotId: string) => void;
  onFocus: (slotId: string) => void;
}

export function AgentSlots({ connectedBySlot, onActivate, onEject, onFocus }: AgentSlotsProps) {
  return (
    <section className="agent-slots" aria-label="Agent connection slots">
      {Array.from({ length: SLOT_COUNT }, (_, index) => {
        const slotId = `slot-${index + 1}`;
        const connected = connectedBySlot[slotId];
        const slotState = connected?.hasClaimableTasks
          ? 'attention'
          : connected?.activated
            ? 'active'
            : connected
              ? 'connected'
              : 'empty';
        return (
          <article
            className={`agent-slot ${connected ? 'agent-slot-connected' : ''} ${connected?.activated ? 'agent-slot-active' : ''} ${connected?.hasClaimableTasks ? 'agent-slot-attention' : ''}`}
            data-slot-id={slotId}
            data-slot-state={slotState}
            data-accept-role="non-pm"
            key={index}
            aria-label={`Agent slot ${index + 1}`}
          >
            <SocketOutline />
            {connected?.activated ? (
              <div className="slot-action-row">
                <button className="slot-side-button" type="button" onClick={() => onFocus(slotId)}>Focus</button>
                <button className="slot-eject-button" type="button" onClick={() => onEject(slotId)}>Eject</button>
              </div>
            ) : connected ? (
              <button className="slot-activate-button" type="button" onClick={() => onActivate(slotId)}>
                Activate
              </button>
            ) : null}
            <div className="slot-rail slot-rail-top" />
            <div className="slot-port">
              <span className="slot-pin" />
              <span className="slot-pin" />
              <span className="slot-pin" />
              <span className="slot-pin" />
              <span className="slot-pin" />
            </div>
            <div className="slot-rail slot-rail-bottom" />
          </article>
        );
      })}
    </section>
  );
}
