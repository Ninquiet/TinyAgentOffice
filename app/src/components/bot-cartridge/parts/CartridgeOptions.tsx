import type { CSSProperties, Dispatch, FormEvent, Ref, SetStateAction } from 'react';
import { ROLE_OPTIONS } from '../constants';
import type { MenuPlacement } from '../hooks/useMenuPlacement';

interface CartridgeOptionsProps {
  botId: string;
  /** Whether this cartridge follows a blueprint. Decides what the menu offers. */
  linked?: boolean;
  editing: boolean;
  draft: { name: string; role: string; model: string };
  modelOptions: string[];
  setDraft: Dispatch<SetStateAction<{ name: string; role: string; model: string }>>;
  setEditing: (editing: boolean) => void;
  setMenuOpen: (open: boolean) => void;
  onDestroy: (id: string) => void;
  onCleanMemory?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onUnlink?: (id: string) => void;
  onEditRequest: () => void;
  onSaveAsBlueprint?: (id: string) => void;
  onSave: (event: FormEvent) => void;
  menuRef?: Ref<HTMLElement>;
  placement?: MenuPlacement;
}

export function CartridgeOptions({
  botId,
  linked = false,
  editing,
  draft,
  modelOptions,
  setDraft,
  setEditing,
  setMenuOpen,
  onDestroy,
  onCleanMemory,
  onDuplicate,
  onUnlink,
  onEditRequest,
  onSaveAsBlueprint,
  onSave,
  menuRef,
  placement,
}: CartridgeOptionsProps) {
  // Measured at open time. The menu is centred on the cartridge, so the shift
  // is applied on top of the centring translate rather than replacing it.
  // A custom property rather than a transform: the opening animation runs with
  // fill "both", so it keeps overriding any inline transform and the correction
  // would be discarded without a trace.
  const style = {
    '--cartridge-options-shift': `${placement?.shiftX ?? 0}px`,
    ...(placement?.maxHeight ? { maxHeight: `${placement.maxHeight}px`, overflowY: 'auto' } : {}),
  } as CSSProperties;

  return (
    <section
      ref={menuRef}
      className={`cartridge-options${placement?.above ? ' cartridge-options-above' : ''}`}
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {editing ? (
        <form className="cartridge-edit-form" onSubmit={onSave}>
          <label>
            <span>Name</span>
            <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label>
            <span>Role</span>
            <select value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))}>
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Model</span>
            <select value={draft.model} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}>
              {modelOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <div className="cartridge-options-row">
            <button type="submit">Save</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <button type="button" onClick={onEditRequest}>Edit</button>

          {/*
            The menu follows the cartridge's state, and the important half is
            what it does NOT offer.

            `Save as blueprint` is absent on an instance. Dropping one into the
            tray is refused because the explicit path to a variant is duplicate,
            edit the copy, drag it in. A menu that offers something it is going
            to refuse is worse than one that simply does not offer it. The
            refusal covers the drag; this covers the menu.

            `Duplicate` is offered either way, because it is the path to a
            variant: duplicate, edit the copy, drag it in.
          */}
          {onDuplicate ? (
            <button type="button" onClick={() => onDuplicate(botId)}>Duplicate</button>
          ) : null}

          {linked ? (
            onUnlink ? (
              <button type="button" onClick={() => onUnlink(botId)}>Unlink from blueprint</button>
            ) : null
          ) : (
            onSaveAsBlueprint ? (
              <button type="button" onClick={() => onSaveAsBlueprint(botId)}>Save as blueprint</button>
            ) : null
          )}

          {onCleanMemory ? (
            <button className="danger-action cartridge-clean-memory" type="button" onClick={() => onCleanMemory(botId)}>
              Clean local memory
            </button>
          ) : null}
          <button className="danger-action" type="button" onClick={() => onDestroy(botId)}>Destroy</button>
          <button type="button" onClick={() => setMenuOpen(false)}>Close</button>
        </>
      )}
    </section>
  );
}
