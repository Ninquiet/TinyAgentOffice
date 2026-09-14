import { cyberpunkCartridgeComposition } from './cyberpunk/cartridgeComposition';
import type {
  CartridgeConnectionState,
  CartridgeRoleKey,
  ThemeCartridgeComposition,
  ThemeCartridgeRoleAssets,
} from './cartridgeCompositionTypes';

const cartridgeAssetUrls = import.meta.glob<string>('./*/assets/*-cartridge *.svg', {
  eager: true,
  import: 'default',
});

const cartridgeCompositions: Record<string, ThemeCartridgeComposition> = {
  default: {},
  cyberpunk: cyberpunkCartridgeComposition,
};

export function getThemeCartridgeComposition(themeId: string): ThemeCartridgeComposition {
  const declaredComposition = cartridgeCompositions[themeId] || {};
  const conventionAssets = findConventionCartridgeAssets(themeId);

  return {
    ...declaredComposition,
    assets: {
      ...conventionAssets,
      ...(declaredComposition.assets || {}),
    },
  };
}

function findConventionCartridgeAssets(themeId: string) {
  const assets: Partial<Record<CartridgeRoleKey, ThemeCartridgeRoleAssets>> = {};
  const fileNames: Array<[CartridgeRoleKey, CartridgeConnectionState, string]> = [
    ['PM', 'plugged', 'PM-cartridge Plugged.svg'],
    ['PM', 'unplugged', 'PM-cartridge Unplugged.svg'],
    ['SP', 'plugged', 'SP-cartridge Plugged.svg'],
    ['SP', 'unplugged', 'SP-cartridge Unplugged.svg'],
    ['SS', 'plugged', 'ss-cartridge Plugged.svg'],
    ['SS', 'unplugged', 'ss-cartridge Unplugged.svg'],
    ['Jr', 'plugged', 'jr-cartridge Plugged.svg'],
    ['Jr', 'unplugged', 'jr-cartridge Unplugged.svg'],
  ];

  for (const [role, connectionState, fileName] of fileNames) {
    const url = cartridgeAssetUrls[`./${themeId}/assets/${fileName}`];
    if (!url) continue;
    assets[role] = {
      ...(assets[role] || {}),
      [connectionState]: url,
    };
  }

  return assets;
}
