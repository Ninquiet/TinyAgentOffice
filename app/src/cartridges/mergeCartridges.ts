// Merging what the server says with what the user is doing right now.
//
// Placement moved to the coordinator and is broadcast, so two windows on one
// project now stay in step. That is wanted. What is not wanted is the server's
// copy landing on top of a cartridge the user has under the cursor: the incoming
// payload was built before the drag started, so applying it mid-gesture yanks the
// cartridge back to where it used to be. The symptom reads as "dragging got
// janky", not as a sync bug.
//
// There are two windows where the local value is the truer one:
//
// 1. **During the gesture.** The user is moving it; the server has never heard
//    of the position yet. Local wins.
// 2. **After the drop, until the server catches up.** The write is committed on
//    drop, but the next payload may have been built before it landed, so it
//    still carries the old position. Without this the cartridge snaps back for
//    one frame after every drop -- the same jump, a moment later.
//
// Outside those two, the server wins, which is what makes a second window work.
//
// Only placement is held back. Everything else on the record -- whether a session
// is live, what the agent is doing -- keeps flowing while the drag is happening,
// because none of it is what the user is editing.

export interface CartridgePlacement {
  id: string;
  x: number;
  y: number;
  // Optional because the app's own cartridge type has it optional; every
  // comparison normalises undefined and null to the same thing.
  slotId?: string | null;
}

export interface PendingWrite {
  x: number;
  y: number;
  slotId?: string | null;
  at: number;
  /**
   * The write was attempted and refused or errored. A failed write holds its
   * position indefinitely and marks the cartridge, rather than expiring: see
   * the note on `unsaved` below.
   */
  failed?: boolean;
}

export type MergeReason = 'incoming' | 'local-drag' | 'local-pending' | 'local-unacknowledged';

export interface MergeCounters {
  incoming: number;
  localDrag: number;
  localPending: number;
  localUnacknowledged: number;
}

export interface MergeInput<T extends CartridgePlacement> {
  incoming: T[];
  local: T[];
  /** The cartridge under the cursor right now, if any. */
  draggingId?: string | null;
  /** Placements committed locally whose echo has not come back yet. */
  pending?: Record<string, PendingWrite>;
  now?: number;
  /** A lost write must not pin the local value forever. */
  pendingTimeoutMs?: number;
  /** The project this payload describes. */
  projectRoot?: string | null;
  /** The project the local state belongs to. */
  previousProjectRoot?: string | null;
}

export interface MergeResult<T extends CartridgePlacement> {
  cartridges: T[];
  pending: Record<string, PendingWrite>;
  counters: MergeCounters;
  /** True when this payload replaced the state rather than updating it. */
  reset: boolean;
}

export const DEFAULT_PENDING_TIMEOUT_MS = 5000;

function emptyCounters(): MergeCounters {
  return { incoming: 0, localDrag: 0, localPending: 0, localUnacknowledged: 0 };
}

interface Placed {
  x: number;
  y: number;
  slotId?: string | null;
}

function samePlacement(a: Placed, b: Placed) {
  return a.x === b.x && a.y === b.y && (a.slotId || null) === (b.slotId || null);
}

// Values, not references. Every payload is freshly parsed, so nothing on the
// incoming side is ever reference-equal to what is already on screen -- and a
// cartridge carries a nested `definition`, so a shallow comparison would call
// every payload a change. There are a handful of cartridges; this is cheap.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => (
    Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key])
  ));
}

export function mergeCartridges<T extends CartridgePlacement>(input: MergeInput<T>): MergeResult<T> {
  const {
    incoming,
    local,
    draggingId = null,
    pending = {},
    now = Date.now(),
    pendingTimeoutMs = DEFAULT_PENDING_TIMEOUT_MS,
    projectRoot = null,
    previousProjectRoot = null,
  } = input;

  // Switching project replaces every cartridge at once, and merging that would
  // be worse than a visual glitch: the pending writes still outstanding belong
  // to the project we just left, and committing them here would write one
  // project's layout into another's database. A switch is a replacement.
  //
  // The first payload of a session has no previous project and is not a switch:
  // there is nothing local to protect yet.
  if (previousProjectRoot && projectRoot && previousProjectRoot !== projectRoot) {
    const counters = emptyCounters();
    counters.incoming = incoming.length;
    return { cartridges: incoming, pending: {}, counters, reset: true };
  }

  const localById = new Map(local.map((entry) => [entry.id, entry]));
  const counters = emptyCounters();
  const nextPending: Record<string, PendingWrite> = {};
  const cartridges: T[] = [];

  for (const remote of incoming) {
    const mine = localById.get(remote.id);
    const outstanding = pending[remote.id];

    if (mine && remote.id === draggingId) {
      // Under the cursor. Keep the placement, take everything else.
      counters.localDrag += 1;
      cartridges.push({ ...remote, x: mine.x, y: mine.y, slotId: mine.slotId });
      if (outstanding) nextPending[remote.id] = outstanding;
      continue;
    }

    if (mine && outstanding) {
      // The server has caught up when it echoes what was written. Comparing the
      // value rather than waiting for an acknowledgement means an echo from any
      // source clears it, and nothing has to correlate request ids.
      if (samePlacement(remote, outstanding)) {
        counters.incoming += 1;
        cartridges.push(remote);
        continue;
      }

      // A write that was attempted and refused is a different thing from one
      // still in flight, and reverting it silently is the worst of the options.
      //
      // Release the hold and the server wins on the next payload: the cartridge
      // the user moved slides back to where it was, five seconds later, with
      // nothing to explain it. That is precisely how "sometimes the cartridges
      // move on their own" gets reported, and it is unfalsifiable once it is in
      // the wild. So the local value is kept and the cartridge is marked, which
      // makes the disagreement visible and leaves the user something to do
      // about it -- the same rule as `activated` against a dead session: report
      // a disagreement, never resolve it quietly.
      if (outstanding.failed) {
        counters.localPending += 1;
        cartridges.push({
          ...remote,
          x: outstanding.x,
          y: outstanding.y,
          slotId: outstanding.slotId,
          unsaved: true,
        });
        nextPending[remote.id] = outstanding;
        continue;
      }

      // A write that never lands must not pin the local value forever; after the
      // timeout the server is believed again, which is the safe direction.
      if (now - outstanding.at > pendingTimeoutMs) {
        counters.incoming += 1;
        cartridges.push(remote);
        continue;
      }

      counters.localPending += 1;
      cartridges.push({ ...remote, x: outstanding.x, y: outstanding.y, slotId: outstanding.slotId });
      nextPending[remote.id] = outstanding;
      continue;
    }

    counters.incoming += 1;
    cartridges.push(remote);
  }

  // A cartridge the server does not know about yet: created locally, its write
  // still in flight. Dropping it here would make a new cartridge flicker out and
  // back on the first payload after it was placed.
  const incomingIds = new Set(incoming.map((entry) => entry.id));
  for (const mine of local) {
    if (incomingIds.has(mine.id)) continue;
    const outstanding = pending[mine.id];
    const fresh = outstanding && (outstanding.failed || now - outstanding.at <= pendingTimeoutMs);
    if (!fresh && mine.id !== draggingId) continue;

    counters.localUnacknowledged += 1;
    cartridges.push(mine);
    if (outstanding) nextPending[mine.id] = outstanding;
  }

  // The payload arrives about once a second. Handing back a new array when
  // nothing actually changed re-renders the whole cartridge layer -- terminals
  // and animations included -- once a second, for nothing. That does not get
  // reported as an extra render; it gets reported as the office feeling heavy,
  // by which time anything could be the cause.
  if (cartridges.length === local.length && cartridges.every((entry, index) => deepEqual(entry, local[index]))) {
    return { cartridges: local, pending: nextPending, counters, reset: false };
  }

  return { cartridges, pending: nextPending, counters, reset: false };
}

// What the persistence effect should actually send.
//
// Persistence comes from one effect watching `bots`, so every mutation site
// saves itself -- including the one somebody adds next year. The price of that
// shape is that the effect runs on every mouse move, because the dragged
// cartridge's position is part of `bots`.
//
// Which makes "commit everything except the dragged one" the wrong rule: with
// four cartridges that is three writes per frame for cartridges nobody touched,
// and it puts a gesture back on the hot write path we just cleared. The rule is
// to commit what differs from the last thing committed. The dragged cartridge is
// excluded not for being dragged but because its commit is deferred until the
// gesture ends -- at which point it differs, and goes out exactly once.
// Which failures are worth sending again.
//
// "It holds and is marked" and "the mark clears when the server comes back" only
// fit together with this rule. Without it there are two bad ends: nothing
// retries, so the mark survives the server's return and the user is stuck; or
// everything retries, and a 409 -- which cannot succeed however many times it is
// sent -- spins forever.
//
// The split is the ordinary one. No response, or the server saying it is
// struggling, means try again. The server rejecting the request itself means the
// request is the problem, and repeating it is just noise.
export type CommitFailureKind = 'transient' | 'permanent';

export function classifyCommitFailure(error: { status?: number } | null | undefined): CommitFailureKind {
  const status = Number(error && error.status) || 0;
  // No status at all: the request never reached anything.
  if (status === 0) return 'transient';
  if (status >= 500) return 'transient';
  // Timed out, or asked to slow down. Both say "later", not "no".
  if (status === 408 || status === 429) return 'transient';
  if (status >= 400) return 'permanent';
  return 'transient';
}

const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 30000;

// Exponential, capped. A dashboard that is down for an hour should not be asked
// once a second for an hour -- but the cap matters just as much, because a
// backoff that keeps doubling means a server that comes back is not noticed for
// a very long time, and the user is left looking at a stale mark.
export function retryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt));
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * (2 ** exponent));
}

export interface CommitFailure {
  x: number;
  y: number;
  slotId?: string | null;
  kind: CommitFailureKind;
  attempts: number;
  nextAttemptAt?: number;
  status?: number;
  message?: string;
}

export function planPlacementCommits<T extends CartridgePlacement>(input: {
  bots: T[];
  committed: T[];
  draggingId?: string | null;
  failures?: Record<string, CommitFailure>;
  now?: number;
}): T[] {
  const { bots, committed, draggingId = null, failures = {}, now = Date.now() } = input;
  const committedById = new Map(committed.map((entry) => [entry.id, entry]));

  return bots.filter((bot) => {
    if (bot.id === draggingId) return false;

    const failure = failures[bot.id];
    if (failure && samePlacement(bot, failure)) {
      // The exact placement that was refused. Sending it again cannot help --
      // and this is the accidental retry loop, because a write that failed never
      // advanced the committed snapshot, so the ordinary diff below would keep
      // proposing it forever.
      if (failure.kind === 'permanent') return false;
      // Transient: worth another attempt, but not before its backoff.
      return now >= (failure.nextAttemptAt || 0);
    }

    // A different placement is a different request, so a cartridge that was
    // refused once is not dead: moving it somewhere else gets its own attempt.
    const last = committedById.get(bot.id);
    if (!last) return true;
    return !samePlacement(bot, last);
  });
}

// Instrumentation, so the first verification of "it does not jump" produces a
// number instead of an impression: after a three second drag the log should read
// local 40-odd, incoming 0 for that cartridge. If the jump ever comes back, this
// is what names it rather than a user saying it feels wrong.
export interface MergeRecorder {
  record: (counters: MergeCounters) => void;
  totals: () => MergeCounters;
  reset: () => void;
}

export function createMergeRecorder(): MergeRecorder {
  let totals = emptyCounters();
  return {
    record(counters) {
      totals = {
        incoming: totals.incoming + counters.incoming,
        localDrag: totals.localDrag + counters.localDrag,
        localPending: totals.localPending + counters.localPending,
        localUnacknowledged: totals.localUnacknowledged + counters.localUnacknowledged,
      };
    },
    totals: () => ({ ...totals }),
    reset() {
      totals = emptyCounters();
    },
  };
}
