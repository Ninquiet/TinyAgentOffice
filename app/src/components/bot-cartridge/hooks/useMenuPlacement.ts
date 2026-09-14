import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// Keeps a cartridge's menu inside the window.
//
// The menu used to be pinned below the cartridge unconditionally. A cartridge
// near the bottom of the board pushed its own menu off-screen, where the buttons
// could not be clicked at all -- so the only way to reach Edit was to drag the
// cartridge somewhere else first, which nobody would guess.
//
// This measures the space that actually exists at the moment the menu opens and
// picks a side, then nudges it horizontally if it would run past an edge. A
// menu that is taller than the space available gets a scrollbar rather than
// spilling out.

const GAP = 8;
const MARGIN = 12;

export interface MenuPlacement {
  above: boolean;
  shiftX: number;
  maxHeight: number | null;
}

const INITIAL: MenuPlacement = { above: false, shiftX: 0, maxHeight: null };

export function useMenuPlacement(open: boolean) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<MenuPlacement>(INITIAL);

  // The shift currently applied to the DOM. Measuring gives the rect *after*
  // it, so without subtracting it the second measurement sees a menu that is
  // comfortably inside, resets the shift to zero, and pushes it back out --
  // an oscillation that leaves the menu off-screen exactly when it matters.
  const appliedShift = useRef(0);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    // The board can be scaled, so a pixel on screen is not a pixel in the
    // cartridge's own coordinates. Derive the factor from the menu itself
    // rather than assuming 1.
    const scale = menu.offsetHeight > 0 ? menuRect.height / menu.offsetHeight : 1;
    const toLocal = (value: number) => (scale > 0 ? value / scale : value);

    const spaceBelow = window.innerHeight - anchorRect.bottom - GAP - MARGIN;
    const spaceAbove = anchorRect.top - GAP - MARGIN;
    const needed = menuRect.height;

    // Prefer below, which is where it has always been. Flip only when below
    // genuinely does not fit and above fits better.
    const above = needed > spaceBelow && spaceAbove > spaceBelow;
    const available = above ? spaceAbove : spaceBelow;

    // Horizontal: the menu is centred on the cartridge, so push it back inside
    // by however much it overhangs. Measured against where it would sit with no
    // shift at all, so repeated measurements converge instead of fighting.
    const appliedPx = appliedShift.current * scale;
    const baseLeft = menuRect.left - appliedPx;
    const baseRight = menuRect.right - appliedPx;

    let shiftX = 0;
    const overflowRight = baseRight - (window.innerWidth - MARGIN);
    const overflowLeft = MARGIN - baseLeft;
    if (overflowRight > 0) shiftX = -toLocal(overflowRight);
    else if (overflowLeft > 0) shiftX = toLocal(overflowLeft);
    appliedShift.current = shiftX;

    setPlacement({
      above,
      shiftX,
      // Only constrain when it truly does not fit; an unnecessary max-height
      // would add a scrollbar to a menu that is perfectly comfortable.
      maxHeight: needed > available ? Math.max(toLocal(available), 120) : null,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      appliedShift.current = 0;
      setPlacement(INITIAL);
      return undefined;
    }

    measure();

    // The cartridge can be dragged and the window resized while the menu is
    // open, and either can move it out of view.
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, measure]);

  return { anchorRef, menuRef, placement, remeasure: measure };
}
