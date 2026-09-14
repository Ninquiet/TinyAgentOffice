import type { ThemeTrayComposition } from '../trayCompositionTypes';

// A starting point, not a specification. Every value here is meant to be edited.
export const cyberpunkTrayComposition: ThemeTrayComposition = {
  panel: {
    side: 'right',
    width: '300px',
    // The CSS derives the vertical bounds from the BLUEPRINTS trigger and task
    // tabs. Themes can still cap height or offset the bottom, but cyberpunk uses
    // the shared safe region so those neighboring controls stay reachable.
    // Overlay, not push: pushing would move the project's cartridges, and
    // position means something on that board.
    mode: 'overlay',
    background: 'rgba(6, 10, 24, 0.88)',
    borderColor: 'rgba(255, 60, 200, 0.35)',
    edgeWidth: '2px',
    edgeColor: 'rgba(255, 60, 200, 0.85)',
    shadow: '-18px 0 42px rgba(0, 0, 0, 0.55)',
    radius: '0px',
    padding: '18px 16px',
    zIndex: '26',
  },
  animation: {
    duration: '220ms',
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  button: {
    width: '164px',
    height: '50px',
    background: 'linear-gradient(180deg, rgba(15, 25, 52, 0.98), rgba(4, 7, 20, 0.98))',
    borderColor: 'rgba(255, 60, 200, 0.85)',
    borderWidth: '2px',
    color: 'rgba(255, 170, 235, 0.95)',
    clipPath: 'polygon(10px 0, calc(100% - 10px) 0, 100% 10px, 100% calc(100% - 10px), calc(100% - 10px) 100%, 10px 100%, 0 calc(100% - 10px), 0 10px)',
    fontSize: '13px',
    letterSpacing: '0.14em',
    glyph: '◱',
    glyphSize: '15px',
    showCount: false,
    countBackground: 'rgba(255, 60, 200, 0.85)',
    countColor: 'rgba(8, 6, 18, 0.95)',
  },
  content: {
    // Half size. The drag geometry reads this, so the snap radius and drop
    // position shrink with it rather than staying full size.
    blueprintScale: 0.5,
    layout: 'grid',
    columns: 2,
    gap: '12px',
    paddingTop: '4px',
    ghostOpacity: 0.35,
    ghostGrayscale: 0.6,
    gapSize: '26px',
  },
};
