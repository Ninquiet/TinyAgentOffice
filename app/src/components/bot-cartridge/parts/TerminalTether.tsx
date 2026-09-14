interface TerminalTetherProps {
  originX: number;
  originY: number;
  lineLength: number;
  lineAngle: number;
  onMinimize: () => void;
}

export function TerminalTether({ originX, originY, lineLength, lineAngle, onMinimize }: TerminalTetherProps) {
  return (
    <>
      <button
        className="terminal-origin-button"
        type="button"
        aria-label="Minimize terminal from tether origin"
        style={{
          left: `${originX}px`,
          top: `${originY}px`,
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onMinimize();
        }}
      />
      <span
        className="terminal-tether-line"
        style={{
          left: `${originX}px`,
          top: `${originY}px`,
          width: `${lineLength}px`,
          transform: `rotate(${lineAngle}rad)`,
        }}
        aria-hidden="true"
      />
    </>
  );
}
