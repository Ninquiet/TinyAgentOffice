import type { CSSProperties } from 'react';
import { getThemeBackgroundComposition } from '../themes/backgroundCompositions';
import type { BackgroundAnchor, BackgroundPaint, ThemeBackgroundItem } from '../themes/backgroundCompositionTypes';

type ThemeBackgroundLayerProps = {
  themeId: string;
};

function paintToCss(paint: BackgroundPaint): string {
  if (paint.kind === 'solid') return paint.color;
  return `linear-gradient(${paint.direction}, ${paint.stops.join(', ')})`;
}

function anchorToPosition(anchor: BackgroundAnchor, offsetX = '0px', offsetY = '0px'): CSSProperties {
  switch (anchor) {
    case 'top-left':
      return { left: offsetX, top: offsetY };
    case 'top-center':
      return { left: `calc(50% + ${offsetX})`, top: offsetY, transform: 'translateX(-50%)' };
    case 'top-right':
      return { right: offsetX, top: offsetY };
    case 'center-left':
      return { left: offsetX, top: `calc(50% + ${offsetY})`, transform: 'translateY(-50%)' };
    case 'center':
      return { left: `calc(50% + ${offsetX})`, top: `calc(50% + ${offsetY})`, transform: 'translate(-50%, -50%)' };
    case 'center-right':
      return { right: offsetX, top: `calc(50% + ${offsetY})`, transform: 'translateY(-50%)' };
    case 'bottom-left':
      return { left: offsetX, bottom: offsetY };
    case 'bottom-center':
      return { left: `calc(50% + ${offsetX})`, bottom: offsetY, transform: 'translateX(-50%)' };
    case 'bottom-right':
      return { right: offsetX, bottom: offsetY };
    default:
      return { left: offsetX, top: offsetY };
  }
}

function itemToStyle(item: ThemeBackgroundItem): CSSProperties {
  return {
    ...anchorToPosition(item.anchor, item.offsetX, item.offsetY),
    display: 'block',
    width: item.width,
    height: item.height,
    opacity: item.opacity ?? 1,
    filter: item.filter,
    background: paintToCss(item.paint),
    WebkitMaskImage: `url("${item.assetUrl}")`,
    maskImage: `url("${item.assetUrl}")`,
    WebkitMaskPosition: 'left bottom',
    maskPosition: 'left bottom',
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskSize: `${item.width} ${item.height}`,
    maskSize: `${item.width} ${item.height}`,
  };
}

export function ThemeBackgroundLayer({ themeId }: ThemeBackgroundLayerProps) {
  const composition = getThemeBackgroundComposition(themeId);

  return (
    <div className="theme-background-layer" aria-hidden="true">
      {composition.map((item) => (
        <span
          className="theme-background-asset"
          key={item.id}
          style={itemToStyle(item)}
          title={item.name}
        />
      ))}
    </div>
  );
}
