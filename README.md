# Triplipi — FRS build

Travel discovery and monetization platform, built to **FRS v1.4**
(`Proj-T/01/24022026-FRS`, prepared for Ashutosh / AAN eSol).

This repository starts as an exact copy of the live Triplipi site and adds every
feature the FRS specifies. The original repository (`kodinav/triplipi`) is left
untouched; all further work happens here.

Express 5 + Nunjucks, no build step. Content lives in `server/data/content.json`
(git-ignored, seeded from `content.default.json` on first run) and is edited
through the admin panel at `/admin`.

```bash
npm install
npm start          # http://localhost:3000
```

---

## FRS coverage

### Home (FR-HOME)
| Requirement | Where |
|---|---|
| 001–004 Header, tabs, sticky, dropdowns | `views/partials.js.njk` |
| 005–007 12 featured locations, Read More | `views/index.njk` |
| 008–009 12 travel highlights, each with its own landing page | highlight cards take a destination **or** a page of their own |
| 010–011 Ask for guidance — email and form | homepage contact block |
| 012–013D Announcements: 20 latest on Home, master list in the menu, 8 link targets, consent on external ones | `resolveAnnouncements()` |
| 014 Up to 10 AdSense slots | Admin → Advertising |
| 015–017 20 sponsored / affiliate placements | `_sponsor.njk`, `sponsorSlots()` |
| 018–021 Consent before every outbound link, contact-form fallback | consent modal, `/package-quote` |
| 022 Footer: social, legal, contact, FAQs | social URLs from Site settings |
| 023–027 50 videos + 50 images, click to play/open, hover to auto-play/enlarge | homepage media wall |

### Destination Guide & Blog (FR-DEST) · Blog (FR-BLOG)
Categories dropdown; category listing; **all seven sub-categories in every
digest** (season, getting there, stay, getting around, what to do, places of
note, good to know); Read More and package CTAs; 450 destinations and 100
categories with many-to-many mapping; 20 videos + 20 images per destination;
20 ad slots per page; unlimited sponsored placements per destination; unified
blog with four layouts, a dedicated **travel story & experience** section, in-post
photos and films, sponsored placements inside posts, Find Trip Deals + Check
Packages prompts on the listing and every post, and four ad slots.

### Go For A Trip (FR-TRIP)
The seven steps, as wired today: `/trip` → categories → destination digests for
that category → the destination page → its packages → package highlights →
consent modal → redirect or stay.

### Check Packages (FR-PKG)
Every linkable package on one page; the **name and thumbnail open the package's
highlights page**; consent before any redirect with a contact-form fallback;
many-to-many grouping; dual behaviour — all packages from the header tab,
destination-filtered from a CTA. No AdSense on this page, per the client.

### Our Picks (FR-PICKS) · Gallery (FR-GAL) · Shop (FR-SHOP)
Four ranked lists of twenty (plus an All view), four ad slots and four sponsored
slots per page; gallery of 50 videos + 50 images with click and hover
behaviour; shop with serial numbers, multi-select, side table, Seek Quote form
routed to the owner, and the Shutterstock link.

### Everything else
Contact (phone mandatory, email shown); About in four sections; eleven legal /
compliance pages, each editable, plus new ones on demand; standalone
Announcements page reached from the menu only; universal embedded links, all
consent-gated; keyword search (partial by default, exact phrase on request or
by quoting the words) across every content type with filters; per-form email
routing.

### Other features (FR-OTHER)
Responsive to any screen; CMS with full CRUD; archiving and auto-expiry;
create pages and links; nine lifecycle actions per item; uploads for images,
video and documents; keyword search; **copy and download protection**; SEO —
meta titles and descriptions per item, schema markup, sitemap; admin dashboard
with traffic and popular content; **image optimisation** (responsive `srcset`,
async decoding, eager hero); banners and animations in five zones; open
standards; browser compatible.

### Consent flow (FR-CONSENT)
One modal before every outbound link: what is shared, the legal disclaimer, two
separate opt-ins, agree redirects, decline stays, and the provider's name filled
in automatically from the CMS.

---

## Admin panel

`/admin` — grouped by job: Content, Pages, Money & partners, Inbox & settings.
Each collection has search, All/Live/Hidden/Archived filters, paging and the
FRS capacity beside the count. The dashboard opens with what needs attention:
unread messages, broken partner links, items expiring within 14 days, and
anything hidden.

Default sign-in is `admin` / `triplipi2026` — the panel nags until it is changed.

## Where data lives

Everything that changes while the site runs — content, the admin login, form
messages, page views and uploaded files — is kept in one data folder:

- **On a server** (Linux or `NODE_ENV=production`): `~/triplipi-frs-data` in the
  hosting account's home folder. Hostinger replaces the app folder on every
  deploy, so data kept inside it (`server/data`, `assets/uploads`) was lost on
  each push; outside it, it survives.
- **Locally:** `server/data` and `assets/uploads`, as before.
- **Anywhere else:** set `DATA_DIR`.

The dashboard footer shows the folder in use, and warns if it would be reset
by a deploy. On first boot in a new folder, any existing files are copied
across. Back this folder up — it is the site.

## Email delivery

Every form (Contact, Ask for Guidance, Shop quote, package enquiry) is saved to
**Admin → Inbox** the moment it is sent. To also have it emailed, set the SMTP
variables from `.env.example` in the host's environment (Hostinger: hPanel →
Node.js app → Environment variables). Each form can go to its own address —
Site settings holds the three routing addresses, each package and sponsored
placement has its own provider email, and the Shop has its quote address. The
dashboard shows a warning until SMTP is configured. SPF and DKIM records for
the sending domain are set at the DNS provider (assumption A5).

## Images

Lazy loading and responsive `srcset` are on every card. Uploaded JPEG, PNG and
WebP files are resized to at most 1600px wide and compressed on upload when the
optional `sharp` package installs cleanly; otherwise the original is kept.
Uploads are served with a 30-day cache.

## Switching ads on

1. Site settings → AdSense: paste the publisher ID and switch ads on
   (Google must approve the site first — assumption A3).
2. Advertising → ad slots: one row per slot, with the section it belongs to.

Until then each slot can show a marked placeholder so you can see where ads
will land.
