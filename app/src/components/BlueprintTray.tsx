import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Blueprint } from '../types';
import {
  blueprintScale,
  trayColumns,
  trayCompositionToStyle,
  traySide,
  type ThemeTrayComposition,
} from '../themes/trayCompositionTypes';
import { getThemeTrayComposition } from '../themes/trayCompositions';
import { ghostsFor } from '../cartridges/instancing';
import { gapIndexFor, gestureFor, reorderBlueprints, type TrayGesture } from '../cartridges/trayOrdering';
import { insertionIndexAt } from '../cartridges/geometry';
import { createPointerDragController } from '../drag/pointerDrag';

// The blueprint tray shell: a button, and a panel that slides in from the edge
// the theme chose.
//
// The component decides behaviour and nothing about appearance. Every visual
// property arrives as a CSS custom property from `trayCompositionToStyle`, and
// the stylesheet carries the fallbacks -- so this renders correctly against the
// `default` theme's empty composition, which is the only real test of whether
// those fallbacks exist.
//
// The copy here is product language (user decision Q5) and deliberately not a
// theme knob. A theme that could rename `Blueprints` would give the product a
// different vocabulary per theme.
const TRAY_LABEL = 'Blueprints';
const EMPTY_HINT = 'No blueprints yet';

export interface IncomingBlueprint {
  blueprint: Blueprint;
  sourceCartridgeId: string;
  source: { left: number; top: number };
  moving: boolean;
}

interface BlueprintTrayProps {
  themeId: string;
  blueprints: Blueprint[];
  usedBlueprintIds?: ReadonlySet<string>;
  /** Rendered per blueprint, at the scale the theme asked for. */
  renderBlueprint?: (blueprint: Blueprint, scale: number) => React.ReactNode;
  onOpenChange?: (open: boolean) => void;
  /** A blueprint was pulled out of the tray and dropped on the board. */
  onInstance?: (blueprintId: string, at: { x: number; y: number }) => void;
  /** The whole column, in one call: a reorder is a single write. */
  onReorder?: (order: Array<{ id: string; trayIndex: number }>) => void;
  /** Hovering a tray cartridge can reveal its board instance. */
  onBlueprintHover?: (blueprintId: string | null) => void;
  onEditBlueprint?: (blueprintId: string) => void;
  onDeleteBlueprint?: (blueprintId: string) => void;
  /** A board cartridge being consumed into its newly persisted blueprint. */
  incomingBlueprint?: IncomingBlueprint | null;
  onIntakeSettled?: (blueprintId: string) => void;
}

export function BlueprintTray({
  themeId,
  blueprints,
  usedBlueprintIds,
  renderBlueprint,
  onOpenChange,
  onInstance,
  onReorder,
  onBlueprintHover,
  onEditBlueprint,
  onDeleteBlueprint,
  incomingBlueprint,
  onIntakeSettled,
}: BlueprintTrayProps) {
  const composition: ThemeTrayComposition = getThemeTrayComposition(themeId);
  const [open, setOpen] = useState(false);

  // Read through the accessors, never off the composition: a theme that omits
  // either of these must still get a working gesture rather than `undefined`
  // reaching the geometry.
  const side = traySide(composition);
  const scale = blueprintScale(composition);
  const columns = trayColumns(composition);

  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      onOpenChange?.(next);
      return next;
    });
  }, [onOpenChange]);

  // Escape closes it. A panel that covers half the board and can only be
  // dismissed by finding its button again is a panel people leave open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        onOpenChange?.(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const style = trayCompositionToStyle('tray', composition);

  // Closed sits one tray-width outside the edge it lives on; open sits at zero.
  // Derived from `side` rather than declared per side in CSS, so the one value
  // that decides which way the tray enters also decides which way it leaves and
  // which way a blueprint is dragged out of it.
  // Which blueprint is being dragged, and where the pointer is. Both are state
  // because they drive a render -- but everything derived from them, the ghost
  // and the gap, is computed here and stored nowhere.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [settlingPreview, setSettlingPreview] = useState<{
    blueprint: Blueprint;
    left: number;
    top: number;
  } | null>(null);
  const [settlingGrowDone, setSettlingGrowDone] = useState(false);
  const dragGrabOffset = useRef({ x: 0, y: 0 });
  const intakeTargetRef = useRef<HTMLDivElement | null>(null);
  const trayItemsRef = useRef<HTMLDivElement | null>(null);
  const [intakeFlight, setIntakeFlight] = useState<{
    blueprintId: string;
    deltaX: number;
    deltaY: number;
  } | null>(null);

  // The target is a real (temporarily invisible) grid item. Measuring it keeps
  // the flight coupled to the theme's columns, gaps, scale and scroll rather
  // than duplicating that layout maths in App. It also lets a newly appended
  // item scroll into view before the animation chooses its destination.
  useLayoutEffect(() => {
    if (!incomingBlueprint || !intakeTargetRef.current) {
      setIntakeFlight(null);
      return;
    }

    const target = intakeTargetRef.current;
    target.scrollIntoView({ block: 'nearest' });
    const rect = target.getBoundingClientRect();
    setIntakeFlight({
      blueprintId: incomingBlueprint.blueprint.id,
      deltaX: rect.left - incomingBlueprint.source.left,
      deltaY: rect.top - incomingBlueprint.source.top,
    });
  }, [incomingBlueprint?.blueprint.id, incomingBlueprint?.source.left, incomingBlueprint?.source.top]);

  useEffect(() => {
    if (!draggingId) return undefined;
    const previous = document.documentElement.style.cursor;
    document.documentElement.style.cursor = 'grabbing';
    return () => {
      document.documentElement.style.cursor = previous;
    };
  }, [draggingId]);

  useEffect(() => {
    if (!settlingPreview || !settlingGrowDone) return;
    if (!usedBlueprintIds?.has(settlingPreview.blueprint.id)) return;
    setSettlingPreview(null);
    setSettlingGrowDone(false);
  }, [settlingGrowDone, settlingPreview, usedBlueprintIds]);
  const current = useRef({
    blueprints,
    composition,
    scale,
    columns,
    onInstance,
    onReorder,
  });
  current.current = { blueprints, composition, scale, columns, onInstance, onReorder };

  const trayBounds = () => {
    const panel = document.getElementById('blueprint-tray');
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  };

  const insertionIndexFor = (
    point: { x: number; y: number },
    itemCount: number,
    itemScale: number,
    itemColumns: number,
    gap: number,
  ) => {
    const items = trayItemsRef.current;
    if (!items) return 0;
    const rect = items.getBoundingClientRect();
    return insertionIndexAt({
      pointerX: point.x,
      pointerY: point.y,
      trayLeft: rect.left,
      trayTop: rect.top,
      trayWidth: rect.width,
      scrollTop: items.scrollTop,
      count: itemCount,
      columns: itemColumns,
      gap,
      scale: itemScale,
    });
  };

  // One decision, used for the affordance now and the action on drop. If these
  // were computed separately they could disagree, and the user would see one
  // thing and get the other -- worse than either gesture being wrong on its own.
  const gesture: TrayGesture = draggingId && pointer ? gestureFor(pointer, trayBounds()) : 'instance';

  const bounds = draggingId && pointer ? trayBounds() : null;
  const insertionIndex = bounds && pointer
    ? insertionIndexFor(
      pointer,
      blueprints.length,
      scale,
      columns,
      Number(composition.content?.gap?.replace('px', '')) || 0,
    )
    : 0;

  const ghostSourceId = draggingId ?? settlingPreview?.blueprint.id ?? null;
  const ghosts = ghostsFor({
    blueprints,
    draggingBlueprintId: ghostSourceId,
    draggingGesture: gesture,
    usedBlueprintIds,
  });
  const ghostIds = new Set(ghosts.map((entry) => entry.blueprintId));
  const gapIndex = draggingId ? gapIndexFor({ gesture, insertionIndex }) : null;
  const draggingBlueprint = draggingId
    ? blueprints.find((entry) => entry.id === draggingId)
    : null;

  const dragController = useRef(createPointerDragController<string>({
    disabled: () => !current.current.onInstance && !current.current.onReorder,
    onDragStart: (blueprintId, point) => {
      setDraggingId(blueprintId);
      setPointer(point);
    },
    onDragMove: (_, point) => setPointer(point),
    onDrop: (blueprintId, point) => {
      const grabOffset = dragGrabOffset.current;
      setDraggingId(null);
      setPointer(null);

      const panel = trayBounds();
      const dropped = gestureFor(point, panel);

      if (dropped === 'reorder') {
        dragGrabOffset.current = { x: 0, y: 0 };
        if (!current.current.onReorder || !panel) return;
        const index = insertionIndexFor(
          point,
          current.current.blueprints.length,
          current.current.scale,
          current.current.columns,
          Number(current.current.composition.content?.gap?.replace('px', '')) || 0,
        );
        current.current.onReorder(reorderBlueprints(current.current.blueprints, blueprintId, index));
        return;
      }

      const blueprint = current.current.blueprints.find((entry) => entry.id === blueprintId);
      const dropLeft = point.x - grabOffset.x;
      const dropTop = point.y - grabOffset.y;
      if (blueprint) {
        setSettlingPreview({ blueprint, left: dropLeft, top: dropTop });
        setSettlingGrowDone(false);
      }

      dragGrabOffset.current = { x: 0, y: 0 };
      current.current.onInstance?.(blueprintId, { x: dropLeft, y: dropTop });
    },
    onClick: () => {
      setDraggingId(null);
      setPointer(null);
      dragGrabOffset.current = { x: 0, y: 0 };
    },
  }));

  const startDrag = useCallback((blueprintId: string) => (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    dragGrabOffset.current = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    dragController.current.begin(event, blueprintId);
  }, []);

  const dragBlueprint = useCallback((event: React.PointerEvent<HTMLElement>) => {
    dragController.current.move(event);
  }, []);

  const finishDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    dragController.current.finish(event);
  }, []);

  const closedOffset = side === 'left' ? '-100%' : '100%';
  const panelStyle = {
    ...style,
    transform: `translateX(${open ? '0%' : closedOffset})`,
  };
  const trayBlueprints = incomingBlueprint
    ? [
      ...blueprints.filter((blueprint) => blueprint.id !== incomingBlueprint.blueprint.id),
      incomingBlueprint.blueprint,
    ].sort((a, b) => a.trayIndex - b.trayIndex)
    : blueprints;
  const showCount = composition.button?.showCount !== false && trayBlueprints.length > 0;
  const glyph = composition.button?.glyph;

  return (
    <>
      <button
        type="button"
        className="blueprint-tray-button"
        data-blueprint-tray-button=""
        data-open={open ? 'true' : 'false'}
        aria-expanded={open}
        aria-controls="blueprint-tray"
        style={style}
        onClick={toggle}
      >
        {glyph ? <span className="blueprint-tray-button-glyph" aria-hidden="true">{glyph}</span> : null}
        <span>{TRAY_LABEL}</span>
        {showCount ? (
          <span className="blueprint-tray-button-count">{trayBlueprints.length}</span>
        ) : null}
      </button>

      <aside
        id="blueprint-tray"
        className="blueprint-tray"
        // `side` is data rather than a class so the stylesheet decides what it
        // means -- and so the drag-out direction reads the same single value.
        data-side={side}
        data-open={open ? 'true' : 'false'}
        data-blueprint-scale={scale}
        data-tray-columns={columns}
        aria-hidden={!open}
        aria-label={TRAY_LABEL}
        style={panelStyle}
      >
        {trayBlueprints.length === 0 ? (
          <p className="blueprint-tray-empty">{EMPTY_HINT}</p>
        ) : (
          <div ref={trayItemsRef} className="blueprint-tray-items">
            {trayBlueprints.map((blueprint, index) => {
              const isGhost = ghostIds.has(blueprint.id);
              const hasInstance = Boolean(usedBlueprintIds?.has(blueprint.id));
              const isIntakeTarget = incomingBlueprint?.blueprint.id === blueprint.id;
              return (
                <div
                  key={blueprint.id}
                  ref={isIntakeTarget ? intakeTargetRef : undefined}
                  data-blueprint-id={blueprint.id}
                  data-blueprint-intake-target={isIntakeTarget ? 'true' : 'false'}
                  data-ghost={isGhost ? 'true' : 'false'}
                  data-dragging={draggingId === blueprint.id ? 'true' : 'false'}
                  // The gap opens before this item when the insertion point is
                  // here. Derived from the pointer, drawn with a margin, stored
                  // nowhere.
                  data-gap-before={gapIndex === index ? 'true' : 'false'}
                  onPointerDown={isIntakeTarget ? undefined : startDrag(blueprint.id)}
                  onPointerMove={isIntakeTarget ? undefined : dragBlueprint}
                  onPointerUp={isIntakeTarget ? undefined : finishDrag}
                  onPointerCancel={isIntakeTarget ? undefined : finishDrag}
                  onPointerEnter={() => onBlueprintHover?.(isGhost && hasInstance ? blueprint.id : null)}
                  onPointerLeave={() => onBlueprintHover?.(null)}
                >
                  {renderBlueprint
                    ? renderBlueprint(blueprint, scale)
                    : <span>{blueprint.definition.name}</span>}
                  {!isIntakeTarget && (onEditBlueprint || onDeleteBlueprint) ? (
                    <div
                      className="blueprint-tray-item-actions"
                      onPointerDown={(event) => event.stopPropagation()}
                      onPointerUp={(event) => event.stopPropagation()}
                    >
                      {onEditBlueprint ? (
                        <button
                          type="button"
                          title="Edit blueprint"
                          aria-label={`Edit ${blueprint.definition.name} blueprint`}
                          onClick={() => onEditBlueprint(blueprint.id)}
                        >
                          ✎
                        </button>
                      ) : null}
                      {onDeleteBlueprint ? (
                        <button
                          type="button"
                          className="danger-action"
                          title="Delete blueprint"
                          aria-label={`Delete ${blueprint.definition.name} blueprint`}
                          onClick={() => onDeleteBlueprint(blueprint.id)}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {gapIndex === blueprints.length ? <div data-gap-before="true" data-gap-tail="true" /> : null}
          </div>
        )}
      </aside>
      {draggingBlueprint && pointer ? (
        <div
          className="blueprint-drag-preview"
          aria-hidden="true"
          data-settling="false"
          style={{
            ...style,
            left: pointer.x - dragGrabOffset.current.x,
            top: pointer.y - dragGrabOffset.current.y,
          }}
        >
          {renderBlueprint
            ? renderBlueprint(draggingBlueprint, scale)
            : <span>{draggingBlueprint.definition.name}</span>}
        </div>
      ) : null}
      {settlingPreview ? (
        <div
          className="blueprint-drag-preview"
          aria-hidden="true"
          data-settling="true"
          onAnimationEnd={() => setSettlingGrowDone(true)}
          style={{
            ...style,
            left: settlingPreview.left,
            top: settlingPreview.top,
          }}
        >
          {renderBlueprint
            ? renderBlueprint(settlingPreview.blueprint, scale)
            : <span>{settlingPreview.blueprint.definition.name}</span>}
        </div>
      ) : null}
      {incomingBlueprint && intakeFlight?.blueprintId === incomingBlueprint.blueprint.id ? (
        <div
          className="blueprint-intake-preview"
          aria-hidden="true"
          data-moving={incomingBlueprint.moving ? 'true' : 'false'}
          onAnimationEnd={(event) => {
            if (event.currentTarget !== event.target) return;
            onIntakeSettled?.(incomingBlueprint.blueprint.id);
          }}
          style={{
            ...style,
            left: incomingBlueprint.source.left,
            top: incomingBlueprint.source.top,
            '--blueprint-intake-x': `${intakeFlight.deltaX}px`,
            '--blueprint-intake-y': `${intakeFlight.deltaY}px`,
          } as React.CSSProperties}
        >
          {renderBlueprint
            ? renderBlueprint(incomingBlueprint.blueprint, scale)
            : <span>{incomingBlueprint.blueprint.definition.name}</span>}
        </div>
      ) : null}
    </>
  );
}
