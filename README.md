# Triplipi — Travel Discovery Platform

A premium, editorial-quality travel discovery platform: server-rendered frontend + a brand-styled admin CMS that controls every section of the site.

## Quick start

```bash
npm install        # once
npm start          # → http://localhost:3000
```

- **Site** → http://localhost:3000
- **Admin panel** → http://localhost:3000/admin (default login: `admin` / `triplipi2026` — change it from the dashboard)

## Architecture

| Layer | Choice | Why |
|---|---|---|
| Server | Node.js + Express | matches the zero-build vanilla-JS frontend |
| Templates | Nunjucks (server-rendered) | rendered DOM is identical to the original static site |
| Content store | `server/data/content.json` | no DB server needed; swap for Postgres later without touching templates |
| Admin | custom, schema-driven | every section = one schema entry in `server/app.js`; brand-styled |

```
server/
  app.js            Express app, routes, auth, admin schemas
  store.js          JSON content store (atomic writes)
  seed.js           rebuilds content.json from seed-source/ (overwrites live content!)
  data/content.json all site content (single source of truth — BACK THIS UP)
  data/admin.json   admin credentials (hashed)
views/
  *.njk             page templates
  partials.js.njk   header/footer/nav — CMS-driven
  admin/            admin panel templates
assets/             css / js / favicon / uploads (admin image uploads — BACK THIS UP)
seed-source/        original static HTML (reference + seed input only; not served)
```

### What the admin controls
- **Global** — brand name, header nav links (add/remove/reorder), header CTA button, contact email, copyright
- **Homepage** — hero (headline/lead/image/buttons), all section headings, the 12 featured destination cards, the 12 travel-highlight cards, ask-for-guidance block
- **Content collections** — announcements, packages, blog (featured/side/grid), gallery, picks, destinations listing — full CRUD with reordering
- **Page titles** — title + intro for every listing page, about and contact

Notes:
- Admin edits are live immediately (no restart). `npm run seed` resets content to the original static HTML — it overwrites live edits; restart the server after.
- Images can be pasted as URLs or uploaded from the computer (stored in `assets/uploads/`).

## Deployment

```bash
npm install --omit=dev
NODE_ENV=production PORT=3000 npm start     # or: node server/app.js
```

Checklist before going live:
1. **Change the admin password** — Admin → Site Settings → Admin password (a warning banner shows until you do).
2. **Run behind HTTPS** — put nginx/Caddy in front as a reverse proxy; the app listens on plain HTTP.
3. **Keep it alive** — use a process manager: `pm2 start server/app.js --name triplipi` (or a systemd unit).
4. **Back up two things**: `server/data/` (all content + credentials) and `assets/uploads/` (uploaded media). Together they are the entire site state.
5. Sessions are in-memory: a server restart signs admins out (they just log in again).

Production behaviour: templates are cached (`NODE_ENV=production`), error responses never leak stack traces (errors are logged to stdout).

---

## Design Philosophy

**Luxury editorial meets cinematic immersion.** Think *Aman Resorts × National Geographic × Polarsteps* — a quietly confident magazine voice, large editorial typography, parallax photography, and ample whitespace.

- Display typeface: **Fraunces** (variable, opsz 9-144, with optical italic accents on key headlines)
- Text typeface: **Manrope**
- Monospace: **JetBrains Mono** (used for labels, kickers, metadata)
- Italic Fraunces is used as an editorial flourish throughout — *"The world, slowly"*, *"Twenty places that belong on a list"*, etc.

### Color Palette

| Token | Use |
|---|---|
| `--c-bone` `#f5efe6` | Warm cream — page backgrounds |
| `--c-paper` `#ffffff` | Pure white surfaces |
| `--c-ink` `#0d1b2a` | Deep midnight — primary text, dark sections |
| `--c-gold` `#c9a961` | Sunset gold — primary accent |
| `--c-gold-deep` `#a78947` | Deeper gold — links, italic emphasis |
| `--c-ember` `#d96e4b` | Warm ember — alerts, sponsored badges |

All colors, spacing, radii, durations, and easings live as CSS custom properties in `assets/css/tokens.css`.

---

## File Architecture

```
Triplipi/
├── index.html                  ← Home (cinematic hero, featured grid, stats, blog, packages)
├── destinations.html           ← Destination listing with category filter
├── destination-detail.html     ← Single destination with 7 sub-sections + sidebar
├── trip.html                   ← "Go For A Trip" 7-step planner funnel
├── packages.html               ← All packages with filters
├── package-detail.html         ← Single package with tabs and summary sidebar
├── blog.html                   ← Journal landing (magazine layout)
├── blog-post.html              ← Single article (dropcap, pull-quote, bleed images)
├── picks.html                  ← Our Picks (4 lists × 20 destinations)
├── gallery.html                ← Masonry gallery (images + videos with lightbox)
├── shop.html                   ← License photography (selection panel + quote form + Shutterstock tab)
├── announcements.html          ← Master list of all announcements
├── about.html                  ← Story, mission, offerings
├── contact.html                ← Contact form (mandatory phone) + multi-channel info
├── search.html                 ← Search results page
├── legal.html                  ← Legal page template (?p=privacy|terms|usage|cookies|copyright|disclaimer|affiliate|faq)
├── 404.html                    ← Error page
└── assets/
    ├── css/
    │   ├── tokens.css          ← Design tokens (CSS custom properties)
    │   ├── base.css            ← Reset + typography baseline
    │   ├── layout.css          ← Header, mega-menus, mobile nav, footer
    │   ├── components.css      ← Buttons, cards, forms, modals, lightbox, etc.
    │   ├── animations.css      ← Keyframes, reveals, counters, marquee
    │   └── pages.css           ← Per-page layouts and section styles
    ├── js/
    │   ├── partials.js         ← Injects header/footer/search/consent/lightbox/loader
    │   └── main.js             ← All interactions (nav, modal, lightbox, shop, reveals, etc.)
    └── img/                    ← (empty — page imagery comes from Unsplash URLs)
```

---

## Reusable Patterns

### Page Boilerplate

Every page follows the same skeleton:

```html
<!doctype html>
<html lang="en">
<head>
  <!-- meta + fonts + 6 CSS files -->
</head>
<body>
  <div data-partial="loader"></div>
  <div data-partial="header"></div>

  <main>
    <!-- page content -->
  </main>

  <div data-partial="footer"></div>
  <div data-partial="search"></div>
  <div data-partial="consent"></div>
  <div data-partial="lightbox"></div>

  <script src="assets/js/partials.js"></script>
  <script src="assets/js/main.js"></script>
</body>
</html>
```

The `partials.js` script injects the header, footer, search overlay, consent modal, lightbox, and loader on every page — so they only need to be maintained in one place.

### External Links + Consent Modal

Any link going to a third-party site is flagged with `data-external`:

```html
<a href="#" data-external data-provider="ProviderName" data-url="https://provider.com">
  Visit provider →
</a>
```

`main.js` intercepts the click and shows the consent modal with two required checkboxes (affiliate disclosure + data sharing consent) before any redirect occurs.

### Animations & Reveals

- `data-reveal` — fades and translates in when the element enters the viewport
- `data-reveal="left|right|scale|mask"` — variant directions
- `data-stagger` — applies a sequential delay to all direct children
- `data-counter="450" data-duration="2000"` — animates a number on entry
- `data-parallax="0.1"` — subtle parallax translation on scroll
- `data-hover-video` — auto-plays an inner `<video>` on hover

### Lightbox

Any element with `data-lightbox data-src="..." [data-type="video|image"]` opens in the full-screen lightbox on click. Arrow keys and Esc are wired.

### Forms

Any `<form data-form data-success-message="...">` is auto-validated and shows a toast on submit. Required fields turn ember-red on miss.

---

## Spec Compliance (FRS v1.4)

| FRS section | Page(s) | Implementation notes |
|---|---|---|
| FR-HOME-001..017 | `index.html` | Hero, 12-card featured grid, 12 highlights, 20-capacity announcements, journal strip, packages, ask-for-guidance, AdSense slots |
| FR-DEST-001..010 | `destinations.html`, `destination-detail.html` | 100-category filter, 7-subcategory sections per destination, gallery, sidebar with quick facts |
| FR-PICKS | `picks.html` | 4 lists × 20 destinations, ranked rows, Trip/Package CTAs per row, sponsored placements |
| FR-TRIP | `trip.html` | 7-step stepper, category grid, "How it works" dark section |
| FR-PKG | `packages.html`, `package-detail.html` | Sponsored/Affiliate/Quote-only tags, dual-purpose page (filtered from destination or unfiltered from nav), tabs, summary card sidebar |
| FR-BLOG / FR-DEST-013..018 | `blog.html`, `blog-post.html` | Magazine layout, 4 article layouts supported (essay, photo-essay, field notes, guide), dropcap, bleed figures, pull-quote, end CTAs to Trip and Packages |
| FR-GAL | `gallery.html` | Masonry, hover-video preview, lightbox, category filter |
| FR-SHOP | `shop.html` | Serial-numbered tiles, selection panel, quote form with mandatory phone, separate Shutterstock tab (anchor #shutterstock) |
| FR-CONTACT-001..003 | `contact.html` | Phone is `required`, email shown separately as channel block |
| FR-CONSENT-001..008 | All pages via `partials.js` | Modal triggered on every `[data-external]` click, dual checkbox required, provider name + URL surfaced |
| FR-OTHER-008 | `main.js` | Right-click, drag, and copy shortcuts blocked on media |
| FR-PAGES-001 | `about.html` | Introduction, mission/vision, what we offer (3 cards), CTA |
| Legal pages | `legal.html?p=...` | Single template; switches content based on query param (8 documents) |

---

## What's Not Included (by spec)

- **Backend.** No server, no database, no APIs. Forms simulate submission (toast on success).
- **Real consent enforcement on redirects.** The consent modal closes and shows a toast; production would `window.open(pendingHref, '_blank', 'noopener')`.
- **Search backend.** The search overlay does client-side filtering only on pre-rendered demo results. The search results page is also static.
- **Real images.** All photography references Unsplash CDN URLs.
- **Localization.** English only.
- **CMS.** All content is hardcoded.

---

## Browser Support

Designed for modern evergreen browsers:
- Chrome / Edge 100+
- Firefox 100+
- Safari 15.4+

Uses CSS custom properties, CSS Grid, `aspect-ratio`, `clamp()`, `:has()` in places, and modern JS (no transpilation needed). IE / older Safari are not supported.

---

## Quick Start

```bash
# Option 1: Open directly
open index.html

# Option 2: Serve with any static server
python3 -m http.server 8000
# then visit http://localhost:8000

# Option 3: VS Code Live Server extension also works
```

---

## License

UI and code © Triplipi Travel Co. 2026. Photography sourced from Unsplash (CC0). Built per Frontend Requirement Specification v1.4 for Ashutosh AAN eSol.
