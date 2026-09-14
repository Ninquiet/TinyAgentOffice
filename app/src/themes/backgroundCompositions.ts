import { cyberpunkBackgroundComposition } from './cyberpunk/backgroundComposition';
import type { ThemeBackgroundComposition } from './backgroundCompositionTypes';

const backgroundCompositions: Record<string, ThemeBackgroundComposition> = {
  default: [],
  cyberpunk: cyberpunkBackgroundComposition,
};

export function getThemeBackgroundComposition(themeId: string): ThemeBackgroundComposition {
  return backgroundCompositions[themeId] || [];
}
