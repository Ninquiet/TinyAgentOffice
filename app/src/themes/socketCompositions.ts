import { defaultSocketComposition } from './default/socketComposition';
import { cyberpunkSocketComposition } from './cyberpunk/socketComposition';
import type { ThemeSocketComposition } from './socketCompositionTypes';

const socketCompositions: Record<string, ThemeSocketComposition> = {
  default: defaultSocketComposition,
  cyberpunk: cyberpunkSocketComposition,
};

export function getThemeSocketComposition(themeId: string): ThemeSocketComposition {
  return socketCompositions[themeId] || {};
}
