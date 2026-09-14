import { useEffect, useMemo, useState } from 'react';
import { getAgentAdapters, getOpencodeModels, type AgentAdapterSummary } from '../api';
import { DEFAULT_OPENCODE_MODELS, modelOptionsWithCurrent } from '../modelOptions';
import type { BotDraft } from '../types/bot';

const ROLES = [
  { value: 'PM', label: 'Project Manager' },
  { value: 'SP', label: 'Senior Pro' },
  { value: 'SS', label: 'Semi Senior' },
  { value: 'Jr', label: 'Junior' },
];

function defaultBotName() {
  const adjectives = ['Copper', 'Neon', 'Pixel', 'Iron', 'Blue', 'Silent'];
  const nouns = ['Circuit', 'Socket', 'Beacon', 'Hammer', 'Module', 'Runner'];
  const value = Date.now();
  return `${adjectives[value % adjectives.length]} ${nouns[Math.floor(value / 7) % nouns.length]}`;
}

interface BotBuilderScreenProps {
  closing?: boolean;
  onClose: () => void;
  onCreate: (bot: BotDraft) => void;
}

export function BotBuilderScreen({ closing = false, onClose, onCreate }: BotBuilderScreenProps) {
  const [botName, setBotName] = useState(() => defaultBotName());
  const [role, setRole] = useState('SS');
  const [adapter, setAdapter] = useState('opencode');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [adapters, setAdapters] = useState<AgentAdapterSummary[]>([]);
  const [startupInstructions, setStartupInstructions] = useState('');
  const [modelStatus, setModelStatus] = useState('Loading OpenCode models...');

  const modelOptions = useMemo(() => modelOptionsWithCurrent(models, model), [models, model]);

  useEffect(() => {
    let active = true;
    getAgentAdapters()
      .then((response) => {
        if (!active) return;
        setAdapters(response.adapters || []);
      })
      .catch(() => {
        if (!active) return;
        setAdapters([{ id: 'opencode', displayName: 'OpenCode', status: 'full', capabilities: {}, limitations: [] }]);
      });
    getOpencodeModels()
      .then((response) => {
        if (!active) return;
        setModels(response.models || []);
        setModel((current) => current || response.models?.[0] || DEFAULT_OPENCODE_MODELS[0]);
        setModelStatus(response.lastError || `${response.models?.length || 0} OpenCode model(s) loaded.`);
      })
      .catch((error) => {
        if (!active) return;
        setModel(DEFAULT_OPENCODE_MODELS[0]);
        setModelStatus(error instanceof Error ? error.message : 'Could not load OpenCode models.');
      });
    return () => {
      active = false;
    };
  }, []);

  async function refreshModels() {
    setModelStatus('Refreshing OpenCode models...');
    try {
      const response = await getOpencodeModels(true);
      setModels(response.models || []);
      setModel((current) => {
        if (current && response.models.includes(current)) return current;
        return response.models[0] || DEFAULT_OPENCODE_MODELS[0];
      });
      setModelStatus(response.lastError || `${response.models.length} OpenCode model(s) loaded.`);
    } catch (error) {
      setModelStatus(error instanceof Error ? error.message : 'Could not refresh OpenCode models.');
    }
  }

  function createBot() {
    onCreate({
      name: botName.trim() || defaultBotName(),
      role,
      adapter,
      model: model || modelOptions[0],
      startupInstructions: startupInstructions.trim(),
    });
    onClose();
  }

  return (
    <section className={`bot-builder-screen ${closing ? 'bot-builder-screen-closing' : ''}`} role="dialog" aria-modal="true" aria-labelledby="bot-builder-title">
      <header>
        <h2 id="bot-builder-title">Bot Builder Screen</h2>
        <button type="button" aria-label="Close bot builder screen" onClick={onClose}>
          Close
        </button>
      </header>

      <form className="bot-builder-form">
        <label>
          <span>Bot name</span>
          <input value={botName} onChange={(event) => setBotName(event.target.value)} />
        </label>

        <label>
          <span>Adapter</span>
          <select value={adapter} onChange={(event) => setAdapter(event.target.value)}>
            {(adapters.length > 0 ? adapters : [{ id: 'opencode', displayName: 'OpenCode', status: 'full' as const, capabilities: {}, limitations: [] }]).map((option) => (
              <option key={option.id} value={option.id}>
                {option.displayName}{option.status === 'partial' ? ' (partial)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Role</span>
          <select value={role} onChange={(event) => setRole(event.target.value)}>
            {ROLES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <label>
          <span>OpenCode model</span>
          <div className="model-picker">
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {modelOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
            <button type="button" className="secondary-button" onClick={refreshModels}>
              Refresh
            </button>
          </div>
        </label>

        <label>
          <span>Custom startup instructions</span>
          <textarea
            value={startupInstructions}
            onChange={(event) => setStartupInstructions(event.target.value)}
            placeholder="Optional personality, working style, or extra startup rules for this cartridge."
            rows={4}
          />
        </label>

        <p className="builder-status">{modelStatus}</p>

        <div className="builder-preview-row">
          <div className={`builder-preview builder-preview-role-${role.toLowerCase()}`} aria-label="Bot cartridge preview">
            <span className={`cartridge-role-badge cartridge-role-${role.toLowerCase()}`}>{role}</span>
            <strong>{botName || 'Unnamed Bot'}</strong>
            <small>{model || modelOptions[0]}</small>
          </div>
          <button type="button" className="create-bot-button" onClick={createBot}>
            Create
          </button>
        </div>
      </form>
    </section>
  );
}
