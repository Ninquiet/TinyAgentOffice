import type { CSSProperties } from 'react';

type CartridgeThemeCoverProps = {
  style?: CSSProperties;
};

export function CartridgeThemeCover({ style }: CartridgeThemeCoverProps) {
  return <span className="cartridge-theme-cover" style={style} aria-hidden="true" />;
}
