import { SocketOutline } from './SocketOutline';

interface SeniorProSlotProps {
  connected?: { name: string; role: string; activated: boolean; sessionId?: string | null; hasClaimableTasks: boolean };
  onActivate: (slotId: string) => void;
  onEject: (slotId: string) => void;
  onFocus: (slotId: string) => void;
}

const SP_SLOT_ID = 'sp-slot';

export function SeniorProSlot({ connected, onActivate, onEject, onFocus }: SeniorProSlotProps) {
  const slotState = connected?.hasClaimableTasks
    ? 'attention'
    : connected?.activated
      ? 'active'
      : connected
        ? 'connected'
        : 'empty';

  return (
    <section className="sp-slot-dock" aria-label="Senior Pro dock">
      <article
        className={`agent-slot senior-pro-slot ${connected ? 'agent-slot-connected' : ''} ${connected?.activated ? 'agent-slot-active' : ''} ${connected?.hasClaimableTasks ? 'agent-slot-attention' : ''}`}
        data-slot-id={SP_SLOT_ID}
        data-slot-state={slotState}
        data-accept-role="SP"
        aria-label="Senior Pro slot"
      >
        <SocketOutline />
        {connected?.activated ? (
          <div className="sp-slot-action-column">
            <button className="slot-side-button" type="button" onClick={() => onFocus(SP_SLOT_ID)}>Focus</button>
            <button className="slot-eject-button" type="button" onClick={() => onEject(SP_SLOT_ID)}>Eject</button>
          </div>
        ) : connected ? (
          <button className="slot-activate-button" type="button" onClick={() => onActivate(SP_SLOT_ID)}>
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
          <span className="slot-pin" />
        </div>
        <div className="slot-rail slot-rail-bottom" />
      </article>
    </section>
  );
}
