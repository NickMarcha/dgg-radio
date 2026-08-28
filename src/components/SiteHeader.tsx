import type { ReactNode } from 'react';
import './SiteHeader.css';

interface SiteHeaderProps {
  children?: ReactNode;
}

export default function SiteHeader({ children }: SiteHeaderProps) {
  return (
    <header className="topbar">
      <div className="brand-block">
        <a className="brand" href="/player" aria-label="DGG Radio home">
          <span className="emote pepeJAM" aria-hidden="true" />
          <span>DGG Radio</span>
          <span className="emote YAM" aria-hidden="true" />
          <span className="beta-badge">beta</span>
        </a>
        <span className="disclaimer">Not affiliated with destiny.gg</span>
      </div>
      {children}
    </header>
  );
}
