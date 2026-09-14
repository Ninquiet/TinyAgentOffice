import type { CSSProperties } from 'react';

export interface PaperFlight {
  id: string;
  from: DOMRect;
  to: DOMRect;
}

interface PaperFlightLayerProps {
  flights: PaperFlight[];
}

export function PaperFlightLayer({ flights }: PaperFlightLayerProps) {
  return (
    <div className="paper-flight-layer" aria-hidden="true">
      {flights.map((flight) => (
        <span
          key={flight.id}
          className="paper-flight"
          style={{
            '--paper-from-x': `${flight.from.left + flight.from.width / 2}px`,
            '--paper-from-y': `${flight.from.top + flight.from.height / 2}px`,
            '--paper-to-x': `${flight.to.left + flight.to.width / 2}px`,
            '--paper-to-y': `${flight.to.top + flight.to.height / 2}px`,
          } as CSSProperties}
        />
      ))}
    </div>
  );
}
