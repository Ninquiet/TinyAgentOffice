import type { CSSProperties } from 'react';

export type ThemeButtonPartComposition = {
  x?: string;
  y?: string;
  width?: string;
  height?: string;
};

export type ThemeButtonComposition = {
  button?: ThemeButtonPartComposition;
  frame?: ThemeButtonPartComposition;
  icon?: ThemeButtonPartComposition;
  label?: ThemeButtonPartComposition;
};

export type ThemeButtonsComposition = {
  botBuilder?: ThemeButtonComposition;
  activeTasks?: ThemeButtonComposition;
  todoTasks?: ThemeButtonComposition;
};

export function buttonCompositionToStyle(
  prefix: string,
  composition: ThemeButtonComposition | undefined,
): CSSProperties {
  const style: Record<string, string> = {};

  function addPart(partName: keyof ThemeButtonComposition, variablePartName: string) {
    const part = composition?.[partName];
    if (!part) return;
    if (part.x) style[`--${prefix}-${variablePartName}-x`] = part.x;
    if (part.y) style[`--${prefix}-${variablePartName}-y`] = part.y;
    if (part.width) style[`--${prefix}-${variablePartName}-width`] = part.width;
    if (part.height) style[`--${prefix}-${variablePartName}-height`] = part.height;
  }

  addPart('button', 'button');
  addPart('frame', 'frame');
  addPart('icon', 'icon');
  addPart('label', 'label');

  return style as CSSProperties;
}
