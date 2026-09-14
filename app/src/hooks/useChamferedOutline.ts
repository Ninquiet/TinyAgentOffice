import { useLayoutEffect, useRef, useState } from 'react';

function readPixelVariable(element: HTMLElement, variableName: string, fallback: number) {
  const rawValue = window.getComputedStyle(element).getPropertyValue(variableName).trim();
  const parsed = Number.parseFloat(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildPolygonPoints(element: HTMLElement) {
  const width = Math.max(1, element.clientWidth);
  const height = Math.max(1, element.clientHeight);
  const cut = Math.min(readPixelVariable(element, '--card-cut', 30), width / 2 - 1, height / 2 - 1);
  const x = (cut / width) * 100;
  const y = (cut / height) * 100;

  return `${x},0 ${100 - x},0 100,${y} 100,${100 - y} ${100 - x},100 ${x},100 0,${100 - y} 0,${y}`;
}

export function useChamferedOutline() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [points, setPoints] = useState('13.5,0 86.5,0 100,19.2 100,80.8 86.5,100 13.5,100 0,80.8 0,19.2');

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    function update() {
      if (!ref.current) return;
      setPoints(buildPolygonPoints(ref.current));
    }

    update();

    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(element);

    const themeObserver = new MutationObserver(update);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });

    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  return { ref, points };
}
