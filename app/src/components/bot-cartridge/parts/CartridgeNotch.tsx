interface CartridgeNotchProps {
  active: boolean;
  slotId?: string | null;
  hasClaimableTasks: boolean;
  hasRunnableTask: boolean;
  onRunNext: (slotId: string) => void;
}

export function CartridgeNotch({ active, slotId, hasClaimableTasks, hasRunnableTask, onRunNext }: CartridgeNotchProps) {
  const canRunNext = active && Boolean(slotId) && (hasClaimableTasks || hasRunnableTask);

  return (
    <div className={`cartridge-notch ${canRunNext ? 'cartridge-notch-action' : ''}`}>
      {canRunNext ? (
        <button
          className="cartridge-run-next-button"
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRunNext(slotId || '');
          }}
        >
          {hasRunnableTask ? 'Continue' : 'Run Next'}
        </button>
      ) : null}
    </div>
  );
}
