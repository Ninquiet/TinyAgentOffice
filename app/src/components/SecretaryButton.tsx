import { useEffect, useState } from 'react';

interface SecretaryButtonProps {
  message?: string;
  notificationCount?: number;
  onOpen?: () => void;
}

const COFFEE_INTERVAL_MS = 35_000;
const COFFEE_VISIBLE_MS = 4_200;

export function SecretaryButton({ message, notificationCount = 0, onOpen }: SecretaryButtonProps) {
  const [coffeeBreakKey, setCoffeeBreakKey] = useState(0);
  const [coffeeBreakActive, setCoffeeBreakActive] = useState(false);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setCoffeeBreakKey((current) => current + 1);
      setCoffeeBreakActive(true);
      window.setTimeout(() => setCoffeeBreakActive(false), COFFEE_VISIBLE_MS);
    }, COFFEE_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="secretary-control">
      {message ? <div className="secretary-speech-bubble">{message}</div> : null}
      <button
        className={`secretary-button ${notificationCount > 0 ? 'secretary-button-has-notifications' : ''}`}
        type="button"
        aria-label="Open secretary notifications"
        onClick={onOpen}
      >
        {notificationCount > 0 ? <span className="secretary-notification">{notificationCount}</span> : null}
        {coffeeBreakActive ? (
          <span
            className="secretary-theme-sprite secretary-theme-sprite-coffee"
            aria-hidden="true"
            key={coffeeBreakKey}
          />
        ) : (
          <span className="secretary-theme-sprite secretary-theme-sprite-typing" aria-hidden="true" />
        )}
        <span className="secretary-button-outline" aria-hidden="true" />
        <span className="secretary-avatar" aria-hidden="true">
          <span className="secretary-hair secretary-hair-left" />
          <span className="secretary-hair secretary-hair-right" />
          <span className="secretary-face">
            <span className="secretary-eye secretary-eye-left" />
            <span className="secretary-eye secretary-eye-right" />
            <span className="secretary-mouth" />
          </span>
          <span className="secretary-neck" />
          <span className="secretary-body" />
          <span className="secretary-arm secretary-arm-left" />
          <span className="secretary-arm secretary-arm-right" />
        </span>
      </button>
    </div>
  );
}
