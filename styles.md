# Destiny.gg visual design reference

This analysis records the rendered homepage at <https://www.destiny.gg/> on 2026-08-28. The desktop measurements came from a 2,048 by 1,146 viewport. Responsive behavior was checked at 390 by 844. The stream was offline during inspection, so the hero showed its offline state.

The page loaded its main styles from <https://cdn.destiny.gg/web.23f4f428c1306c261128.css>. That filename is content-hashed and may change after a deployment.

## Overall character

The page is a near-black editorial canvas with one concentrated piece of branded artwork around the stream hero. Most sections sit directly on the page instead of inside panels. Cards appear only where the content needs a bounded object, mainly upcoming events.

Hierarchy comes from large Poppins headings, generous vertical space, thumbnail grids, and electric-blue rules. Shadows and colored surfaces are rare. This keeps the long homepage from turning into a stack of dark rectangles.

## Color system

- Page background: `#111113`
- Default surface and secondary button background: `#18191b`
- Featured event surface: `#111927`
- Featured event border: `#205d9e`
- Primary action and section rule: `#0090ff`
- Active navigation and blue badge background: `#0d2847`
- Light blue text: `#70b8ff`
- Main text: `#edeef0`
- Strong white text on primary actions: `#ffffff`
- Muted metadata: `#777b84`
- Neutral border: `#43484e`
- Offline preview background: `#18428d`

Red and green are reserved for semantic event badges. The red badge uses `#3b1219` with `#ff9592` text and a `#72232d` border. The green badge uses `#0f2e22` with `#1fd8a4` text and a `#1b5745` border.

The upper-page illustration supplies brighter cyan, violet, and royal blue. Those colors stay in the artwork rather than spreading into ordinary components.

## Typography

The display face is Poppins with a system sans-serif fallback. Inter is used for navigation, body copy, buttons, metadata, and most media titles.

- Main and section headings: Poppins 600 at `36px/36px`
- Mobile section headings: about `30.08px/30.08px` for the standard section-header component
- Event and product titles: Poppins 600 at `24px/24px`
- Media titles: Inter 500 at `17.92px/28px`
- Body and navigation: Inter 400 or 500 at `16px/24px`
- Buttons and metadata: Inter at `14.08px/20px`
- Badges: Inter 600 at `12px/18px`

Headings use normal letter spacing and sentence case. Weight and size provide the emphasis. There are no eyebrow labels or decorative all-caps section names.

## Desktop layout

The shared content wrapper is 1,152px wide and centered. At the inspected viewport it begins 440px from the left edge. The page header is 88px tall with `24px 32px` padding and a 32px gap between navigation groups.

The stream preview is 704px wide and aligned to the left side of the wrapper. Its image area uses a 16:9 ratio. In the offline state it has a flat `#18428d` background, centered sleeping-Destiny artwork, square corners, and a soft blue glow. The larger moon and character illustration is positioned independently behind the upper-right portion of the page.

Homepage sections are separated by 128px. A section uses a 40px internal gap between its heading and content. Each section heading has an 8px blue rule below it. The rule is slightly shorter than the heading instead of spanning the container.

Upcoming events use three columns of about 357px with a 40px gap. Media and merchandise use four 264px columns with a 32px gap. Video thumbnails keep a 16:9 ratio and square corners. Merchandise images are square and do not add a card surface behind the product.

The About section uses a 792px text column and a 320px portrait with a 40px column gap. The portrait is the main rounded image on the page, at 14px. The footer returns to the same 1,152px wrapper and sits 128px below the About section.

## Components

Primary buttons use `#0090ff`, white text, and no border. Secondary buttons use `#18191b` with a one-pixel `#43484e` border. Large hero actions are 48px tall with 24px horizontal padding. Smaller actions are 40px tall with 16px horizontal padding. Both use a 10px radius.

Event cards use 24px padding, a 16px internal gap, a 12px radius, and a one-pixel border. The first event is treated as featured with a dark blue surface, blue border, and a restrained `0 0 64px` blue glow. The remaining cards use the neutral surface and border without the glow.

Badges are the main pill-shaped exception. They are 24px tall, use 12px horizontal padding, and communicate delivery mode or event type. Their full rounding is functional rather than decorative.

The interface uses simple outline icons at roughly 16 to 20px. Most links and media items have no background container. Shadows appear only on the offline preview and featured event card.

## Mobile behavior

At 390px, content uses 32px side gutters and a 311px working width. The header stays 88px tall. Social links, desktop navigation, and the login button disappear. A menu button remains on the left and the 140 by 40 logo is centered.

The hero starts immediately below the header. Its preview shrinks to the content width, while the larger illustration becomes a 1,000px-tall background behind the hero and the start of the events section. The primary chat button becomes full width. Subscribe and Donate share the next row.

Section spacing drops from 128px to 48px, and internal section gaps drop from 40px to 16px. Events become a full-bleed horizontal scroller with 326px cards, a 12px gap, and carousel dots. Video and merchandise grids show one item per section until the user expands them. The About section becomes one column and reduces the portrait to 160 by 224.

## Direction for DGG Radio

The strongest ideas to carry over are the direct-on-canvas layout, the narrow blue accent vocabulary, and the use of artwork in one deliberate area. Keep the player as the primary visual object. Queue, history, and room controls can sit directly on the base background or use a neutral one-pixel divider instead of each receiving a card.

Use `#0090ff` for the main playback action, active navigation, focus states, and short section rules. Do not use it as a general surface color. Keep red and green for actual status or moderation meaning.

Ten to twelve pixels is the established corner range for controls and cards. Full pills make sense for compact statuses only. A blue glow should identify one featured or live object, not every interactive element.

The 128px desktop section spacing works for a marketing homepage but is too loose for a shared radio room. A denser 24px to 48px rhythm will preserve the visual language without making the controls feel disconnected.

The mobile hero shows the risk of placing text over detailed artwork. If DGG Radio uses a similar illustration, keep a predictable dark region behind labels and playback controls. Emotes can add the community character elsewhere without becoming decorative badges on every panel.
