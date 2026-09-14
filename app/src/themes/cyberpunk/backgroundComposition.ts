import backgroundLeft1Url from './assets/background-left-1.svg';
import backgroundLeft2Url from './assets/background-left-2.svg';
import superiorIzquierdaUrl from './assets/superior_izquierda.svg';
import inferiorDerechaURL from './assets/inferior_derecha.svg';
import lateralDerechoURL from './assets/lateral_derecho.svg';
import type { ThemeBackgroundComposition } from '../backgroundCompositionTypes';

export const cyberpunkBackgroundComposition: ThemeBackgroundComposition = [
  {
    id: 'left-technical-frame',
    name: 'Left technical frame',
    assetUrl: backgroundLeft1Url,
    anchor: 'bottom-left',
    width: '520px',
    height: '760px',
    paint: {
      kind: 'linear-gradient',
      direction: '135deg',
      stops: [
        'rgba(0, 229, 255, 0.72)',
        'rgba(139, 92, 246, 0.48) 52%',
        'rgba(244, 114, 208, 0.62)',
      ],
    },
    offsetY: '-115px',
    opacity: 0.82,
    filter: 'drop-shadow(0 0 4px rgba(0, 229, 255, 0.38)) drop-shadow(0 0 12px rgba(244, 114, 208, 0.18))',
  },
  {
    id: 'lateral-right-frame',
    name: 'right lateral frame',
    assetUrl: lateralDerechoURL,
    anchor: 'center-right',
    width: '300px',
    height: '550px',
    paint: {
      kind: 'linear-gradient',
      direction: '135deg',
      stops: [
        'rgba(0, 229, 255, 0.72)',
        'rgba(139, 92, 246, 0.48) 52%',
        'rgba(244, 114, 208, 0.62)',
      ],
    },
    offsetY: '-180px',
    offsetX: '-95px',
    opacity: 0.82,
    filter: 'drop-shadow(0 0 4px rgba(0, 229, 255, 0.38)) drop-shadow(0 0 12px rgba(244, 114, 208, 0.18))',
  },
  {
    id: 'rightBottom-frame',
    name: 'right bottom frame',
    assetUrl: inferiorDerechaURL,
    anchor: 'bottom-right',
    width: '850px',
    height: '760px',
    paint: {
      kind: 'linear-gradient',
      direction: '135deg',
      stops: [
        'rgba(0, 229, 255, 0.72)',
        'rgba(139, 92, 246, 0.48) 52%',
        'rgba(244, 114, 208, 0.62)',
      ],
    },
    offsetY: '-180px',
    offsetX: '10px',
    opacity: 0.82,
    filter: 'drop-shadow(0 0 4px rgba(0, 229, 255, 0.38)) drop-shadow(0 0 12px rgba(244, 114, 208, 0.18))',
  },
  {
    id: 'left-top-accent',
    name: 'Left top accent',
    assetUrl: superiorIzquierdaUrl,
    anchor: 'top-left',
    width: '390px',
    height: '360px',
    paint: {
      kind: 'linear-gradient',
      direction: '135deg',
      stops: [
        'rgba(0, 229, 255, 0.72)',
        'rgba(139, 92, 246, 0.48) 52%',
        'rgba(244, 114, 208, 0.62)',
      ],
    },
    offsetY: '-50px',
    opacity: 0.82,
    filter: 'drop-shadow(0 0 4px rgba(0, 229, 255, 0.38)) drop-shadow(0 0 12px rgba(244, 114, 208, 0.18))',
  },
];
