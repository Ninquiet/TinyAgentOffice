import type { CSSProperties } from 'react';

export type CartridgeRoleKey = 'PM' | 'SP' | 'SS' | 'Jr';
export type CartridgeConnectionState = 'plugged' | 'unplugged';

export type ThemeCartridgeRoleAssets = Partial<Record<CartridgeConnectionState, string>>;

export type ThemeCartridgePartComposition = {
  x?: string;
  y?: string;
  width?: string;
  height?: string;
};

export type ThemeCartridgeEmissionComposition = {
  color?: string;
  glowColor?: string;
  glowRadius?: string;
  strongGlowRadius?: string;
  opacity?: number;
};

export type ThemeCartridgeComposition = {
  assets?: Partial<Record<CartridgeRoleKey, ThemeCartridgeRoleAssets>>;
  cover?: ThemeCartridgePartComposition;
  coverEmission?: ThemeCartridgeEmissionComposition;
  label?: ThemeCartridgePartComposition;
  roleBadge?: ThemeCartridgePartComposition;
  name?: ThemeCartridgePartComposition;
  model?: ThemeCartridgePartComposition;
  status?: ThemeCartridgePartComposition;
  notch?: ThemeCartridgePartComposition;
};

export function cartridgeCompositionToStyle(
  composition: ThemeCartridgeComposition | undefined,
  role: string,
  connected: boolean,
): CSSProperties {
  const roleKey = normalizeCartridgeRole(role);
  const connectionState: CartridgeConnectionState = connected ? 'plugged' : 'unplugged';
  const coverUrl = composition?.assets?.[roleKey]?.[connectionState]
    || composition?.assets?.[roleKey]?.unplugged;
  const style: Record<string, string> = {};

  if (coverUrl) style['--cartridge-theme-cover-url'] = `url("${coverUrl}")`;
  addEmissionVariables(style, 'cover', composition?.coverEmission);

  addPartVariables(style, 'cover', composition?.cover);
  addPartVariables(style, 'label', composition?.label);
  addPartVariables(style, 'role-badge', composition?.roleBadge);
  addPartVariables(style, 'name', composition?.name);
  addPartVariables(style, 'model', composition?.model);
  addPartVariables(style, 'status', composition?.status);
  addPartVariables(style, 'notch', composition?.notch);

  return style as CSSProperties;
}

function addEmissionVariables(
  style: Record<string, string>,
  partName: string,
  emission: ThemeCartridgeEmissionComposition | undefined,
) {
  if (!emission) return;
  if (emission.color) style[`--cartridge-${partName}-emission-color`] = emission.color;
  if (emission.glowColor) style[`--cartridge-${partName}-glow-color`] = emission.glowColor;
  if (emission.glowRadius) style[`--cartridge-${partName}-glow-radius`] = emission.glowRadius;
  if (emission.strongGlowRadius) style[`--cartridge-${partName}-strong-glow-radius`] = emission.strongGlowRadius;
  if (typeof emission.opacity === 'number') style[`--cartridge-${partName}-emission-opacity`] = String(emission.opacity);
}

function normalizeCartridgeRole(role: string): CartridgeRoleKey {
  if (role === 'PM') return 'PM';
  if (role === 'SP') return 'SP';
  if (role === 'SS') return 'SS';
  return 'Jr';
}

function addPartVariables(
  style: Record<string, string>,
  partName: string,
  part: ThemeCartridgePartComposition | undefined,
) {
  if (!part) return;
  if (part.x) style[`--cartridge-${partName}-x`] = part.x;
  if (part.y) style[`--cartridge-${partName}-y`] = part.y;
  if (part.width) style[`--cartridge-${partName}-width`] = part.width;
  if (part.height) style[`--cartridge-${partName}-height`] = part.height;
}
