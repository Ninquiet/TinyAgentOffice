import { FormEvent, useState } from 'react';
import { postJson } from '../api';
import { useDashboardStore } from '../store';

export function PresetForm() {
  const [role, setRole] = useState('SP');
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const daemonRunning = useDashboardStore((state) => state.daemonRunning);
  const setLastMessage = useDashboardStore((state) => state.setLastMessage);

  async function run(url: string, payload: unknown = {}) {
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

  function submit(event: FormEvent) {
    event.preventDefault();
    void run('/api/fleet/add', {
      cli: 'opencode',
      role,
      name: name.trim(),
      model: model.trim() || null,
      opencodeAgent: null,
    }).then(() => {
      setName('');
      setModel('');
    });
  }

  return (
    <div className="preset-tools">
      <div className="fleet-actions">
        <button disabled={busy || daemonRunning} onClick={() => run('/api/fleet/up')}>Automatic On</button>
        <button disabled={busy || !daemonRunning} onClick={() => run('/api/fleet/down')}>Automatic Off</button>
      </div>
      <form className="preset-form" onSubmit={submit}>
        <label>
          Role
          <select value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="SP">SP</option>
            <option value="SS">SS</option>
            <option value="Jr">Jr</option>
            <option value="PM">PM</option>
          </select>
        </label>
        <label>
          Agent name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Auto-generated if empty" />
        </label>
        <label>
          Model
          <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Default model" />
        </label>
        <button disabled={busy}>Save Preset</button>
      </form>
    </div>
  );
}
