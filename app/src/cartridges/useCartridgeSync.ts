import { useCallback, useEffect, useRef, useState } from 'react';
import {
  classifyCommitFailure,
  createMergeRecorder,
  mergeCartridges,
  planPlacementCommits,
  retryDelayMs,
  type CommitFailure,
  type MergeCounters,
  type PendingWrite,
} from './mergeCartridges';
import { importLegacyCartridges, removeCartridgePlacement, saveCartridgePlacement } from '../api';

// The wiring between the cartridges on screen and the coordinator.
//
// Everything that decides anything lives in `mergeCartridges` and is tested
// there. This is the plumbing: it holds the refs, runs the two effects, and
// talks to the API.
//
// **Persistence comes from one effect that watches `bots`.** That matters more
// than it looks: App.tsx mutates `bots` from two dozen places, and with explicit
// save calls each one has to remember, forever, including the one added next
// year. The one that forgets produces a cartridge that moved on screen and not
// on the server, which looks right until the next reload. Watching the state
// means every mutation persists itself and no site has to know.
//
// The price is that the effect runs on every mouse move, since the dragged
// cartridge's position is part of `bots` -- which is why what it sends is
// computed by `planPlacementCommits` rather than being "everything except the
// dragged one".

export interface SyncedCartridge {
  id: string;
  x: number;
  y: number;
  slotId?: string | null;
}

interface UseCartridgeSyncInput<T extends SyncedCartridge> {
  projectRoot: string;
  /** The cartridge section of the dashboard payload. */
  incoming: T[] | undefined;
  bots: T[];
  setBots: (updater: (current: T[]) => T[]) => void;
  /** Read from localStorage once, for the migration. */
  legacyCartridges: () => T[];
  /** Fields the server owns; everything else on a bot stays local. */
  placementFrom: (incoming: T, local: T | undefined) => T;
}

export interface CartridgeSync {
  beginDrag: (id: string) => void;
  endDrag: () => void;
  /** Finish a tray drop by removing the local source instead of saving its last board position. */
  consumeDrag: (id: string) => void;
  counters: MergeCounters;
  resetCounters: () => void;
}

export function useCartridgeSync<T extends SyncedCartridge>(
  input: UseCartridgeSyncInput<T>,
): CartridgeSync {
  const { projectRoot, incoming, bots, setBots, legacyCartridges, placementFrom } = input;

  const draggingId = useRef<string | null>(null);
  const pending = useRef<Record<string, PendingWrite>>({});
  const failures = useRef<Record<string, CommitFailure>>({});
  const committed = useRef<T[]>([]);
  const knownServerIds = useRef<Set<string>>(new Set());
  const previousProjectRoot = useRef<string | null>(null);
  const importedFor = useRef<Set<string>>(new Set());
  const recorder = useRef(createMergeRecorder());
  const [counters, setCounters] = useState<MergeCounters>(() => recorder.current.totals());

  // The one-time migration out of localStorage. The server records that it ran,
  // so this is safe to call again and cannot resurrect deleted cartridges; the
  // ref only avoids the redundant request.
  useEffect(() => {
    if (importedFor.current.has(projectRoot)) return;
    importedFor.current.add(projectRoot);
    const legacy = legacyCartridges();
    if (legacy.length === 0) return;
    importLegacyCartridges(legacy).catch(() => {
      // A failed import is not lost: localStorage still holds the source, and
      // the route takes `force` to run it again.
      importedFor.current.delete(projectRoot);
    });
  }, [projectRoot, legacyCartridges]);

  // Incoming payload -> screen.
  useEffect(() => {
    if (!incoming) return;

    setBots((current) => {
      // The trap this project keeps finding: a bot carries placement, which the
      // server owns, and terminal geometry, which it does not. Handing the merge
      // the raw server record would drop the terminal size and position on every
      // payload. So the incoming side is built as local bot + server placement
      // before anything compares them.
      const localById = new Map(current.map((entry) => [entry.id, entry]));
      const shaped = incoming.map((entry) => placementFrom(entry, localById.get(entry.id)));

      const result = mergeCartridges({
        incoming: shaped,
        local: current,
        draggingId: draggingId.current,
        pending: pending.current,
        projectRoot,
        previousProjectRoot: previousProjectRoot.current,
      });

      pending.current = result.pending;
      previousProjectRoot.current = projectRoot;
      knownServerIds.current = new Set(incoming.map((entry) => entry.id));

      if (result.reset) {
        // A different project: nothing local survives, and nothing outstanding
        // from the old one may be committed against the new one.
        failures.current = {};
        committed.current = result.cartridges;
      }

      recorder.current.record(result.counters);
      return result.cartridges;
    });
  }, [incoming, projectRoot, setBots, placementFrom]);

  // Screen -> server. Watches `bots`, so every mutation site persists itself.
  useEffect(() => {
    const now = Date.now();
    const plan = planPlacementCommits({
      bots,
      committed: committed.current,
      draggingId: draggingId.current,
      failures: failures.current,
      now,
    });

    for (const cartridge of plan) {
      const write: PendingWrite = {
        x: cartridge.x,
        y: cartridge.y,
        slotId: cartridge.slotId,
        at: now,
      };
      pending.current = { ...pending.current, [cartridge.id]: write };

      saveCartridgePlacement(cartridge)
        .then(() => {
          delete failures.current[cartridge.id];
          committed.current = [
            ...committed.current.filter((entry) => entry.id !== cartridge.id),
            cartridge,
          ];
        })
        .catch((error: { status?: number; message?: string }) => {
          const kind = classifyCommitFailure(error);
          const attempts = (failures.current[cartridge.id]?.attempts || 0) + 1;
          failures.current = {
            ...failures.current,
            [cartridge.id]: {
              x: cartridge.x,
              y: cartridge.y,
              slotId: cartridge.slotId,
              kind,
              attempts,
              nextAttemptAt: kind === 'transient' ? Date.now() + retryDelayMs(attempts - 1) : undefined,
              status: error && error.status,
              message: error && error.message,
            },
          };
          // Held, not reverted, and marked. See the note in mergeCartridges on
          // why a silent revert is the worst of the options here.
          pending.current = {
            ...pending.current,
            [cartridge.id]: { ...write, failed: true },
          };
        });
    }

    // Deleting is derived the same way: an id the server still lists that is no
    // longer on screen was deleted here. No delete site has to call anything.
    for (const id of knownServerIds.current) {
      if (bots.some((entry) => entry.id === id)) continue;
      knownServerIds.current.delete(id);
      committed.current = committed.current.filter((entry) => entry.id !== id);
      removeCartridgePlacement(id).catch(() => {
        // The next payload will still list it, so the next pass tries again.
      });
    }
  }, [bots]);

  // A transient failure needs something to wake it up: `bots` may not change
  // again, so without this the retry would wait for a mutation that never comes.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const due = Object.values(failures.current).some((failure) => (
        failure.kind === 'transient' && Date.now() >= (failure.nextAttemptAt || 0)
      ));
      if (due) setBots((current) => [...current]);
      setCounters(recorder.current.totals());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [setBots]);

  const beginDrag = useCallback((id: string) => {
    draggingId.current = id;
  }, []);

  const endDrag = useCallback(() => {
    draggingId.current = null;
    // Nothing is saved here. Clearing the flag is enough: the commit effect sees
    // a placement that differs from the last committed one and sends it once.
    setBots((current) => [...current]);
  }, [setBots]);

  const consumeDrag = useCallback((id: string) => {
    // The blueprint save and placement removal have already succeeded. Remove
    // the local source in the same update that releases the drag lock so the
    // commit effect can never observe the dropped board position as a write.
    draggingId.current = null;
    setBots((current) => current.filter((entry) => entry.id !== id));
  }, [setBots]);

  // Instrumentation, off unless asked for. "The cartridge does not jump" is a
  // feeling; `local 47, incoming 0` is a reading, and if the jump ever comes
  // back this is what names it instead of a user saying it feels wrong.
  useEffect(() => {
    if (window.localStorage.getItem('tiny-agent-office:debug-cartridges') !== 'true') return undefined;
    const globals = window as unknown as Record<string, unknown>;
    globals.__cartridgeSync = {
      counters: () => recorder.current.totals(),
      pending: () => ({ ...pending.current }),
      failures: () => ({ ...failures.current }),
      draggingId: () => draggingId.current,
      reset: () => recorder.current.reset(),
    };
    return () => { delete globals.__cartridgeSync; };
  }, []);

  const resetCounters = useCallback(() => {
    recorder.current.reset();
    setCounters(recorder.current.totals());
  }, []);

  return { beginDrag, endDrag, consumeDrag, counters, resetCounters };
}
