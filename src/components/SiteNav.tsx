interface SiteNavProps {
  active?: 'room' | 'stats' | 'history';
}

const links = [
  { key: 'room', href: '/', label: 'Room' },
  { key: 'stats', href: '/stats', label: 'Stats' },
  { key: 'history', href: '/history', label: 'History' },
] as const;

export default function SiteNav({ active }: SiteNavProps) {
  return (
    <nav className="site-nav" aria-label="DGG Radio">
      <div>
        {links.map((link) => (
          <a key={link.key} href={link.href} aria-current={active === link.key ? 'page' : undefined}>
            {link.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
