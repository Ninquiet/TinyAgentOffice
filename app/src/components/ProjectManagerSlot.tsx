import { SocketOutline } from './SocketOutline';

interface ProjectManagerSlotProps {
  connected?: { name: string; role: string; activated: boolean; sessionId?: string | null; hasClaimableTasks: boolean };
  onActivate: (slotId: string) => void;
  onEject: (slotId: string) => void;
  onFocus: (slotId: string) => void;
  onNewTask: () => void;
}

const PM_SLOT_ID = 'pm-slot';

export function ProjectManagerSlot({ connected, onActivate, onEject, onFocus, onNewTask }: ProjectManagerSlotProps) {
  const slotState = connected?.hasClaimableTasks
    ? 'attention'
    : connected?.activated
      ? 'active'
      : connected
        ? 'connected'
        : 'empty';

  return (
    <section className="pm-slot-dock" aria-label="Project Manager dock">
      <article
        className={`agent-slot project-manager-slot ${connected ? 'agent-slot-connected' : ''} ${connected?.activated ? 'agent-slot-active' : ''} ${connected?.hasClaimableTasks ? 'agent-slot-attention' : ''}`}
        data-slot-id={PM_SLOT_ID}
        data-slot-state={slotState}
        data-accept-role="PM"
        aria-label="Project Manager slot"
      >
        <SocketOutline />
        {connected?.activated ? (
          <div className="slot-action-row">
            <button className="slot-side-button" type="button" onClick={() => onFocus(PM_SLOT_ID)}>Focus</button>
            <button className="slot-eject-button" type="button" onClick={() => onEject(PM_SLOT_ID)}>Eject</button>
          </div>
        ) : connected ? (
          <button className="slot-activate-button" type="button" onClick={() => onActivate(PM_SLOT_ID)}>
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
      </article>
      <button className="pm-new-task-button" type="button" onClick={onNewTask}>
        New Task
      </button>
    </section>
  );
}
