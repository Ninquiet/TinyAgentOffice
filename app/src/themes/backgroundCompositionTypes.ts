export type BackgroundAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export type BackgroundPaint =
  | {
      kind: 'solid';
      color: string;
    }
  | {
      kind: 'linear-gradient';
      direction: string;
      stops: string[];
    };

export type ThemeBackgroundItem = {
  id: string;
  name: string;
  assetUrl: string;
  anchor: BackgroundAnchor;
  width: string;
  height: string;
  paint: BackgroundPaint;
  offsetX?: string;
  offsetY?: string;
  opacity?: number;
  filter?: string;
};

export type ThemeBackgroundComposition = ThemeBackgroundItem[];
