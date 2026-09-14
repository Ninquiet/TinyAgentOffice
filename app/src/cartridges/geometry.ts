// Where a cartridge's connector is, and where the cartridge has to sit for that
// connector to land on a slot port.
//
// Extracted from App.tsx and made scale-aware, because the theme can choose the
// size a cartridge renders at. `blueprintScale` is a theme knob: half size is the
// current intent for the tray, and another theme may pick something else.
//
// **Scaling with CSS alone is the trap.** Every number here -- the cartridge box,
// the connector offsets, the snap distance -- would keep computing against
// full-size values while the pixels on screen were half that. Hit targets, snap
// distances and drop positions would all be wrong together, and the symptom is
// "dragging feels wrong in the new theme", which is close to untraceable back to
// a value in a theme file.
//
// So scale is a parameter, never a constant, and the test runs the whole
// round-trip at two different scales and requires the same logical result.

export const CARTRIDGE_WIDTH = 224;
export const CARTRIDGE_HEIGHT = 174;
export const LEFT_CONNECTOR_OFFSET_X = 10;
export const TOP_CONNECTOR_OFFSET_Y = 12;
export const BOTTOM_CONNECTOR_OFFSET_Y = 138;
export const SLOT_SNAP_DISTANCE = 72;
export const CARTRIDGE_VIEWPORT_MARGIN = 16;
export const PM_SLOT_VISUAL_LIFT = 34;
export const SP_SLOT_INSERT_DEPTH = 15;

export interface Point {
  x: number;
  y: number;
}

export interface PlacedCartridge {
  x: number;
  y: number;
  role: string;
}

export interface Viewport {
  width: number;
  height: number;
}

// Every measurement the geometry uses, at a given scale. Derived rather than
// listed, so adding a constant above cannot leave one behind unscaled.
export function metricsAt(scale = 1) {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    scale: factor,
    width: CARTRIDGE_WIDTH * factor,
    height: CARTRIDGE_HEIGHT * factor,
    centerOffsetX: (CARTRIDGE_WIDTH * factor) / 2,
    leftConnectorX: LEFT_CONNECTOR_OFFSET_X * factor,
    topConnectorY: TOP_CONNECTOR_OFFSET_Y * factor,
    bottomConnectorY: BOTTOM_CONNECTOR_OFFSET_Y * factor,
    sideConnectorY: (CARTRIDGE_HEIGHT * factor) / 2,
    snapDistance: SLOT_SNAP_DISTANCE * factor,
    viewportMargin: CARTRIDGE_VIEWPORT_MARGIN * factor,
    pmVisualLift: PM_SLOT_VISUAL_LIFT * factor,
    spInsertDepth: SP_SLOT_INSERT_DEPTH * factor,
  };
}

export function connectorPoint(bot: PlacedCartridge, scale = 1): Point {
  const m = metricsAt(scale);
  if (bot.role === 'SP') {
    return { x: bot.x + m.leftConnectorX, y: bot.y + m.sideConnectorY };
  }
  return {
    x: bot.x + m.centerOffsetX,
    y: bot.y + (bot.role === 'PM' ? m.bottomConnectorY : m.topConnectorY),
  };
}

// The inverse: given where the connector must end up, where does the cartridge go?
export function botPositionForPortCenter(bot: PlacedCartridge, center: Point, scale = 1): Point {
  const m = metricsAt(scale);
  if (bot.role === 'SP') {
    return {
      x: center.x - m.leftConnectorX - m.spInsertDepth,
      y: center.y - m.sideConnectorY,
    };
  }
  const visualLift = bot.role === 'PM' ? m.pmVisualLift : 0;
  return {
    x: center.x - m.centerOffsetX,
    y: center.y - (bot.role === 'PM' ? m.bottomConnectorY : m.topConnectorY) - visualLift,
  };
}

export function clampBotPosition(position: Point, viewport: Viewport, scale = 1): Point {
  const m = metricsAt(scale);
  return {
    x: Math.min(
      Math.max(position.x, m.viewportMargin),
      Math.max(m.viewportMargin, viewport.width - m.width - m.viewportMargin),
    ),
    y: Math.min(
      Math.max(position.y, m.viewportMargin),
      Math.max(m.viewportMargin, viewport.height - m.height - m.viewportMargin),
    ),
  };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function isWithinSnapRange(a: Point, b: Point, scale = 1): boolean {
  return distance(a, b) <= metricsAt(scale).snapDistance;
}

// --- the tray column --------------------------------------------------------

// Turning a Y position into "between the third and fourth" is geometry, so it
// lives here rather than beside the reordering logic: this is the module that
// owns scaled measurements, and it is already the one tested for scaling every
// one of them together.
//
// Same hazard as the drag geometry, and the same fix. A theme at a different
// scale draws shorter items, so the same Y is a different slot. Compute it from
// a constant and items land somewhere the user did not point at -- in that theme
// only, which is the hardest kind to notice.

export function trayItemHeight(scale = 1, gap = 0): number {
  const spacing = Number.isFinite(Number(gap)) ? Number(gap) : 0;
  return metricsAt(scale).height + spacing;
}

export function insertionIndexAt(input: {
  pointerX?: number;
  pointerY: number;
  trayLeft?: number;
  trayTop: number;
  trayWidth?: number;
  scrollTop?: number;
  count: number;
  columns?: number;
  /** Space between items, from the theme. */
  gap?: number;
  scale?: number;
}): number {
  const { pointerY, trayTop, count } = input;
  const itemHeight = trayItemHeight(input.scale, input.gap);
  if (itemHeight <= 0) return 0;

  const columns = Math.max(1, Math.floor(Number(input.columns) || 1));
  const hasGridMeasurements = columns > 1
    && Number.isFinite(input.pointerX)
    && Number.isFinite(input.trayLeft)
    && Number.isFinite(input.trayWidth)
    && Number(input.trayWidth) > 0;

  if (hasGridMeasurements) {
    const gap = Math.max(0, Number(input.gap) || 0);
    const scrollTop = Math.max(0, Number(input.scrollTop) || 0);
    const contentY = pointerY - trayTop + scrollTop;
    const row = Math.max(0, Math.floor(contentY / itemHeight));
    const trayWidth = Number(input.trayWidth);
    const trackWidth = Math.max(1, (trayWidth - gap * (columns - 1)) / columns);
    const trackStride = trackWidth + gap;
    const contentX = Number(input.pointerX) - Number(input.trayLeft);

    let insertionColumn;
    if (contentX <= 0) {
      insertionColumn = 0;
    } else if (contentX >= trayWidth) {
      insertionColumn = columns;
    } else {
      const column = Math.max(0, Math.min(columns - 1, Math.floor((contentX + gap / 2) / trackStride)));
      const withinTrack = contentX - column * trackStride;
      insertionColumn = column + (withinTrack >= trackWidth / 2 ? 1 : 0);
    }

    const index = row * columns + insertionColumn;
    return Math.max(0, Math.min(count, index));
  }

  // Rounding rather than flooring puts the boundary at each item's midpoint, so
  // the top half of an item means "before this one". Flooring would insert after
  // an item the pointer was sitting above, which is the opposite of what the gap
  // is showing.
  const index = Math.round((pointerY - trayTop) / itemHeight);
  return Math.max(0, Math.min(count, index));
}
