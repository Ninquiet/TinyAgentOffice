import { cyberpunkButtonsComposition } from './cyberpunk/buttonsComposition';
import type { ThemeButtonsComposition } from './buttonCompositionTypes';

const buttonCompositions: Record<string, ThemeButtonsComposition> = {
  default: {},
  cyberpunk: cyberpunkButtonsComposition,
};

export function getThemeButtonsComposition(themeId: string): ThemeButtonsComposition {
  return buttonCompositions[themeId] || {};
}
