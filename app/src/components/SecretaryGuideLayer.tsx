import type { CSSProperties } from 'react';

export interface SecretaryGuide {
  id: string;
  from: DOMRect;
  to: DOMRect;
}

interface SecretaryGuideLayerProps {
  guides: SecretaryGuide[];
}

export function SecretaryGuideLayer({ guides }: SecretaryGuideLayerProps) {
  return (
    <div className="secretary-guide-layer" aria-hidden="true">
      {guides.map((guide) => (
        <span
          key={guide.id}
          className="secretary-guide-sprite"
          style={{
            '--secretary-from-x': `${guide.from.left + guide.from.width / 2}px`,
            '--secretary-from-y': `${guide.from.top + guide.from.height / 2}px`,
            '--secretary-to-x': `${guide.to.left + guide.to.width / 2}px`,
            '--secretary-to-y': `${guide.to.top + guide.to.height / 2}px`,
          } as CSSProperties}
        >
          <span />
        </span>
      ))}
    </div>
  );
}
