import type { FormEvent } from 'react';
import type { BlueprintDefinition, BlueprintInstanceSummary } from '../types';
import { ROLE_OPTIONS } from './bot-cartridge/constants';

// The two prompts, with the copy from the plan verbatim.
//
// The words are product language (Q5) and deliberately not theme knobs: a theme
// that could rename them would give the product a different vocabulary per theme.
//
// Every button says what happens rather than naming the mechanism. The operation
// underneath is `unlink`, but the button reads "Unlink them ... they keep running
// unchanged" -- a user choosing under pressure should not have to know what the
// operation is called internally to choose correctly.

interface BreakTheLinkPromptProps {
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}

export function BreakTheLinkPrompt({ onConfirm, onCancel, busy = false, error = null }: BreakTheLinkPromptProps) {
  return (
    <div className="blueprint-prompt-overlay" role="presentation">
      <section className="blueprint-prompt" role="dialog" aria-modal="true" aria-label="Editing this cartridge">
        <p>Editing this cartridge will unlink it from its blueprint.</p>
        <p>It keeps its current settings and stops following the blueprint.</p>
        {error ? <p className="blueprint-prompt-error">{error}</p> : null}
        <div className="blueprint-prompt-actions">
          <button type="button" onClick={onConfirm} disabled={busy}>Unlink and edit</button>
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </section>
    </div>
  );
}

interface BlueprintEditPromptProps {
  draft: BlueprintDefinition;
  onChange: (draft: BlueprintDefinition) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}

export function BlueprintEditPrompt({
  draft,
  onChange,
  onSubmit,
  onCancel,
  busy = false,
  error = null,
}: BlueprintEditPromptProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <div className="blueprint-prompt-overlay" role="presentation">
      <section className="blueprint-prompt" role="dialog" aria-modal="true" aria-label={`Edit ${draft.name} blueprint`}>
        <form className="blueprint-edit-form" onSubmit={submit}>
          <label>
            <span>Name</span>
            <input
              value={draft.name}
              onChange={(event) => onChange({ ...draft, name: event.target.value })}
              disabled={busy}
            />
          </label>
          <label>
            <span>Role</span>
            <select
              value={draft.role}
              onChange={(event) => onChange({ ...draft, role: event.target.value })}
              disabled={busy}
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Model</span>
            <input
              value={draft.model}
              onChange={(event) => onChange({ ...draft, model: event.target.value })}
              disabled={busy}
            />
          </label>
          <label>
            <span>Custom startup instructions</span>
            <textarea
              value={draft.startupInstructions || ''}
              onChange={(event) => onChange({ ...draft, startupInstructions: event.target.value || null })}
              rows={4}
              disabled={busy}
            />
          </label>
          {error ? <p className="blueprint-prompt-error">{error}</p> : null}
          <div className="blueprint-prompt-actions blueprint-prompt-actions-row">
            <button type="submit" disabled={busy || !draft.name.trim() || !draft.model.trim()}>Save changes</button>
            <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          </div>
        </form>
      </section>
    </div>
  );
}

interface RunningInstancesPromptProps {
  instances: BlueprintInstanceSummary[];
  onUnlinkThem: () => void;
  onStopThem: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** Set when an attempt was refused, so the reason replaces the guesswork. */
  error?: string | null;
}

export function RunningInstancesPrompt({
  instances,
  onUnlinkThem,
  onStopThem,
  onCancel,
  busy = false,
  error = null,
}: RunningInstancesPromptProps) {
  return (
    <div className="blueprint-prompt-overlay" role="presentation">
      <section className="blueprint-prompt" role="dialog" aria-modal="true" aria-label="This blueprint has running instances">
        <p>{`This blueprint has ${instances.length} running instance${instances.length === 1 ? '' : 's'}.`}</p>

        {/*
          Named, not counted. "2 running instances" is not something a user can
          decide with -- which of them, in which project, is the whole question.
          This is the reason the cross-project read exists at all, so listing
          them by name and project is the requirement rather than a nicety, and
          it includes projects that are not open.
        */}
        <ul className="blueprint-prompt-instances">
          {instances.map((instance) => (
            <li key={`${instance.projectRoot}:${instance.cartridgeId}`}>
              {`${instance.agentName || 'Unnamed agent'} - ${instance.projectName}`}
            </li>
          ))}
        </ul>

        {error ? <p className="blueprint-prompt-error">{error}</p> : null}

        <div className="blueprint-prompt-actions">
          <button type="button" onClick={onUnlinkThem} disabled={busy}>
            Unlink them
            <span> they keep running unchanged, and stop following this blueprint</span>
          </button>
          <button type="button" onClick={onStopThem} disabled={busy}>
            Stop them
            <span> their sessions end, and they use the new version when reactivated</span>
          </button>
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </section>
    </div>
  );
}

interface DeleteBlueprintPromptProps {
  instanceCount: number;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}

export function DeleteBlueprintPrompt({
  instanceCount,
  onConfirm,
  onCancel,
  busy = false,
  error = null,
}: DeleteBlueprintPromptProps) {
  return (
    <div className="blueprint-prompt-overlay" role="presentation">
      <section className="blueprint-prompt" role="dialog" aria-modal="true" aria-label="Delete this blueprint">
        <p>
          {`Delete this blueprint? Its ${instanceCount} instance${instanceCount === 1 ? '' : 's'} `}
          {instanceCount === 1 ? 'keeps' : 'keep'} working and stop following it.
        </p>
        {error ? <p className="blueprint-prompt-error">{error}</p> : null}
        <div className="blueprint-prompt-actions">
          <button className="danger-action" type="button" onClick={onConfirm} disabled={busy}>Delete</button>
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </section>
    </div>
  );
}
