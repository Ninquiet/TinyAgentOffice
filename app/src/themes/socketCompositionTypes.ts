import type { CSSProperties } from 'react';

// Theme-owned socket composition.
//
// React owns slot behavior, accepted roles, connected/active state, and actions.
// Themes own the visual shell. Every field is optional so a theme can omit this
// contract and keep the default CSS socket instead of receiving invented values.

export type ThemeSocketPartComposition = {
  x?: string;
  y?: string;
  width?: string;
  height?: string;
  background?: string;
  borderColor?: string;
  shadow?: string;
  radius?: string;
  clipPath?: string;
  outlinePath?: string;
  opacity?: string | number;
};

export type ThemeSocketControlComposition = {
  controlInset?: string;
  controlJustify?: string;
  controlWidth?: string;
  controlMinWidth?: string;
  controlPadding?: string;
  controlFontSize?: string;
};

export type ThemeSocketStateComposition = {
  gateColor?: string;
  jawColor?: string;
  railColor?: string;
  portBackground?: string;
  shadow?: string;
  filter?: string;
};

export type ThemeSocketFormFactorComposition = ThemeSocketPartComposition
  & ThemeSocketControlComposition
  & {
    gate?: ThemeSocketPartComposition;
    jaw?: ThemeSocketPartComposition;
    hinge?: ThemeSocketPartComposition;
    port?: ThemeSocketPartComposition;
    rail?: ThemeSocketPartComposition;
  };

export type ThemeSocketComposition = {
  /** Records the user-selected visual source; not read by CSS. */
  variantId?: string;
  regular?: ThemeSocketFormFactorComposition;
  projectManager?: ThemeSocketFormFactorComposition;
  seniorPro?: ThemeSocketFormFactorComposition;
  empty?: ThemeSocketStateComposition;
  connected?: ThemeSocketStateComposition;
  active?: ThemeSocketStateComposition;
  attention?: ThemeSocketStateComposition;
  focus?: ThemeSocketStateComposition;
};

function set(style: Record<string, string>, prefix: string, name: string, value: string | number | undefined) {
  if (value === undefined || value === null || value === '') return;
  style[`--${prefix}-${name}`] = String(value);
}

function addPart(
  style: Record<string, string>,
  prefix: string,
  partName: string,
  part: ThemeSocketPartComposition | undefined,
) {
  set(style, prefix, `${partName}-x`, part?.x);
  set(style, prefix, `${partName}-y`, part?.y);
  set(style, prefix, `${partName}-width`, part?.width);
  set(style, prefix, `${partName}-height`, part?.height);
  set(style, prefix, `${partName}-background`, part?.background);
  set(style, prefix, `${partName}-border-color`, part?.borderColor);
  set(style, prefix, `${partName}-shadow`, part?.shadow);
  set(style, prefix, `${partName}-radius`, part?.radius);
  set(style, prefix, `${partName}-clip-path`, part?.clipPath);
  set(style, prefix, `${partName}-outline-path`, part?.outlinePath);
  set(style, prefix, `${partName}-opacity`, part?.opacity);
}

function addFormFactor(
  style: Record<string, string>,
  prefix: string,
  name: string,
  form: ThemeSocketFormFactorComposition | undefined,
) {
  addPart(style, prefix, name, form);
  set(style, prefix, `${name}-control-inset`, form?.controlInset);
  set(style, prefix, `${name}-control-justify`, form?.controlJustify);
  set(style, prefix, `${name}-control-width`, form?.controlWidth);
  set(style, prefix, `${name}-control-min-width`, form?.controlMinWidth);
  set(style, prefix, `${name}-control-padding`, form?.controlPadding);
  set(style, prefix, `${name}-control-font-size`, form?.controlFontSize);
  addPart(style, prefix, `${name}-gate`, form?.gate);
  addPart(style, prefix, `${name}-jaw`, form?.jaw);
  addPart(style, prefix, `${name}-hinge`, form?.hinge);
  addPart(style, prefix, `${name}-port`, form?.port);
  addPart(style, prefix, `${name}-rail`, form?.rail);
}

function addState(
  style: Record<string, string>,
  prefix: string,
  name: string,
  state: ThemeSocketStateComposition | undefined,
) {
  set(style, prefix, `${name}-gate-color`, state?.gateColor);
  set(style, prefix, `${name}-jaw-color`, state?.jawColor);
  set(style, prefix, `${name}-rail-color`, state?.railColor);
  set(style, prefix, `${name}-port-background`, state?.portBackground);
  set(style, prefix, `${name}-shadow`, state?.shadow);
  set(style, prefix, `${name}-filter`, state?.filter);
}

export function socketCompositionToStyle(
  prefix: string,
  composition: ThemeSocketComposition | undefined,
): CSSProperties {
  const style: Record<string, string> = {};

  addFormFactor(style, prefix, 'regular', composition?.regular);
  addFormFactor(style, prefix, 'project-manager', composition?.projectManager);
  addFormFactor(style, prefix, 'senior-pro', composition?.seniorPro);
  addState(style, prefix, 'empty', composition?.empty);
  addState(style, prefix, 'connected', composition?.connected);
  addState(style, prefix, 'active', composition?.active);
  addState(style, prefix, 'attention', composition?.attention);
  addState(style, prefix, 'focus', composition?.focus);

  return style as CSSProperties;
}
