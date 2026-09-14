import { cyberpunkTrayComposition } from './cyberpunk/trayComposition';
import type { ThemeTrayComposition } from './trayCompositionTypes';

// `default: {}` is load-bearing, not a placeholder. The tray must render
// correctly against an empty composition, which is the only way to know the CSS
// fallbacks are real rather than decorative -- and it is what a new theme starts
// from before its author has set a single value.
const trayCompositions: Record<string, ThemeTrayComposition> = {
  default: {},
  cyberpunk: cyberpunkTrayComposition,
};

export function getThemeTrayComposition(themeId: string): ThemeTrayComposition {
  return trayCompositions[themeId] || {};
}
