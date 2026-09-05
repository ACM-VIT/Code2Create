import { useEffect, useRef } from "react";

interface GameMenuProps {
  onClose: () => void;
  /** Only needed while the menu still gates the start of play. */
  onContinue?: () => void;
  showContinue?: boolean;
}

export function GameMenu({ onClose, onContinue, showContinue = true }: GameMenuProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  return (
    <div className="overlay-backdrop">
      <section className="game-menu wood-board" role="dialog" aria-modal="true" aria-label="Game menu">
        <div className="menu-topline"><strong>Menu</strong><button ref={closeRef} className="icon-button" type="button" aria-label="Close menu" onClick={onClose}>×</button></div>
        <section><h2>Shortcuts</h2><p>A / D or ← / → move · Space rotates · Enter drops · Esc opens menu</p></section>
        <section><h2>How to play</h2><p>Stack each object to earn 100 points. Each of your three lives starts with a fresh stack; your personal best is saved.</p></section>
        {showContinue && onContinue && <button className="action-button action-button--primary menu-continue-button" type="button" onClick={onContinue}>Continue</button>}
      </section>
    </div>
  );
}
