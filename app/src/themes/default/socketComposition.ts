import type { ThemeSocketComposition } from '../socketCompositionTypes';

// The default theme keeps the shared socket CSS visuals, but it still declares
// its variant so installed themes do not silently fall through the registry.
export const defaultSocketComposition: ThemeSocketComposition = {
  variantId: 'default-classic',
};
