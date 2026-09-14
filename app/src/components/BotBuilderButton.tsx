import { buttonCompositionToStyle } from '../themes/buttonCompositionTypes';
import { getThemeButtonsComposition } from '../themes/buttonCompositions';

interface BotBuilderButtonProps {
  onOpen: () => void;
  themeId: string;
}

export function BotBuilderButton({ onOpen, themeId }: BotBuilderButtonProps) {
  const buttonComposition = getThemeButtonsComposition(themeId).botBuilder;

  return (
    <button
      className="bot-builder-button"
      style={buttonCompositionToStyle('builder', buttonComposition)}
      type="button"
      aria-label="Open bot builder screen"
      onClick={onOpen}
    >
      <span className="builder-theme-frame" aria-hidden="true" />
      <span className="builder-theme-icon" aria-hidden="true" />
      <span className="builder-avatar" aria-hidden="true">
        <span className="builder-antenna" />
        <span className="builder-head">
          <span className="builder-eye builder-eye-left" />
          <span className="builder-eye builder-eye-right" />
          <span className="builder-mouth" />
        </span>
        <span className="builder-body" />
        <span className="builder-arm builder-arm-left" />
        <span className="builder-arm builder-arm-right" />
        <span className="builder-hammer">
          <span className="builder-hammer-head" />
          <span className="builder-hammer-handle" />
        </span>
      </span>
    </button>
  );
}
