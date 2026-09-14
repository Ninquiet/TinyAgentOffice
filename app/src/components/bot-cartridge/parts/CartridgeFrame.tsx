import { useChamferedOutline } from '../../../hooks/useChamferedOutline';

export function CartridgeFrame() {
  const cartridgeFrame = useChamferedOutline();

  return (
    <div className="cartridge-frame" ref={cartridgeFrame.ref} aria-hidden="true">
      <span className="cartridge-theme-frame-accent" />
      <svg className="cartridge-neon-outline" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polygon points={cartridgeFrame.points} />
      </svg>
    </div>
  );
}
