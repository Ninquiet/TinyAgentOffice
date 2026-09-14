// Reordering inside the tray, and telling the two gestures apart.
//
// The column is always tidy on its own: there is no free positioning and no sort
// button. The only ordering control is dragging a blueprint to where it should
// sit, and a gap opens at the insertion point while the rest reflow around it.
//
// **Two gestures share one element.** Dragging a blueprint out of the tray
// instances it; dragging it within the tray reorders it. The drop decides, and
// the user has to know which is about to happen *before* letting go -- which is
// what the two affordances are for, and why they must never both be showing:
//
//   a gap in the column  -> this is a reorder
//   a ghost in its place -> this is an instance, and the blueprint is staying
//
// Which one is visible is the answer to "what happens if I let go now".

import type { Blueprint } from '../types';

export type TrayGesture = 'reorder' | 'instance';

export interface TrayBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// The drop decides, so the affordance has to be decided by the same test. One
// function, called while dragging to choose the affordance and again on drop to
// choose the action -- if these were two decisions they could disagree, and the
// user would see one thing and get the other.
export function gestureFor(pointer: { x: number; y: number }, tray: TrayBounds | null): TrayGesture {
  if (!tray) return 'instance';
  const inside = pointer.x >= tray.left && pointer.x <= tray.right
    && pointer.y >= tray.top && pointer.y <= tray.bottom;
  return inside ? 'reorder' : 'instance';
}

export interface OrderedBlueprint {
  id: string;
  trayIndex: number;
}

// The new order, as the complete list of places.
//
// Returned as one array on purpose: a reorder rewrites the affected places in a
// SINGLE write. Moving the top item to the bottom shifts everything in between,
// so doing it one blueprint at a time would be N round trips for one gesture --
// and N chances to end up half reordered.
export function reorderBlueprints(
  blueprints: Blueprint[],
  movedId: string,
  insertionIndex: number,
): OrderedBlueprint[] {
  const ordered = [...blueprints].sort((a, b) => a.trayIndex - b.trayIndex);
  const from = ordered.findIndex((entry) => entry.id === movedId);
  if (from === -1) return ordered.map((entry, index) => ({ id: entry.id, trayIndex: index }));

  // The insertion index is measured against the list as the user sees it, which
  // still contains the item being dragged. Removing it first shifts every slot
  // after it up by one, so the target has to be adjusted or the item lands one
  // place too far down.
  const target = Math.max(0, Math.min(ordered.length - 1, insertionIndex > from ? insertionIndex - 1 : insertionIndex));

  const [moved] = ordered.splice(from, 1);
  ordered.splice(target, 0, moved);

  return ordered.map((entry, index) => ({ id: entry.id, trayIndex: index }));
}

// Where the gap sits while dragging, or null when this gesture is not a reorder.
//
// Derived from the pointer at render time, never stored -- the same rule as the
// ghost. Two derived affordances, zero stored, so neither can disagree with the
// blueprint list or outlive the gesture.
//
// The index itself comes from `geometry.insertionIndexAt`, because turning a Y
// into a slot is geometry and has to read the theme's scale. This function only
// decides WHETHER there is a gap at all.
export function gapIndexFor(input: {
  gesture: TrayGesture;
  insertionIndex: number;
}): number | null {
  return input.gesture === 'reorder' ? input.insertionIndex : null;
}
