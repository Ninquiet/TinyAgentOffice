import { useEffect, useState, type FormEvent } from 'react';
import { getOpencodeModels } from '../../../api';
import { DEFAULT_OPENCODE_MODELS, modelOptionsWithCurrent } from '../../../modelOptions';
import type { BotCartridgeData, BotDraft } from '../../../types/bot';

interface UseCartridgeEditorArgs {
  bot: BotCartridgeData;
  editRequestKey?: number;
  onUpdate: (id: string, patch: Partial<BotDraft>) => void;
}

export function useCartridgeEditor({ bot, editRequestKey, onUpdate }: UseCartridgeEditorArgs) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: bot.name, role: bot.role, model: bot.model });
  const [models, setModels] = useState<string[]>([]);
  const modelOptions = modelOptionsWithCurrent(models, draft.model || bot.model || DEFAULT_OPENCODE_MODELS[0]);

  useEffect(() => {
    setDraft({ name: bot.name, role: bot.role, model: bot.model });
  }, [bot.name, bot.role, bot.model]);

  useEffect(() => {
    if (!editRequestKey) return;
    setMenuOpen(true);
    setEditing(true);
  }, [editRequestKey]);

  useEffect(() => {
    if (!menuOpen) return undefined;

    function closeMenu() {
      setMenuOpen(false);
      setEditing(false);
    }

    const timer = window.setTimeout(() => {
      window.addEventListener('pointerdown', closeMenu);
    }, 0);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', closeMenu);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!editing) return;
    let active = true;
    getOpencodeModels()
      .then((response) => {
        if (!active) return;
        setModels(response.models || []);
      })
      .catch(() => {
        if (!active) return;
        setModels([]);
      });
    return () => {
      active = false;
    };
  }, [editing]);

  function saveEdit(event: FormEvent) {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) return;
    onUpdate(bot.id, {
      name,
      role: draft.role,
      model: draft.model.trim() || bot.model,
    });
    setEditing(false);
    setMenuOpen(false);
  }

  return {
    menuOpen,
    editing,
    draft,
    modelOptions,
    setMenuOpen,
    setEditing,
    setDraft,
    saveEdit,
  };
}
