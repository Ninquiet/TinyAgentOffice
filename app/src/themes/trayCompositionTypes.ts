import type { CSSProperties } from 'react';

// The blueprint tray, as a set of theme knobs.
//
// The priority for this feature is not a particular look: it is that a theme can
// define the tray entirely from its own `.ts`. Several themes are planned, so
// every visual property here is a knob and nothing is hardcoded in the component.
//
// **Every field is optional and the CSS carries the fallbacks.** The registry
// includes `default: {}`, and the tray has to render correctly against it --
// which is the only way to know the CSS defaults are real rather than decorative.
//
// **The copy is deliberately not here.** `Blueprints`, `Unlink them`, `Stop them`
// and the rest are product language (user decision Q5). A theme that can rename
// things produces different vocabulary per theme, which is how a product stops
// having one.

/** The edge the tray enters from. See the note on `side` below. */
export type TraySide = 'left' | 'right';

export type TrayLayout = 'column' | 'grid';

export type ThemeTrayPanelComposition = {
  /**
   * The edge the tray slides in from.
   *
   * Not only CSS: it also decides which way a blueprint is dragged out of the
   * tray. A theme that opens from the left while the drag logic still assumes
   * right produces a gesture that fights the user, so the component reads this
   * rather than assuming.
   */
  side?: TraySide;
  width?: string;
  /** How much of the screen height the tray covers, e.g. `50%`. */
  height?: string;
  /** Distance from the bottom edge, so a theme can float it clear of the rail. */
  bottom?: string;
  /**
   * `overlay` draws the tray over the board; `push` shifts the board aside.
   * Overlay is the cyberpunk choice: pushing would move the project's cartridges,
   * and position means something on that screen.
   */
  mode?: 'overlay' | 'push';
  background?: string;
  backgroundImage?: string;
  borderColor?: string;
  /** The bright leading edge, on whichever side the tray enters from. */
  edgeWidth?: string;
  edgeColor?: string;
  shadow?: string;
  radius?: string;
  padding?: string;
  zIndex?: string;
};

export type ThemeTrayAnimationComposition = {
  duration?: string;
  easing?: string;
};

export type ThemeTrayButtonComposition = {
  x?: string;
  y?: string;
  width?: string;
  height?: string;
  background?: string;
  borderColor?: string;
  borderWidth?: string;
  color?: string;
  /** The chamfer or radius, as a `clip-path` or `border-radius` value. */
  clipPath?: string;
  radius?: string;
  fontSize?: string;
  letterSpacing?: string;
  /** A decorative glyph beside the label. Not the label: that is product copy. */
  glyph?: string;
  glyphSize?: string;
  /** Whether a count of blueprints is drawn on the button. */
  showCount?: boolean;
  countBackground?: string;
  countColor?: string;
};

export type ThemeTrayContentComposition = {
  /**
   * The size blueprints render at inside the tray, as a factor of full size.
   *
   * Not only CSS: the drag geometry reads this so that hit targets, snap
   * distances and drop positions are computed against the size actually drawn.
   * Scaling with CSS alone leaves all of that measuring a cartridge that is not
   * on screen, and the symptom is "dragging feels wrong in this theme" -- see
   * `cartridges/geometry.ts` and its validator.
   */
  blueprintScale?: number;
  layout?: TrayLayout;
  /** Columns when `layout` is `grid`; ignored for a column. */
  columns?: number;
  gap?: string;
  /** Space above the first blueprint, for a theme that wants a header gap. */
  paddingTop?: string;
  /** How the slot reads while its blueprint is being pulled out of the tray. */
  ghostOpacity?: number;
  ghostGrayscale?: number;
  /** How wide the insertion gap opens while reordering. */
  gapSize?: string;
};

export type ThemeTrayComposition = {
  panel?: ThemeTrayPanelComposition;
  animation?: ThemeTrayAnimationComposition;
  button?: ThemeTrayButtonComposition;
  content?: ThemeTrayContentComposition;
};

// The two fields that are not CSS. Read through these rather than off the
// composition, so a theme that omits them still gets a working gesture instead
// of `undefined` reaching the geometry.
export const DEFAULT_TRAY_SIDE: TraySide = 'right';
export const DEFAULT_BLUEPRINT_SCALE = 0.5;

export function traySide(composition: ThemeTrayComposition | undefined): TraySide {
  return composition?.panel?.side === 'left' ? 'left' : DEFAULT_TRAY_SIDE;
}

export function blueprintScale(composition: ThemeTrayComposition | undefined): number {
  const value = Number(composition?.content?.blueprintScale);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BLUEPRINT_SCALE;
}

export function trayColumns(composition: ThemeTrayComposition | undefined): number {
  if (composition?.content?.layout !== 'grid') return 1;
  const value = Math.floor(Number(composition.content.columns));
  return Number.isFinite(value) && value > 1 ? value : 1;
}

export function trayCompositionToStyle(
  prefix: string,
  composition: ThemeTrayComposition | undefined,
): CSSProperties {
  const style: Record<string, string> = {};
  const set = (name: string, value: string | number | undefined) => {
    if (value === undefined || value === null || value === '') return;
    style[`--${prefix}-${name}`] = String(value);
  };

  const panel = composition?.panel;
  set('width', panel?.width);
  set('height', panel?.height);
  set('bottom', panel?.bottom);
  set('background', panel?.background);
  set('background-image', panel?.backgroundImage);
  set('border-color', panel?.borderColor);
  set('edge-width', panel?.edgeWidth);
  set('edge-color', panel?.edgeColor);
  set('shadow', panel?.shadow);
  set('radius', panel?.radius);
  set('padding', panel?.padding);
  set('z-index', panel?.zIndex);

  const animation = composition?.animation;
  set('duration', animation?.duration);
  set('easing', animation?.easing);

  const button = composition?.button;
  set('button-x', button?.x);
  set('button-y', button?.y);
  set('button-width', button?.width);
  set('button-height', button?.height);
  set('button-background', button?.background);
  set('button-border-color', button?.borderColor);
  set('button-border-width', button?.borderWidth);
  set('button-color', button?.color);
  set('button-clip-path', button?.clipPath);
  set('button-radius', button?.radius);
  set('button-font-size', button?.fontSize);
  set('button-letter-spacing', button?.letterSpacing);
  set('button-glyph-size', button?.glyphSize);
  set('count-background', button?.countBackground);
  set('count-color', button?.countColor);

  const content = composition?.content;
  set('blueprint-scale', content?.blueprintScale);
  if (content?.layout === 'grid') set('columns', trayColumns(composition));
  set('gap', content?.gap);
  set('padding-top', content?.paddingTop);
  set('ghost-opacity', content?.ghostOpacity);
  set('ghost-grayscale', content?.ghostGrayscale);
  set('gap-size', content?.gapSize);

  return style as CSSProperties;
}
