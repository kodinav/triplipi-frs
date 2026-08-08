/* ============================================================
   Triplipi — Express server + brand-styled admin CMS
   - Server-rendered Nunjucks templates (pixel-identical frontend)
   - JSON content store (server/data/content.json)
   - Schema-driven admin: every section maps to a schema entry
   ============================================================ */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const nunjucks = require('nunjucks');
const multer = require('multer');
const nodemailer = require('nodemailer');
const store = require('./store');

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const ROOT = path.join(__dirname, '..');

/* ---------- view engine ---------- */
const env = nunjucks.configure(path.join(ROOT, 'views'), {
  autoescape: true,
  express: app,
  // Always re-read templates from disk: a git-pull deploy reflects immediately
  // even if the Node process isn't restarted (cheap for a content site).
  noCache: true,
});
app.set('view engine', 'njk');

/* slugify — stable id for linking to detail pages (survives pagination/slicing) */
const slugify = (s) => String(s || '')
  .replace(/&[a-z]+;/gi, ' ').replace(/<[^>]+>/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
env.addFilter('slug', slugify);
env.addFilter('pad3', (n) => String(n == null ? '' : n).padStart(3, '0'));

app.use(express.urlencoded({ extended: true }));

/* ---------- analytics: count public page views (FR-OTHER-010) ---------- */
const ANALYTICS_FILE = path.join(__dirname, 'data', 'analytics.json');
function readAnalytics() {
  try { return JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8')); }
  catch (e) { return { total: 0, pages: {}, days: {} }; }
}
let _analytics = readAnalytics();
let _analyticsDirty = false;
setInterval(() => { if (_analyticsDirty) { fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(_analytics)); _analyticsDirty = false; } }, 10000);
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/admin') && !req.path.startsWith('/assets')
      && !req.path.includes('.') && (req.headers.accept || '').includes('text/html')) {
    _analytics.total += 1;
    _analytics.pages[req.path] = (_analytics.pages[req.path] || 0) + 1;
    const day = new Date().toISOString().slice(0, 10);
    _analytics.days[day] = (_analytics.days[day] || 0) + 1;
    _analyticsDirty = true;
  }
  next();
});
function analyticsSummary() {
  const a = _analytics;
  const top = Object.entries(a.pages).sort((x, y) => y[1] - x[1]).slice(0, 10)
    .map(([path, views]) => ({ path, views }));
  const today = new Date().toISOString().slice(0, 10);
  return { total: a.total, top, today: a.days[today] || 0, days: a.days };
}

/* ---------- external link health checker (D7 / FR-OTHER) ---------- */
async function checkLinks() {
  const d = store.content;
  const urls = new Set();
  (d.sponsored || []).forEach((s) => { if (s.linkUrl) urls.add(s.linkUrl); });
  (d.packages || []).forEach((p) => { if (p.ctaExternal && p.ctaUrl) urls.add(p.ctaUrl); });
  (d.announcements || []).forEach((a) => { if (a.external && a.extUrl) urls.add(a.extUrl); });
  const list = [...urls];
  const results = await Promise.all(list.map(async (url) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 7000);
      let r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
      if (r.status >= 400) r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
      clearTimeout(t);
      return { url, status: r.status, ok: r.status < 400 };
    } catch (e) { return { url, status: 0, ok: false, error: e.name }; }
  }));
  return results;
}

/* ---------- uploads (admin images) ---------- */
const UPLOAD_DIR = path.join(ROOT, 'assets', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const base = path.basename(file.originalname, ext)
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'img';
      cb(null, `${Date.now()}-${base}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },   // 15 MB
  fileFilter: (req, file, cb) =>
    cb(null, /^(image|video)\//.test(file.mimetype)),
});
/* For each 'image' field, an uploaded file (named <field>__file) wins over the URL input */
function applyUploads(schema, req, values) {
  const files = Object.fromEntries((req.files || []).map((f) => [f.fieldname, f]));
  for (const f of schema.fields) {
    if (f.type !== 'image') continue;
    const up = files[f.name + '__file'];
    if (up) values[f.name] = '/assets/uploads/' + up.filename;
  }
  return values;
}

/* ============================================================
   AUTH — single admin user, signed in-memory sessions
   ============================================================ */
const ADMIN_FILE = path.join(__dirname, 'data', 'admin.json');
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
let firstRun = false;
if (!fs.existsSync(ADMIN_FILE)) {
  firstRun = true;
  fs.writeFileSync(ADMIN_FILE, JSON.stringify({
    user: 'admin',
    passHash: sha256('triplipi2026'),   // change via admin → Site Settings → password
  }, null, 2));
}
const DEFAULT_PASS_HASH = sha256('triplipi2026');
const adminCreds = () => JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));

const sessions = new Set();
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
function requireAuth(req, res, next) {
  const sid = getCookie(req, 'tl_admin');
  if (sid && sessions.has(sid)) return next();
  res.redirect('/admin/login');
}

/* ============================================================
   ADMIN SCHEMAS — one entry per controllable section
   type 'object'  -> single form
   type 'list'    -> sortable table + item forms
   field types: text | textarea | url | csv | bool
   ============================================================ */
const SCHEMAS = [
  /* ----- Global ----- */
  { key: 'settings', group: 'Global', label: 'Brand & site basics', type: 'object', path: 'settings',
    fields: [
      { name: 'brandName', label: 'Brand name', ph: 'e.g. Triplipi' },
      { name: 'headerCtaLabel', label: 'Header button label', ph: 'e.g. Shop now' },
      { name: 'headerCtaHref', label: 'Header button link', type: 'url', ph: 'e.g. shop.html' },
      { name: 'contactEmail', label: 'Contact email', ph: 'e.g. hello@triplipi.com' },
      { name: 'copyright', label: 'Copyright line', ph: 'e.g. © 2026 Triplipi. All rights reserved.' },
      { name: 'siteUrl', label: 'Public website address (for SEO)', type: 'url', ph: 'e.g. https://triplipi.com' },
      { name: 'metaDescription', label: 'Default search-engine description', type: 'textarea', ph: 'One or two sentences describing the site, used when a page has none.' },
      { name: 'ogImage', label: 'Default social-share image', type: 'image', ph: 'A wide image shown when the site is shared on social media.' },
    ] },
  { key: 'nav', group: 'Navbar', label: 'Header navigation links', type: 'list', path: 'settings.navLinks',
    itemTitle: 'label',
    fields: [
      { name: 'label', label: 'Label', ph: 'e.g. Gallery' },
      { name: 'href', label: 'Link', type: 'url', ph: 'e.g. /gallery or https://…' },
      { name: 'mega', label: 'Dropdown menu', type: 'select', options: [
        { value: 'none', label: 'No dropdown — plain link' },
        { value: 'destinations', label: 'Opens the Destination categories dropdown' },
        { value: 'trip', label: 'Opens the Go For A Trip dropdown' },
        { value: 'picks', label: 'Opens the Our Picks dropdown' },
      ] },
    ] },
  { key: 'megaMenus', group: 'Navbar', label: 'Dropdown menu links (“View all …”)', type: 'object', path: 'settings.megaMenus',
    fields: [
      { name: 'destHeadLabel', label: 'Destination Guide — top link label', ph: 'View all destinations' },
      { name: 'destHeadHref', label: 'Destination Guide — top link', type: 'url', ph: '/destinations' },
      { name: 'destAllLabel', label: 'Destination Guide — bottom “View all categories” label', ph: 'View all categories' },
      { name: 'destAllHref', label: 'Destination Guide — bottom “View all categories” link', type: 'url', ph: '/destinations' },
      { name: 'tripHeadLabel', label: 'Go For A Trip — top link label', ph: 'Start the 7-step planner' },
      { name: 'tripHeadHref', label: 'Go For A Trip — top link', type: 'url', ph: '/trip' },
      { name: 'tripAllLabel', label: 'Go For A Trip — bottom “View all categories” label', ph: 'View All Categories' },
      { name: 'tripAllHref', label: 'Go For A Trip — bottom “View all categories” link', type: 'url', ph: '/destinations' },
      { name: 'picksHeadLabel', label: 'Our Picks — top link label', ph: 'View all picks' },
      { name: 'picksHeadHref', label: 'Our Picks — top link', type: 'url', ph: '/picks' },
    ] },

  /* ----- Homepage ----- */
  { key: 'hero', group: 'Homepage', label: 'Hero banner', type: 'object', path: 'home.hero',
    fields: [
      { name: 'titleHtml', label: 'Headline (HTML, <em> = accent)', type: 'textarea', richInline: true, ph: 'e.g. The world, <em>slowly</em>.' },
      { name: 'lead', label: 'Lead paragraph', type: 'textarea', richInline: true, ph: 'One or two sentences shown under the headline.' },
      { name: 'bgImage', label: 'Background image', type: 'image' },
      { name: 'ctaPrimaryLabel', label: 'Primary button label', ph: 'e.g. Browse destinations' },
      { name: 'ctaPrimaryHref', label: 'Primary button link', type: 'url', ph: 'e.g. destinations.html' },
      { name: 'ctaSecondaryLabel', label: 'Secondary button label', ph: 'e.g. Plan a trip' },
      { name: 'ctaSecondaryHref', label: 'Secondary button link', type: 'url', ph: 'e.g. trip.html' },
    ] },
  { key: 'featuredHead', group: 'Homepage', label: 'Section heading — Featured Destinations', type: 'object', path: 'home.featuredHead',
    fields: [
      { name: 'overline', label: 'Overline' , ph: 'Small label above the heading, e.g. Travel Highlights' },
      { name: 'titleHtml', label: 'Heading (HTML)', type: 'textarea', richInline: true, ph: 'e.g. Stories from the <em>field</em>.' },
      { name: 'blurb', label: 'Side blurb', type: 'textarea', richInline: true, ph: 'Short text shown beside the heading.' },
    ] },
  { key: 'destinations', group: 'Homepage', label: 'Destination cards (12)', type: 'list', path: 'destinations',
    itemTitle: 'name',
    fields: [
      { name: 'name', label: 'Name', ph: 'e.g. Ladakh' },
      { name: 'slug', label: 'Slug (links: ?d=slug)', ph: 'lowercase, no spaces — e.g. ladakh' },
      { name: 'region', label: 'Region line', ph: 'e.g. North · India' },
      { name: 'season', label: 'Season', ph: 'e.g. Sep – Jan' },
      { name: 'tagline', label: 'Tagline', ph: 'e.g. High desert' },
      { name: 'categories', label: 'Categories', type: 'multiselect', optionsFrom: 'destCategories', optionValue: 'slug', optionLabel: 'label' },
      { name: 'image', label: 'Card image', type: 'image' },
      // ----- detail page (/destination-detail?d=slug) -----
      { name: 'heroImage', label: 'Detail hero image (optional — falls back to card image)', type: 'image' },
      { name: 'lead', label: 'Detail intro line', type: 'textarea', richInline: true, ph: 'One-line summary under the title.' },
      { name: 'altitude', label: 'Quick fact — Altitude', ph: 'e.g. 3,500m+' },
      { name: 'tripLength', label: 'Quick fact — Trip length', ph: 'e.g. 7–14 days' },
      { name: 'currency', label: 'Quick fact — Currency', ph: 'e.g. INR' },
      { name: 'language', label: 'Quick fact — Language', ph: 'e.g. Ladakhi, Hindi' },
      { name: 'difficulty', label: 'Quick fact — Difficulty', ph: 'e.g. Moderate' },
      { name: 'overview', label: 'Overview', type: 'textarea', rich: true },
      { name: 'secSeason', label: 'Sub-section 1 — Season-wise expectations', type: 'textarea', rich: true },
      { name: 'secReach', label: 'Sub-section 2 — How to reach', type: 'textarea', rich: true },
      { name: 'secStay', label: 'Sub-section 3 — Where to stay', type: 'textarea', rich: true },
      { name: 'secTravel', label: 'Sub-section 4 — Getting around', type: 'textarea', rich: true },
      { name: 'secActivities', label: 'Sub-section 5 — Activities to do', type: 'textarea', rich: true },
      { name: 'secLandmarks', label: 'Sub-section 6 — Landmarks to visit', type: 'textarea', rich: true },
      { name: 'secNotes', label: 'Sub-section 7 — Any other notes', type: 'textarea', rich: true },
      // ----- "Read More About Destination" — extra in-depth content shown when expanded -----
      { name: 'extItinerary', label: 'Read more — Suggested itinerary', type: 'textarea', rich: true },
      { name: 'extFood', label: 'Read more — Food & cuisine', type: 'textarea', rich: true },
      { name: 'extCulture', label: 'Read more — Culture & festivals', type: 'textarea', rich: true },
      { name: 'extBudget', label: 'Read more — Costs & budget', type: 'textarea', rich: true },
      { name: 'extFaq', label: 'Read more — Traveller FAQ', type: 'textarea', rich: true },
      { name: 'gallery', label: 'Detail gallery image URLs (comma-separated)', type: 'csv', ph: 'https://… , https://…' },
    ] },
  { key: 'highlightsHead', group: 'Homepage', label: 'Section heading — Travel Highlights', type: 'object', path: 'home.highlightsHead',
    fields: [
      { name: 'overline', label: 'Overline' , ph: 'Small label above the heading, e.g. Travel Highlights' },
      { name: 'titleHtml', label: 'Heading (HTML)', type: 'textarea', richInline: true, ph: 'e.g. Stories from the <em>field</em>.' },
    ] },
  { key: 'highlights', group: 'Homepage', label: 'Highlight cards (12)', type: 'list', path: 'highlights',
    itemTitle: 'title',
    fields: [
      { name: 'title', label: 'Title', ph: 'e.g. Stargazing in Spiti' },
      { name: 'place', label: 'Place', ph: 'e.g. Himachal' },
      { name: 'kicker', label: 'Kicker (small label)', ph: 'e.g. Experience' },
      { name: 'image', label: 'Image', type: 'image' },
    ] },
  { key: 'announceHead', group: 'Homepage', label: 'Section heading — Announcements', type: 'object', path: 'home.announceHead',
    fields: [
      { name: 'overline', label: 'Overline' , ph: 'Small label above the heading, e.g. Travel Highlights' },
      { name: 'titleHtml', label: 'Heading (HTML)', type: 'textarea', richInline: true, ph: 'e.g. Stories from the <em>field</em>.' },
    ] },
  { key: 'blogHead', group: 'Homepage', label: 'Section heading — Blog strip', type: 'object', path: 'home.blogHead',
    fields: [
      { name: 'overline', label: 'Overline' , ph: 'Small label above the heading, e.g. Travel Highlights' },
      { name: 'titleHtml', label: 'Heading (HTML)', type: 'textarea', richInline: true, ph: 'e.g. Stories from the <em>field</em>.' },
    ] },
  { key: 'packagesHead', group: 'Homepage', label: 'Section heading — Packages', type: 'object', path: 'home.packagesHead',
    fields: [
      { name: 'overline', label: 'Overline' , ph: 'Small label above the heading, e.g. Travel Highlights' },
      { name: 'titleHtml', label: 'Heading (HTML)', type: 'textarea', richInline: true, ph: 'e.g. Stories from the <em>field</em>.' },
    ] },
  { key: 'mediaHead', group: 'Homepage', label: 'Section heading — Media wall', type: 'object', path: 'home.mediaHead',
    fields: [
      { name: 'overline', label: 'Overline' , ph: 'Small label above the heading, e.g. In Motion' },
      { name: 'titleHtml', label: 'Heading (HTML)', type: 'textarea', richInline: true, ph: 'e.g. The world, <em>in motion</em>.' },
    ] },
  { key: 'ask', group: 'Homepage', label: 'Ask for Guidance block', type: 'object', path: 'home.ask',
    fields: [
      { name: 'overline', label: 'Overline' , ph: 'Small label above the heading, e.g. Travel Highlights' },
      { name: 'titleHtml', label: 'Heading (HTML)', type: 'textarea', richInline: true, ph: 'e.g. Stories from the <em>field</em>.' },
      { name: 'body', label: 'Body text', type: 'textarea', richInline: true, ph: 'A short paragraph inviting visitors to write in.' },
      { name: 'email', label: 'Email address', ph: 'e.g. hello@triplipi.com' },
    ] },

  /* ----- Collections ----- */
  { key: 'announcements', group: 'Content', label: 'Announcement cards', type: 'list', path: 'announcements',
    itemTitle: 'title',
    fields: [
      { name: 'title', label: 'Title', ph: 'e.g. Stargazing in Spiti' },
      { name: 'excerpt', label: 'Excerpt', type: 'textarea', richInline: true, ph: 'One or two sentences shown under the title.' },
      { name: 'tagLabel', label: 'Tag label', ph: 'e.g. New Package, Limited Time' },
      { name: 'tagClass', label: 'Tag style', ph: 'tag-gold, tag-ember, tag-blush, tag-outline — or leave blank' },
      { name: 'date', label: 'Date', ph: 'e.g. 12 May 2026' },
      { name: 'category', label: 'Filter category', ph: 'package, sale, editorial, shop or affiliate' },
      { name: 'linkLabel', label: 'Link label', ph: 'e.g. Read more' },
      // ----- where this announcement links (FR-HOME-013B/C) -----
      { name: 'section', label: 'Links to section', type: 'select', options: [
        { value: 'destination', label: 'A destination page' },
        { value: 'trip', label: 'Go For A Trip' },
        { value: 'picks', label: 'Our Picks' },
        { value: 'packages', label: 'Check Packages' },
        { value: 'shop', label: 'Shop' },
        { value: 'gallery', label: 'Gallery' },
        { value: 'blog', label: 'A blog post' },
        { value: 'external', label: 'External / affiliate website (consent-gated)' },
        { value: 'url', label: 'Any internal URL' },
      ] },
      { name: 'target', label: 'Target (slug or URL for the section above)', ph: 'e.g. ladakh, or a blog/package slug, or https://…' },
      { name: 'href', label: 'Fallback link (used if no section chosen)', type: 'url', ph: 'e.g. /packages' },
      { name: 'external', label: 'External partner link? (consent modal)', type: 'bool' },
      { name: 'extProvider', label: 'Partner name (if external)', ph: 'e.g. HimalayanRail' },
      { name: 'extUrl', label: 'Partner URL (if external)', type: 'url', ph: 'https://partner-website.com' },
    ] },
  { key: 'packages', group: 'Content', label: 'Package cards', type: 'list', path: 'packages',
    itemTitle: 'title',
    fields: [
      { name: 'title', label: 'Title', ph: 'e.g. Stargazing in Spiti' },
      { name: 'region', label: 'Region · duration', ph: 'e.g. Himachal · 7 days' },
      { name: 'duration', label: 'Duration (shown on card)', ph: 'e.g. 6 Nights / 7 Days' },
      { name: 'description', label: 'Description', type: 'textarea', richInline: true, ph: 'e.g. Kaza, Key Monastery, Chandratal lakes. All meals included.' },
      { name: 'image', label: 'Image', type: 'image' },
      { name: 'categories', label: 'Categories (same list as destinations)', type: 'multiselect', optionsFrom: 'destCategories', optionValue: 'slug', optionLabel: 'label' },
      { name: 'badgeLabel', label: 'Type / badge', ph: 'Sponsored or Affiliate' },
      { name: 'badgeClass', label: 'Badge style', ph: 'tag-gold, tag-affiliate — or leave blank' },
      { name: 'metaSpans', label: 'Meta chips (comma-separated)', type: 'csv', ph: 'e.g. 🏔 Premium, ⭐ 4.9, 🛏 6 nights' },
      { name: 'price', label: 'Price', ph: 'e.g. ₹42,500 — or On request' },
      { name: 'priceUnit', label: 'Price unit', ph: 'e.g. / person — leave blank for on-request' },
      { name: 'ctaLabel', label: 'Button label', ph: 'e.g. Details, Book now' },
      { name: 'ctaHref', label: 'Button link', type: 'url', ph: 'e.g. package-detail.html' },
      { name: 'ctaExternal', label: 'External partner link?', type: 'bool' },
      { name: 'ctaProvider', label: 'Provider / partner name', ph: 'e.g. KeralaLuxe' },
      { name: 'ctaUrl', label: 'Provider website (leave blank → opens the quote form instead)', type: 'url', ph: 'https://partner-website.com' },
      { name: 'providerEmail', label: 'Provider email (quote form is routed here when there is no website)', ph: 'e.g. bookings@partner.com' },
      // ----- detail page (/package-detail?p=index) -----
      { name: 'destinationSlugs', label: 'Applies to destinations', type: 'multiselect', optionsFrom: 'destinations', optionValue: 'slug', optionLabel: 'name' },
      { name: 'overview', label: 'Detail — Overview', type: 'textarea', rich: true },
      { name: 'itinerary', label: 'Detail — Day-by-day itinerary', type: 'textarea', rich: true },
      { name: 'inclusions', label: 'Detail — Inclusions (comma-separated)', type: 'csv', ph: 'All meals, Certified guides, Premium homestays' },
      { name: 'providerInfo', label: 'Detail — About the provider', type: 'textarea', rich: true },
    ] },
  { key: 'blogFeature', group: 'Content', label: 'Featured story', type: 'object', path: 'blog.feature',
    fields: [
      { name: 'title', label: 'Title', ph: 'e.g. Stargazing in Spiti' },
      { name: 'category', label: 'Category line', ph: 'e.g. Essay · Ladakh' },
      { name: 'byline', label: 'Byline', ph: 'e.g. By Editor · 14 min read · 8 May 2026' },
      { name: 'image', label: 'Image', type: 'image' },
    ] },
  { key: 'blogSide', group: 'Content', label: 'Side stories (4)', type: 'list', path: 'blog.side',
    itemTitle: 'title',
    fields: [
      { name: 'title', label: 'Title', ph: 'e.g. Stargazing in Spiti' },
      { name: 'category', label: 'Category line', ph: 'e.g. Essay · Ladakh' },
      { name: 'meta', label: 'Meta', ph: 'e.g. 9 min read · 6 days ago' },
      { name: 'image', label: 'Thumbnail', type: 'image' },
    ] },
  { key: 'blogPosts', group: 'Content', label: 'Post grid', type: 'list', path: 'blog.posts',
    itemTitle: 'title',
    fields: [
      { name: 'title', label: 'Title', ph: 'e.g. Stargazing in Spiti' },
      { name: 'category', label: 'Category line', ph: 'e.g. Essay · Ladakh' },
      { name: 'excerpt', label: 'Excerpt', type: 'textarea', richInline: true, ph: 'One or two sentences shown under the title.' },
      { name: 'bylineSpans', label: 'Byline parts (comma-separated)', type: 'csv', ph: 'e.g. 14 min read, By Editor' },
      { name: 'image', label: 'Thumbnail', type: 'image' },
      { name: 'destinationSlug', label: 'Related destination (for the card’s Know More / Go For A Trip)', type: 'select', optionsFrom: 'destinations', optionValue: 'slug', optionLabel: 'name' },
      // ----- detail page (/blog-post?b=index) -----
      { name: 'layout', label: 'Layout template', type: 'select', options: [
        { value: '1', label: 'Layout 1 — Centered editorial' },
        { value: '2', label: 'Layout 2 — Wide hero' },
        { value: '3', label: 'Layout 3 — Minimal' },
        { value: '4', label: 'Layout 4 — Photo-led' },
      ] },
      { name: 'heroImage', label: 'Hero image (optional — falls back to thumbnail)', type: 'image' },
      { name: 'deck', label: 'Deck / standfirst', type: 'textarea', richInline: true, ph: 'The italic intro under the headline.' },
      { name: 'body', label: 'Article body', type: 'textarea', rich: true },
    ] },
  { key: 'galleryItems', group: 'Content', label: 'Gallery tiles', type: 'list', path: 'galleryItems',
    itemTitle: 'label',
    fields: [
      { name: 'label', label: 'Overlay label', ph: 'e.g. Ladakh or Film · Spiti' },
      { name: 'category', label: 'Category', type: 'select', optionsFrom: 'galleryCategories', optionValue: 'slug', optionLabel: 'label' },
      { name: 'type', label: 'Type', type: 'select', options: [ { value: 'image', label: 'Photograph' }, { value: 'video', label: 'Film / video' } ] },
      { name: 'image', label: 'Thumbnail', type: 'image' },
      { name: 'src', label: 'Full-size image / video', type: 'image' },
      { name: 'alt', label: 'Alt text', ph: 'Short description for accessibility' },
    ] },
  { key: 'picks', group: 'Content', label: 'Ranked picks', type: 'list', path: 'picks',
    itemTitle: 'name',
    fields: [
      { name: 'list', label: 'Which list', type: 'select', optionsFrom: 'pickLists', optionValue: 'key', optionLabel: 'label' },
      { name: 'name', label: 'Name', ph: 'e.g. Ladakh' },
      { name: 'region', label: 'Region line', ph: 'e.g. North · India' },
      { name: 'image', label: 'Thumbnail', type: 'image' },
      { name: 'destinationSlug', label: 'Related destination (for the card’s Know More / Go For A Trip)', type: 'select', optionsFrom: 'destinations', optionValue: 'slug', optionLabel: 'name' },
      { name: 'href', label: 'Link (optional)', type: 'url', ph: 'e.g. packages.html or https://…' },
    ] },


  { key: 'destCategories', label: 'Filter categories', type: 'list', path: 'destCategories',
    itemTitle: 'label',
    fields: [
      { name: 'label', label: 'Label shown on the pill / category card', ph: 'e.g. Mountains' },
      { name: 'slug', label: 'Slug (used to tag destinations & packages)', ph: 'lowercase-with-dashes, e.g. mountains-hills' },
      { name: 'image', label: 'Round card image (shown on the /categories page)', type: 'image' },
    ] },

  { key: 'galleryCategories', label: 'Gallery categories', type: 'list', path: 'galleryCategories',
    itemTitle: 'label',
    fields: [
      { name: 'label', label: 'Label shown on the filter chip', ph: 'e.g. Mountains' },
      { name: 'slug', label: 'Slug (used to tag gallery items)', ph: 'lowercase-with-dashes, e.g. mountains' },
    ] },

  /* ----- Go For A Trip: page copy (the funnel itself is data-driven) ----- */
  { key: 'trip', group: 'Trip', label: 'Go For A Trip — page copy', type: 'object', path: 'trip',
    fields: [
      { name: 'heroTitle', label: 'Hero heading (HTML, <em> = accent)', type: 'textarea', richInline: true, ph: 'e.g. Plan your next escape in <em>seven careful steps</em>.' },
      { name: 'heroLead', label: 'Hero intro', type: 'textarea', richInline: true },
      { name: 'step1Title', label: 'Step 1 — heading (HTML)', type: 'textarea', richInline: true, ph: 'e.g. What kind of trip <em>are you after</em>?' },
      { name: 'step1Body', label: 'Step 1 — intro', type: 'textarea', richInline: true },
    ] },

  /* ----- Our Picks: the four ranked lists ----- */
  { key: 'pickLists', group: 'Trip', label: 'Pick lists (the tabs)', type: 'list', path: 'pickLists',
    itemTitle: 'label',
    fields: [
      { name: 'key', label: 'Slug (used in the URL: /picks?list=slug)', ph: 'lowercase, e.g. beach' },
      { name: 'label', label: 'Tab label', ph: 'e.g. Best Beach Selection' },
      { name: 'meta', label: 'Tab sub-label', ph: 'e.g. 20 beaches' },
      { name: 'heading', label: 'List heading (HTML, <em> = accent)', type: 'textarea', richInline: true, ph: 'e.g. Twenty places that <em>belong on every list</em>.' },
      { name: 'blurb', label: 'List intro paragraph', type: 'textarea', richInline: true },
    ] },

  /* ----- Shop: media licensing archive (FR-SHOP) ----- */
  { key: 'shop', group: 'Shop', label: 'Shop page — headings, tabs & Shutterstock', type: 'object', path: 'shop',
    fields: [
      { name: 'heroTitle', label: 'Page heading (HTML, <em> = accent)', type: 'textarea', richInline: true, ph: 'e.g. License original <em>photography</em>.' },
      { name: 'heroLead', label: 'Intro paragraph', type: 'textarea', richInline: true, ph: 'One or two sentences under the heading.' },
      { name: 'archiveTabLabel', label: 'Archive tab — label', ph: 'e.g. Triplipi Archive' },
      { name: 'archiveTabMeta', label: 'Archive tab — sublabel', ph: 'e.g. Custom licensing · Quote on request' },
      { name: 'ssTabLabel', label: 'Shutterstock tab — label', ph: 'e.g. Shutterstock Portfolio' },
      { name: 'ssTabMeta', label: 'Shutterstock tab — sublabel', ph: 'e.g. Instant licensing · Standard rates' },
      { name: 'ssUrl', label: 'Shutterstock portfolio URL', type: 'url', ph: 'https://www.shutterstock.com/g/yourname' },
      { name: 'ctaTitle', label: 'Bottom strip — heading (HTML)', type: 'textarea', richInline: true, ph: 'e.g. Need it now? Browse our <em>Shutterstock portfolio</em>.' },
      { name: 'ctaBody', label: 'Bottom strip — text', type: 'textarea', richInline: true },
      { name: 'ctaImage1', label: 'Bottom strip — image 1', type: 'image' },
      { name: 'ctaImage2', label: 'Bottom strip — image 2', type: 'image' },
      { name: 'quoteEmail', label: 'Send quote requests to (email)', ph: 'Leave blank to use the site contact email' },
    ] },
  { key: 'shopItems', group: 'Shop', label: 'Shop media (images & footage)', type: 'list', path: 'shopItems',
    itemTitle: 'title',
    fields: [
      { name: 'serial', label: 'Serial / reference', ph: 'e.g. AET-IMG-001' },
      { name: 'title', label: 'Title', ph: 'e.g. Ladakh — High desert at noon' },
      { name: 'type', label: 'Type', type: 'select', options: [ { value: 'photo', label: 'Photograph' }, { value: 'video', label: 'Video / footage' } ] },
      { name: 'badge', label: 'Type badge label', ph: 'e.g. Photograph  or  Video · 4K' },
      { name: 'spec', label: 'Spec line', ph: 'e.g. 12000×8000 · RAW available' },
      { name: 'image', label: 'Image / poster', type: 'image' },
    ] },

  /* ----- Legal documents (footer Legal column + /legal pages) ----- */
  { key: 'legalDocs', label: 'Legal documents', type: 'list', path: 'legalDocs',
    itemTitle: 'navLabel',
    fields: [
      { name: 'navLabel', label: 'Menu label (footer + sidebar)', ph: 'e.g. Privacy Policy' },
      { name: 'slug', label: 'Slug (URL: /legal?p=slug)', ph: 'lowercase, e.g. privacy' },
      { name: 'crumb', label: 'Breadcrumb & browser title', ph: 'e.g. Privacy Policy' },
      { name: 'title', label: 'Page heading (HTML, <em> = accent)', type: 'textarea', richInline: true, ph: 'e.g. Privacy <em>policy</em>.' },
      { name: 'deck', label: 'Intro line under the heading', type: 'textarea', richInline: true, ph: 'One sentence summary shown at the top.' },
      { name: 'body', label: 'Document content', type: 'textarea', rich: true },
      { name: 'inFooter', label: 'Show in footer “Legal” column?', type: 'bool' },
    ] },

  /* ----- Sponsored posts (cross-page banners with a call button) ----- */
  { key: 'sponsored', label: 'Sponsored posts', type: 'list', path: 'sponsored',
    itemTitle: 'title',
    fields: [
      { name: 'title', label: 'Title', ph: 'e.g. Trans-Himalayan Expeditions — Ladakh circuits' },
      { name: 'kind', label: 'Category of the sponsored item', type: 'select', options: [
        { value: 'picture', label: 'Picture' },
        { value: 'package', label: 'Package' },
        { value: 'blog', label: 'Blog' },
        { value: 'trip', label: 'Trip' },
        { value: 'hotel', label: 'Hotel' },
        { value: 'other', label: 'Other' },
      ] },
      { name: 'description', label: 'Short description', type: 'textarea', richInline: true, ph: 'One or two sentences about the partner or offer.' },
      { name: 'image', label: 'Image', type: 'image' },
      { name: 'partner', label: 'Partner name', ph: 'e.g. Trans-Himalayan Expeditions' },
      { name: 'phone', label: 'Phone number (the Call button)', ph: 'e.g. +91 98765 43210' },
      { name: 'callLabel', label: 'Call button label', ph: 'e.g. Call now' },
      { name: 'linkLabel', label: 'Secondary button label (optional)', ph: 'e.g. View packages — leave blank for none' },
      { name: 'linkUrl', label: 'Secondary button link (optional)', type: 'url', ph: 'e.g. packages.html' },
      { name: 'pages', label: 'Show on pages', type: 'multiselect', options: [
        { value: 'gallery', label: 'Gallery' },
        { value: 'packages', label: 'Packages' },
        { value: 'blog', label: 'Blog' },
        { value: 'destinations', label: 'Destinations' },
      ] },
    ] },

  /* ----- Promo banners / animation zones (FR-OTHER-012) ----- */
  { key: 'banners', label: 'Promo banners', type: 'list', path: 'banners',
    itemTitle: 'title',
    fields: [
      { name: 'title', label: 'Internal title', ph: 'e.g. Monsoon sale strip' },
      { name: 'zone', label: 'Where it appears', type: 'select', options: [
        { value: 'site-top', label: 'Thin bar at the very top of every page' },
        { value: 'site-bottom', label: 'Above the footer — every page' },
        { value: 'home-top', label: 'Homepage — below the hero' },
        { value: 'home-mid', label: 'Homepage — mid page' },
        { value: 'home-bottom', label: 'Homepage — above the footer' },
      ] },
      { name: 'style', label: 'Style', type: 'select', options: [
        { value: 'strip', label: 'Slim text strip' },
        { value: 'wide', label: 'Wide image banner' },
      ] },
      { name: 'text', label: 'Headline / message', type: 'textarea', richInline: true, ph: 'e.g. Monsoon sale — up to 35% off Kerala packages.' },
      { name: 'image', label: 'Background / banner image (wide style)', type: 'image' },
      { name: 'ctaLabel', label: 'Button label', ph: 'e.g. See offers' },
      { name: 'href', label: 'Button link', type: 'url', ph: 'e.g. /packages or https://…' },
      { name: 'external', label: 'External partner link? (consent modal)', type: 'bool' },
      { name: 'extProvider', label: 'Partner name (if external)', ph: 'e.g. HimalayanRail' },
      { name: 'extUrl', label: 'Partner URL (if external)', type: 'url', ph: 'https://partner-website.com' },
      { name: 'animate', label: 'Subtle entrance animation?', type: 'bool' },
    ] },

  /* ----- Custom pages (FR-PAGES-010 / FR-OTHER-004) ----- */
  { key: 'customPages', label: 'Custom pages', type: 'list', path: 'customPages',
    itemTitle: 'navLabel',
    fields: [
      { name: 'navLabel', label: 'Menu / title label', ph: 'e.g. Careers' },
      { name: 'slug', label: 'Slug (URL: /p/slug)', ph: 'lowercase-with-dashes, e.g. careers' },
      { name: 'crumb', label: 'Breadcrumb & browser title', ph: 'e.g. Careers at Triplipi' },
      { name: 'title', label: 'Page heading (HTML, <em> = accent)', type: 'textarea', richInline: true, ph: 'e.g. Work <em>with us</em>.' },
      { name: 'deck', label: 'Intro line under the heading', type: 'textarea', richInline: true, ph: 'One sentence shown at the top.' },
      { name: 'heroImage', label: 'Hero image (optional)', type: 'image' },
      { name: 'body', label: 'Page content', type: 'textarea', rich: true },
      { name: 'inFooter', label: 'Show in footer “Company” column?', type: 'bool' },
    ] },

  /* ----- About page sections (FR-PAGES-001) ----- */
  { key: 'about', group: 'About', label: 'About — story, mission & CTA', type: 'object', path: 'about',
    fields: [
      { name: 'storyOverline', label: 'Story — overline', ph: 'e.g. The story' },
      { name: 'storyTitle', label: 'Story — heading (HTML)', type: 'textarea', richInline: true, ph: 'e.g. Triplipi began with a <em>simple frustration</em>.' },
      { name: 'storyImage', label: 'Story — portrait image', type: 'image' },
      { name: 'storyBody', label: 'Story — body', type: 'textarea', rich: true },
      { name: 'missionOverline', label: 'Mission — overline', ph: 'e.g. Mission & Vision' },
      { name: 'missionTitle', label: 'Mission — heading (HTML)', type: 'textarea', richInline: true },
      { name: 'missionBody', label: 'Mission — body', type: 'textarea', rich: true },
      { name: 'offersOverline', label: 'What we offer — overline', ph: 'e.g. What we offer' },
      { name: 'offersTitle', label: 'What we offer — heading (HTML)', type: 'textarea', richInline: true },
      { name: 'ctaOverline', label: 'Contact CTA — overline', ph: 'e.g. Get in touch' },
      { name: 'ctaTitle', label: 'Contact CTA — heading (HTML)', type: 'textarea', richInline: true },
      { name: 'ctaBody', label: 'Contact CTA — body', type: 'textarea', richInline: true },
      { name: 'ctaPrimaryLabel', label: 'CTA — primary button label', ph: 'e.g. Get in touch' },
      { name: 'ctaPrimaryHref', label: 'CTA — primary button link', type: 'url', ph: 'e.g. /contact' },
      { name: 'ctaSecondaryLabel', label: 'CTA — secondary button label', ph: 'e.g. Become a partner' },
      { name: 'ctaSecondaryHref', label: 'CTA — secondary button link', type: 'url', ph: 'e.g. /contact#partner' },
    ] },
  { key: 'aboutStats', group: 'About', label: 'About — stat tiles', type: 'list', path: 'aboutStats',
    itemTitle: 'label',
    fields: [
      { name: 'value', label: 'Number', ph: 'e.g. 450' },
      { name: 'label', label: 'Label', ph: 'e.g. Destinations indexed' },
    ] },
  { key: 'aboutOffers', group: 'About', label: 'About — “what we offer” cards', type: 'list', path: 'aboutOffers',
    itemTitle: 'title',
    fields: [
      { name: 'title', label: 'Card title', ph: 'e.g. A curated destination index' },
      { name: 'body', label: 'Card body', type: 'textarea', rich: true },
      { name: 'linkLabel', label: 'Link label', ph: 'e.g. Browse destinations' },
      { name: 'linkHref', label: 'Link', type: 'url', ph: 'e.g. /destinations' },
    ] },

  /* ----- Homepage pickers — choose which master items are featured ----- */
  { key: 'pick-destinations', label: 'Pick destinations for the homepage', type: 'picker',
    path: 'destinations', itemTitle: 'name' },
  { key: 'pick-announcements', label: 'Pick announcements for the homepage', type: 'picker',
    path: 'announcements', itemTitle: 'title' },
  { key: 'pick-blogPosts', label: 'Pick blog posts for the homepage', type: 'picker',
    path: 'blog.posts', itemTitle: 'title' },
  { key: 'pick-packages', label: 'Pick packages for the homepage', type: 'picker',
    path: 'packages', itemTitle: 'title' },
  { key: 'pick-gallery', label: 'Pick media for the homepage wall', type: 'picker',
    path: 'galleryItems', itemTitle: 'label' },

  /* ----- Page heroes ----- */
  ...['destinations', 'packages', 'blog', 'announcements', 'gallery', 'picks', 'about', 'contact'].map((p) => ({
    key: 'page-' + p,
    group: 'Page Titles',
    label: 'Page title & intro',
    type: 'object',
    path: 'pages.' + p,
    fields: [
      { name: 'titleHtml', label: 'Page title (HTML, <em> = accent)', type: 'textarea', richInline: true, ph: 'e.g. The <em>blog</em>.' },
      { name: 'lead', label: 'Lead paragraph', type: 'textarea', richInline: true, ph: 'One or two sentences shown under the headline.' },
    ],
  })),
];
const schemaByKey = Object.fromEntries(SCHEMAS.map((s) => [s.key, s]));

/* ============================================================
   ADMIN PAGE REGISTRY — the admin is organised by PAGE,
   sections listed in the order they appear on screen.
   ============================================================ */
const ADMIN_PAGES = [
  { key: 'homepage', label: 'Homepage', view: '/',
    intro: 'Every section of the landing page, top to bottom.',
    sections: [
      { key: 'hero', hint: 'The full-screen banner at the very top.' },
      { key: 'featuredHead', hint: 'Heading row above the destination cards.' },
      { key: 'pick-destinations', hint: 'Tick which destinations appear on the homepage. Add or edit them on the Destinations page.' },
      { key: 'highlightsHead', hint: 'Heading row above the floating cards.' },
      { key: 'highlights', hint: 'The 12 floating experience cards.' },
      { key: 'announceHead', hint: 'Heading row of the announcements strip.' },
      { key: 'pick-announcements', hint: 'Tick which announcements appear on the homepage.' },
      { key: 'blogHead', hint: 'Heading row of the blog strip.' },
      { key: 'pick-blogPosts', hint: 'Tick which blog posts appear on the homepage.' },
      { key: 'packagesHead', hint: 'Heading row of the packages strip.' },
      { key: 'pick-packages', hint: 'Tick which packages appear on the homepage.' },
      { key: 'mediaHead', hint: 'Heading row of the media wall (photos & films).' },
      { key: 'pick-gallery', hint: 'Tick which gallery tiles appear on the homepage media wall (films auto-play on hover).' },
      { key: 'ask', hint: 'The cream contact block near the bottom.' },
    ] },
  { key: 'destinations', label: 'Destinations', view: '/destinations',
    intro: 'The destinations index page.',
    sections: [
      { key: 'page-destinations', hint: 'Big title and intro at the top of the page.' },
      { key: 'destinations', hint: 'The master list of destinations. Order here = order everywhere. Tick "homepage" in the Homepage tab to feature one.' },
      { key: 'destCategories', hint: 'The universal category taxonomy — powers the filter pills, the /categories page (add a round image per category), and destination/package tagging. Counts are automatic.' },
    ] },
  { key: 'packages', label: 'Packages', view: '/packages',
    intro: 'All travel packages. The homepage shows the first two automatically.',
    sections: [
      { key: 'page-packages', hint: 'Big title and intro at the top of the page.' },
      { key: 'packages', hint: 'Every package card — pricing, badges, partner links.' },
    ] },
  { key: 'blog', label: 'Blog', view: '/blog',
    intro: 'The blog landing page. The homepage strip shows the first three posts.',
    sections: [
      { key: 'page-blog', hint: 'Big title and intro at the top of the page.' },
      { key: 'blogFeature', hint: 'The large featured story at the top.' },
      { key: 'blogSide', hint: 'The 4 small stories beside the featured one.' },
      { key: 'blogPosts', hint: 'The main grid of posts.' },
    ] },
  { key: 'announcements', label: 'Announcements', view: '/announcements',
    intro: 'All announcements. The homepage shows the 4 newest automatically.',
    sections: [
      { key: 'page-announcements', hint: 'Big title and intro at the top of the page.' },
      { key: 'announcements', hint: 'Every announcement card.' },
    ] },
  { key: 'gallery', label: 'Gallery', view: '/gallery',
    intro: 'Photo and video tiles in the masonry grid.',
    sections: [
      { key: 'page-gallery', hint: 'Big title and intro at the top of the page.' },
      { key: 'galleryItems', hint: 'Every tile. Pick a category from the dropdown; type "Film / video" shows a play button.' },
      { key: 'galleryCategories', hint: 'The filter chips above the grid. Counts are automatic.' },
    ] },
  { key: 'trip', label: 'Go For A Trip', view: '/trip',
    intro: 'The trip-planning funnel. The category tiles are built automatically from your destination categories — edit the page copy here.',
    sections: [
      { key: 'trip', hint: 'Hero heading/intro and the Step 1 heading. The category tiles below pull from Destinations automatically.' },
    ] },
  { key: 'picks', label: 'Our Picks', view: '/picks',
    intro: 'Four ranked lists, shown as tabs. Each pick is tagged to a list; rank numbers come from the order within that list.',
    sections: [
      { key: 'page-picks', hint: 'Big title and intro at the top of the page.' },
      { key: 'pickLists', hint: 'The tabs across the top — each is one ranked list. Order here sets the tab order; the first tab opens by default.' },
      { key: 'picks', hint: 'Every ranked place. Set "Which list" so it shows under the right tab; order within each list sets its rank.' },
    ] },
  { key: 'shop', label: 'Shop', view: '/shop',
    intro: 'The photography & footage licensing page — media tiles, Shutterstock link, and the quote form.',
    sections: [
      { key: 'shop', hint: 'Page headings, the two tab labels, your Shutterstock URL, the bottom strip, and where quote requests are emailed.' },
      { key: 'shopItems', hint: 'Every licensable image/video. Each becomes a selectable tile; visitors add items and request a quote — which lands in Messages (and is emailed if SMTP is set).' },
    ] },
  { key: 'about', label: 'About', view: '/about',
    intro: 'The About page — hero, owner story, mission, what you offer, and the contact CTA.',
    sections: [
      { key: 'page-about', hint: 'Hero title and intro at the top of the page.' },
      { key: 'about', hint: 'The four sections: owner story, mission & vision, “what we offer” heading, and the contact call-to-action.' },
      { key: 'aboutStats', hint: 'The number tiles in the Mission section (e.g. 450 destinations).' },
      { key: 'aboutOffers', hint: 'The “what we offer” cards (the three things you do).' },
    ] },
  { key: 'contact', label: 'Contact', view: '/contact',
    intro: 'Title and intro of the Contact page.',
    sections: [{ key: 'page-contact', hint: 'Big title and intro at the top of the page.' }] },
  { key: 'legal', label: 'Legal Pages', view: '/legal',
    intro: 'The legal documents shown at /legal and linked in the footer "Legal" column. Edit each one’s full content here.',
    sections: [
      { key: 'legalDocs', hint: 'Each document’s heading, intro and full body. “Show in footer” controls the footer Legal column; reorder to set the footer + sidebar order.' },
    ] },
  { key: 'banners', label: 'Promo Banners', view: '/',
    intro: 'Promotional banners and animation strips placed in fixed zones across the site. Use Status to schedule or hide each one.',
    sections: [
      { key: 'banners', hint: 'Pick a zone (site-wide top bar, or below/mid the homepage). Slim strips show text + a button; wide banners show your image. External links open the consent modal.' },
    ] },
  { key: 'pages', label: 'Custom Pages', view: '/',
    intro: 'Build standalone pages (Careers, Press, FAQs…) that live at /p/your-slug. Optionally link them in the footer.',
    sections: [
      { key: 'customPages', hint: 'Each page has a heading, intro, optional hero image and a full rich-text body. “Show in footer” adds it to the footer Company column.' },
    ] },
  { key: 'navbar', label: 'Navbar', view: '/', isSettings: true,
    intro: 'The links in the header navigation bar. Drag the handle to reorder, edit a label or link, or add a new one. A link can optionally open one of the built-in dropdown menus.',
    sections: [
      { key: 'nav', hint: 'Each header link: its label, where it points, and (optionally) which dropdown it opens. Drag ⠿ to reorder; “+ Add item” for a new link.' },
      { key: 'megaMenus', hint: 'The “View all …” links inside the dropdown menus — their text and where they go.' },
    ] },
  { key: 'site', label: 'Site Settings', view: '/', isSettings: true,
    intro: 'Brand, header button, footer and admin security.',
    sections: [
      { key: 'settings', hint: 'Brand name, header button, contact email, copyright.' },
    ] },
];
const adminPageByKey = Object.fromEntries(ADMIN_PAGES.map((p) => [p.key, p]));
const pageOfSection = {};
for (const p of ADMIN_PAGES) for (const s of p.sections) pageOfSection[s.key] = p.key;
const backTo = (sectionKey, saved) =>
  `/admin/page/${pageOfSection[sectionKey] || ''}${saved ? '?saved=1' : ''}#sec-${sectionKey}`;

/* ============================================================
   FRONTEND ROUTES — same URLs as the static site
   ============================================================ */
/* partials.js rendered from template so header/footer are CMS-driven */
app.get('/assets/js/partials.js', (req, res) => {
  res.type('application/javascript');
  // CMS-driven (header/footer/nav change with content) — always revalidate so
  // edits show immediately instead of serving a stale cached copy.
  res.set('Cache-Control', 'no-cache, must-revalidate');
  const resolveB = (b) => ({ ...b, href: b.section === 'external' || b.external ? (b.extUrl || b.href) : b.href });
  const zones = bannersByZone();
  const siteTop = (zones['site-top'] || []).map(resolveB);
  const siteBottom = (zones['site-bottom'] || []).map(resolveB);
  // Mega-menu categories: real destination categories (with counts), up to 8
  const dests = pub(store.get('destinations') || []);
  const navCategories = (store.get('destCategories') || [])
    .map((cat) => ({ slug: cat.slug, label: cat.label, count: dests.filter((d) => (d.categories || []).includes(cat.slug)).length }))
    .filter((cat) => cat.count > 0)
    .slice(0, 8);
  res.render('partials.js.njk', {
    settings: store.get('settings'),
    legalDocs: store.get('legalDocs') || [],
    customPages: pub(store.get('customPages') || []).filter((p) => p.inFooter),
    siteTopBanners: siteTop,
    siteBottomBanners: siteBottom,
    navCategories,
    pickLists: store.get('pickLists') || [],
  });
});
app.use('/assets', express.static(path.join(ROOT, 'assets')));

const c = () => store.content;

/* 24-per-page pagination: ?page=N (clamped). Controls render only if pages > 1 */
const PER_PAGE = 24;
function paginate(all, req) {
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  let page = parseInt((req && req.query && req.query.page) || '1', 10);
  if (Number.isNaN(page)) page = 1;
  page = Math.min(Math.max(1, page), pages);
  return {
    items: all.slice((page - 1) * PER_PAGE, page * PER_PAGE),
    pagination: { page, pages, total, offset: (page - 1) * PER_PAGE },
  };
}

/* Every sponsored item targeting the page gets a slot, spread evenly through
   the grid: { itemIndexInGrid: sponsoredItem }. Items without a title are
   treated as drafts and skipped. */
function sponsorSlots(pageKey, count) {
  const matching = (c().sponsored || [])
    .filter((sp) => (sp.pages || []).includes(pageKey) && (sp.title || '').trim());
  const slots = {};
  matching.forEach((sp, j) => {
    let pos = Math.floor(((j + 1) * count) / (matching.length + 1));
    while (slots[pos] !== undefined) pos += 1;   // avoid collisions on tiny grids
    slots[pos] = sp;
  });
  return slots;
}

/* Hide archived, unpublished, or expired items from the public site
   (FR-OTHER-003 archive, 003A auto-expiry, 005 publish/hide). Admin sees all. */
function isVisible(item) {
  if (!item || typeof item !== 'object') return true;
  if (item.archived === true) return false;
  if (item.published === false) return false;
  if (item.expiry) {
    const d = new Date(item.expiry);
    if (!Number.isNaN(d.getTime()) && d.getTime() < Date.now()) return false;
  }
  return true;
}
const pub = (arr) => (arr || []).filter(isVisible);

/* Content status overview for the admin dashboard (FR-OTHER-010):
   per-collection counts of live / archived / hidden / scheduled items. */
function contentStats() {
  const d = c();
  const collections = [
    ['Destinations', d.destinations],
    ['Packages', d.packages],
    ['Blog posts', d.blog && d.blog.posts],
    ['Announcements', d.announcements],
    ['Gallery', d.galleryItems],
    ['Our Picks', d.picks],
    ['Shop media', d.shopItems],
    ['Promo banners', d.banners],
    ['Custom pages', d.customPages],
  ];
  const totals = { total: 0, live: 0, archived: 0, hidden: 0, scheduled: 0 };
  const rows = collections.map(([label, raw]) => {
    const arr = raw || [];
    const archived = arr.filter((x) => x && x.archived === true).length;
    const hidden = arr.filter((x) => x && x.archived !== true && x.published === false).length;
    const scheduled = arr.filter((x) => x && x.expiry).length;
    const live = arr.filter(isVisible).length;
    totals.total += arr.length; totals.live += live;
    totals.archived += archived; totals.hidden += hidden; totals.scheduled += scheduled;
    return { label, total: arr.length, live, archived, hidden, scheduled };
  });
  return { rows, totals };
}

/* Resolve an announcement's destination link from its section + target
   (FR-HOME-013B/C). Returns the list with each item's `href` set. */
function resolveAnnouncements(list) {
  return (list || []).map((a) => {
    let href = a.href || '/announcements';
    const t = (a.target || '').trim();
    switch (a.section) {
      case 'destination': href = '/destination-detail?d=' + encodeURIComponent(t); break;
      case 'trip': href = t ? '/trip?d=' + encodeURIComponent(t) : '/trip'; break;
      case 'picks': href = '/picks'; break;
      case 'packages': href = t ? '/packages?d=' + encodeURIComponent(t) : '/packages'; break;
      case 'shop': href = '/shop'; break;
      case 'gallery': href = '/gallery'; break;
      case 'blog': href = '/blog-post?b=' + encodeURIComponent(t); break;
      case 'external': href = a.extUrl || a.href || '#'; break;
      case 'url': if (t) href = t; break;
      default: break;
    }
    return { ...a, href };
  });
}

/* Active promo banners grouped by zone (FR-OTHER-012). */
function bannersByZone() {
  const out = {};
  pub(c().banners).forEach((b) => {
    const zone = b.zone || 'home-top';
    (out[zone] = out[zone] || []).push(b);
  });
  return out;
}

/* Build a flat, typed search index over all content; runSearch filters it */
function searchIndex() {
  const d = c();
  const out = [];
  pub(d.destinations).forEach((x) => out.push({ type: 'Destination', title: x.name, desc: [x.region, x.tagline].filter(Boolean).join(' · '), url: '/destination-detail?d=' + x.slug }));
  pub(d.packages).forEach((x) => out.push({ type: 'Package', title: x.title, desc: x.region || x.description, url: '/package-detail?p=' + slugify(x.title) }));
  pub(d.blog && d.blog.posts).forEach((x) => out.push({ type: 'Blog', title: x.title, desc: x.category || x.excerpt, url: '/blog-post?b=' + slugify(x.title) }));
  pub(d.announcements).forEach((x) => out.push({ type: 'Announcement', title: x.title, desc: x.date || x.excerpt, url: x.href || '/announcements' }));
  pub(d.picks).forEach((x) => out.push({ type: 'Pick', title: x.name, desc: x.region, url: x.href || '/picks' }));
  (d.legalDocs || []).forEach((x) => out.push({ type: 'Page', title: x.crumb, desc: 'Legal', url: '/legal?p=' + x.slug }));
  ['About', 'Contact', 'Gallery', 'Shop'].forEach((p) => out.push({ type: 'Page', title: p, desc: '', url: '/' + p.toLowerCase() }));
  return out;
}
function runSearch(q) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return [];
  return searchIndex()
    .filter((it) => (it.title + ' ' + (it.desc || '')).toLowerCase().includes(query))
    .sort((a, b) => (a.title.toLowerCase() === query ? 0 : 1) - (b.title.toLowerCase() === query ? 0 : 1));
}

/* Clean URLs: /page is canonical; legacy /page.html 301-redirects to it */
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    const clean = req.path.slice(0, -5);
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return res.redirect(301, (clean === '/index' ? '/' : clean) + qs);
  }
  next();
});

/* ============================================================
   SEO — canonical URLs, per-page meta, schema.org JSON-LD
   ============================================================ */
function siteOrigin(req) {
  const s = c().settings || {};
  const u = (s.siteUrl || '').trim().replace(/\/+$/, '');
  if (u) return u;
  return req.protocol + '://' + req.get('host');
}
function absUrl(req, p) {
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  return siteOrigin(req) + (String(p).startsWith('/') ? p : '/' + p);
}
const plain = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = plain(s); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

// Friendly titles for the static / listing pages (path -> title fragment)
const PAGE_TITLES = {
  '/': 'A Travel Discovery Platform',
  '/destinations': 'Destinations',
  '/categories': 'Browse by Category',
  '/packages': 'Travel Packages',
  '/blog': 'The Journal',
  '/announcements': 'Announcements',
  '/gallery': 'Gallery',
  '/picks': 'Our Picks',
  '/about': 'About Us',
  '/contact': 'Contact',
  '/trip': 'Go For A Trip',
  '/shop': 'Shop',
  '/legal': 'Legal',
  '/search': 'Search',
};
function defaultSeo(req) {
  const s = c().settings || {};
  const brand = s.brandName || 'Triplipi';
  const frag = PAGE_TITLES[req.path];
  return {
    brand,
    title: frag ? frag + ' — ' + brand : brand,
    description: clip(s.metaDescription, 300) || 'A premium discovery platform for the discerning traveller. Curated destinations, verified packages, and original travel photography.',
    canonical: absUrl(req, req.path === '/' ? '/' : req.path),
    image: absUrl(req, s.ogImage || ''),
    type: 'website',
    robots: 'index, follow',
    jsonLd: null,
  };
}
// Build SEO defaults for every public request; detail builders override via returned `seo`.
app.use((req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/assets')) return next();
  try {
    res.locals.seo = defaultSeo(req);
    res.locals.banners = bannersByZone();
  } catch (e) { /* settings not ready */ }
  next();
});

/* Best-matching affiliate package for a destination — shared by the destination
   detail page and the blog cards' "Go For A Trip" consent flow. Prefer a package
   tagged to the destination, else most category overlap, else any affiliate. */
function bestAffiliate(dest) {
  if (!dest) return null;
  const affPkgs = pub(c().packages || []).filter((p) => p.ctaExternal && (p.ctaUrl || '').trim());
  const destCats = dest.categories || [];
  const overlap = (p) => (p.categories || []).filter((cat) => destCats.includes(cat)).length;
  const aff =
    affPkgs.find((p) => (p.destinationSlugs || []).includes(dest.slug)) ||
    affPkgs.slice().sort((a, b) => overlap(b) - overlap(a)).find((p) => overlap(p) > 0) ||
    affPkgs[0] || null;
  return aff ? { provider: aff.ctaProvider || aff.title, url: aff.ctaUrl } : null;
}

const PAGES = {
  index: (req) => {
    const s = c().settings || {};
    const brand = s.brandName || 'Triplipi';
    return {
      settings: s,
      home: c().home,
      destinations: pub(c().destinations).filter((d) => d.featured).map((d) => ({ ...d, affiliate: bestAffiliate(d) })),
      highlights: pub(c().highlights),
      announcements: resolveAnnouncements(pub(c().announcements).filter((a) => a.featured)),
      blogPosts: pub(c().blog.posts).filter((p) => p.featured),
      packages: pub(c().packages).filter((p) => p.featured),
      mediaItems: pub(c().galleryItems).filter((g) => g.featured).slice(0, 100),
      seo: {
        ...defaultSeo(req),
        title: brand + ' — A Travel Discovery Platform',
        jsonLd: {
          '@context': 'https://schema.org', '@type': 'TravelAgency',
          name: brand, url: siteOrigin(req), areaServed: 'Worldwide',
          description: clip(s.metaDescription, 300) || 'A curated travel discovery platform with verified destinations and packages.',
          ...(s.ogImage ? { image: absUrl(req, s.ogImage) } : {}),
        },
      },
    };
  },
  destinations: (req) => {
    const all = pub(c().destinations);
    const categories = (c().destCategories || []).map((cat) => ({
      ...cat,
      count: all.filter((d) => (d.categories || []).includes(cat.slug)).length,
    }));
    // Server-side category filter so /destinations?cat=beach (from the trip
    // funnel, mega menu, deep links) actually narrows the grid.
    const activeCat = (req && req.query && req.query.cat) || '';
    const catObj = categories.find((x) => x.slug === activeCat) || null;
    const filtered = catObj ? all.filter((d) => (d.categories || []).includes(activeCat)) : all;
    const { items, pagination } = paginate(filtered, req);
    const baseUrl = catObj ? '/destinations?cat=' + encodeURIComponent(activeCat) : '/destinations';
    // Each card's "Go For A Trip" opens the affiliate consent (Go For A Trip Tab doc)
    const cards = items.map((d) => ({ ...d, affiliate: bestAffiliate(d) }));
    return { page: c().pages.destinations, cards, categories, activeCat, activeCatLabel: catObj ? catObj.label : '', totalAll: all.length, pagination, baseUrl, sponsorSlots: sponsorSlots('destinations', items.length) };
  },
  categories: () => {
    // Circular category grid (8-up). The universal taxonomy (destCategories) —
    // each links into the destinations index filtered by that category slug.
    const cats = (c().destCategories || []).filter(isVisible);
    return {
      page: {
        titleHtml: 'Browse by <em>category</em>.',
        lead: 'Pick a kind of trip — mountains for solitude, beaches for slowness, heritage for the stories etched into stone. Every category opens its own curated index.',
      },
      categories: cats,
    };
  },
  packages: (req) => {
    // FR-PKG-002: only show packages that lead somewhere — a provider/affiliate
    // link, a details link, or a contact-form fallback (provider name/info).
    const hasLink = (p) => !!(p.ctaUrl || (p.ctaExternal && p.ctaUrl) || p.ctaHref || p.ctaProvider || p.providerInfo);
    const allPkgs = pub(c().packages).filter(hasLink);
    let all = allPkgs;
    const q = (req && req.query) || {};
    // destination funnel filter (?d=) — keep as-is
    let destFilter = null;
    if (q.d) {
      const tagged = all.filter((p) => (p.destinationSlugs || []).includes(q.d));
      if (tagged.length) { all = tagged; destFilter = (c().destinations.find((x) => x.slug === q.d) || {}).name || q.d; }
    }
    // category filter (?cat=) — pills drawn from the destination categories
    const categories = (c().destCategories || []).map((cat) => ({
      ...cat, count: allPkgs.filter((p) => (p.categories || []).includes(cat.slug)).length,
    })).filter((cat) => cat.count > 0);
    const activeCat = q.cat || '';
    const catObj = categories.find((x) => x.slug === activeCat) || null;
    if (catObj) all = all.filter((p) => (p.categories || []).includes(activeCat));
    const { items, pagination } = paginate(all, req);
    // preserve active filters across pagination
    const qs = [];
    if (q.d) qs.push('d=' + encodeURIComponent(q.d));
    if (catObj) qs.push('cat=' + encodeURIComponent(activeCat));
    const baseUrl = '/packages' + (qs.length ? '?' + qs.join('&') : '');
    return {
      page: c().pages.packages, packages: items, pagination, baseUrl,
      sponsorSlots: sponsorSlots('packages', items.length),
      destFilter, categories, activeCat, dParam: q.d || '',
    };
  },
  blog: (req) => {
    const { items, pagination } = paginate(pub(c().blog.posts), req);
    const dests = c().destinations || [];
    // Each blog card gets "Know More" (→ its destination) + "Go For A Trip"
    // (→ affiliate consent), per the "Blog Tab" doc.
    const posts = items.map((p) => {
      const dest = dests.find((d) => d.slug === p.destinationSlug) || null;
      return { ...p, dest: dest ? { slug: dest.slug, name: dest.name } : null, affiliate: bestAffiliate(dest) };
    });
    return { page: c().pages.blog, blog: { ...c().blog, posts }, pagination, baseUrl: '/blog', sponsorSlots: sponsorSlots('blog', items.length) };
  },
  announcements: (req) => {
    const { items, pagination } = paginate(resolveAnnouncements(pub(c().announcements)), req);
    return { page: c().pages.announcements, announcements: items, pagination, baseUrl: '/announcements' };
  },
  gallery: (req) => {
    const all = pub(c().galleryItems);
    const categories = (c().galleryCategories || []).map((cat) => ({
      ...cat,
      count: all.filter((g) => g.category === cat.slug).length,
    }));
    const { items, pagination } = paginate(all, req);
    return {
      page: c().pages.gallery, items, categories, pagination, baseUrl: '/gallery', sponsorSlots: sponsorSlots('gallery', items.length),
      typeCounts: {
        image: all.filter((g) => g.type === 'image').length,
        video: all.filter((g) => g.type === 'video').length,
      },
    };
  },
  picks: (req) => {
    const allPicks = pub(c().picks);
    const lists = (c().pickLists || []).map((l) => ({
      ...l, count: allPicks.filter((p) => p.list === l.key).length,
    }));
    // active list: ?list= if valid, else the first list
    const reqList = (req && req.query && req.query.list) || '';
    const active = lists.find((l) => l.key === reqList) || lists[0] || null;
    // picks in this list; if there are no lists defined yet, fall back to all picks
    const inList = active ? allPicks.filter((p) => p.list === active.key) : allPicks;
    const { items, pagination } = paginate(inList, req);
    const baseUrl = active ? '/picks?list=' + encodeURIComponent(active.key) : '/picks';
    // Each pick renders as a destination card with Know More + Go For A Trip
    // (Our Picks Tab doc): resolve its destination for season/tagline + affiliate.
    const dests = c().destinations || [];
    const picks = items.map((p) => {
      const dest = dests.find((d) => d.slug === p.destinationSlug) || null;
      return { ...p, dest: dest ? { slug: dest.slug, name: dest.name, season: dest.season, tagline: dest.tagline } : null, affiliate: bestAffiliate(dest) };
    });
    return { page: c().pages.picks, picks, lists, active, pagination, baseUrl };
  },
  about: () => ({ page: c().pages.about, about: c().about || {}, aboutStats: c().aboutStats || [], aboutOffers: c().aboutOffers || [] }),
  contact: () => ({ page: c().pages.contact, settings: c().settings }),
  legal: (req) => {
    const docs = c().legalDocs || [];
    const slug = (req && req.query && req.query.p) || 'privacy';
    const doc = docs.find((d) => d.slug === slug) || docs[0];
    return { legalDocs: docs, doc };
  },
  trip: () => {
    const dests = pub(c().destinations);
    // Real categories, each with a representative image (first destination in it)
    // so the Step-1 tiles link into the actual funnel: /destinations?cat=slug.
    const cats = (c().destCategories || [])
      .map((cat) => {
        const inCat = dests.filter((d) => (d.categories || []).includes(cat.slug));
        return { ...cat, count: inCat.length, image: (inCat[0] && (inCat[0].image || inCat[0].heroImage)) || '' };
      })
      .filter((cat) => cat.count > 0);
    return { trip: c().trip || {}, categories: cats };
  },
  '404': () => ({}),
  shop: (req) => {
    const { items, pagination } = paginate(pub(c().shopItems), req);
    return { shop: c().shop || {}, items, pagination, baseUrl: '/shop', settings: c().settings, sponsorSlots: sponsorSlots('shop', items.length) };
  },
  'destination-detail': (req) => {
    const all = c().destinations || [];
    const slug = (req && req.query && req.query.d) || '';
    const dest = all.find((d) => d.slug === slug) || all[0] || {};
    const brand = (c().settings || {}).brandName || 'Triplipi';
    const img = absUrl(req, dest.heroImage || dest.image || '');
    const desc = clip(dest.lead || dest.tagline || dest.overview, 300);
    const seo = {
      brand,
      title: (dest.name || 'Destination') + ' — ' + brand,
      description: desc,
      canonical: absUrl(req, '/destination-detail?d=' + (dest.slug || '')),
      image: img,
      type: 'article',
      robots: 'index, follow',
      jsonLd: {
        '@context': 'https://schema.org', '@type': 'TouristDestination',
        name: dest.name || '', description: desc,
        image: img || undefined, url: absUrl(req, '/destination-detail?d=' + (dest.slug || '')),
        ...(dest.region ? { touristType: dest.region } : {}),
      },
    };
    // Affiliate target for the "Go For A Trip" button — opens the consent modal,
    // then redirects to a partner site (see bestAffiliate).
    const affiliate = bestAffiliate(dest);
    return { dest, related: all.filter((d) => d.slug !== dest.slug).slice(0, 4), affiliate, seo };
  },
  'package-detail': (req) => {
    const all = c().packages || [];
    const key = (req && req.query && req.query.p) || '';
    const pkg = all.find((x) => slugify(x.title) === key) || all[parseInt(key, 10)] || all[0] || {};
    const brand = (c().settings || {}).brandName || 'Triplipi';
    const img = absUrl(req, pkg.image || '');
    const desc = clip(pkg.description || pkg.overview, 300);
    const seo = {
      brand,
      title: (plain(pkg.title) || 'Package') + ' — ' + brand,
      description: desc,
      canonical: absUrl(req, '/package-detail?p=' + slugify(pkg.title || '')),
      image: img,
      type: 'product',
      robots: 'index, follow',
      jsonLd: {
        '@context': 'https://schema.org', '@type': 'Product',
        name: plain(pkg.title) || '', description: desc, image: img || undefined,
        url: absUrl(req, '/package-detail?p=' + slugify(pkg.title || '')),
        ...(pkg.price ? { offers: { '@type': 'Offer', price: String(pkg.price).replace(/[^0-9.]/g, ''), priceCurrency: pkg.priceCurrency || 'INR', availability: 'https://schema.org/InStock' } } : {}),
      },
    };
    return { pkg, seo };
  },
  'package-quote': (req) => {
    // "Seek your quote" contact form for a package with no provider website —
    // routed to the package provider's email (Check Packages Tab doc, pp.7-9).
    const all = c().packages || [];
    const key = (req && req.query && req.query.p) || '';
    const pkg = all.find((x) => slugify(x.title) === key) || all[parseInt(key, 10)] || {};
    const brand = (c().settings || {}).brandName || 'Triplipi';
    const provider = pkg.ctaProvider || pkg.title || 'our partner';
    const toEmail = pkg.providerEmail || (c().settings || {}).contactEmail || '';
    return {
      pkg, provider, toEmail,
      seo: { ...defaultSeo(req), title: 'Request a quote — ' + brand, robots: 'noindex, nofollow' },
    };
  },
  'blog-post': (req) => {
    const all = (c().blog && c().blog.posts) || [];
    const key = (req && req.query && req.query.b) || '';
    let idx = all.findIndex((x) => slugify(x.title) === key);
    if (idx < 0) idx = Number.isNaN(parseInt(key, 10)) ? 0 : parseInt(key, 10);
    const post = all[idx] || all[0] || {};
    const related = all.map((p, j) => ({ p, j, key: slugify(p.title) })).filter((x) => x.j !== idx).slice(0, 3);
    const brand = (c().settings || {}).brandName || 'Triplipi';
    const img = absUrl(req, post.heroImage || post.image || '');
    const desc = clip(post.deck || post.excerpt || post.body, 300);
    const seo = {
      brand,
      title: (plain(post.title) || 'Story') + ' — ' + brand,
      description: desc,
      canonical: absUrl(req, '/blog-post?b=' + slugify(post.title || '')),
      image: img,
      type: 'article',
      robots: 'index, follow',
      jsonLd: {
        '@context': 'https://schema.org', '@type': 'BlogPosting',
        headline: plain(post.title) || '', description: desc, image: img || undefined,
        url: absUrl(req, '/blog-post?b=' + slugify(post.title || '')),
        ...(post.date ? { datePublished: post.date } : {}),
        ...(post.author ? { author: { '@type': 'Person', name: post.author } } : {}),
        publisher: { '@type': 'Organization', name: brand },
      },
    };
    return { post, related, seo };
  },
  search: (req) => {
    const q = (req && req.query && req.query.q) || '';
    const results = runSearch(q);
    return { q, results, count: results.length, seo: { ...defaultSeo(req), robots: 'noindex, follow' } };
  },
};

/* ----- robots.txt + sitemap.xml (FR SEO) ----- */
app.get('/robots.txt', (req, res) => {
  const origin = siteOrigin(req);
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Disallow: /admin\n' +
    'Disallow: /search\n' +
    'Sitemap: ' + origin + '/sitemap.xml\n'
  );
});
app.get('/sitemap.xml', (req, res) => {
  const origin = siteOrigin(req);
  const urls = [];
  const add = (loc, priority) => urls.push({ loc: origin + loc, priority });
  // Static / listing pages
  ['/', '/destinations', '/packages', '/blog', '/announcements', '/gallery', '/picks', '/about', '/contact', '/shop']
    .forEach((p) => add(p, p === '/' ? '1.0' : '0.8'));
  // Legal docs
  (c().legalDocs || []).forEach((d) => d.slug && add('/legal?p=' + encodeURIComponent(d.slug), '0.3'));
  // Detail pages (only visible items)
  pub(c().destinations).forEach((d) => d.slug && add('/destination-detail?d=' + encodeURIComponent(d.slug), '0.7'));
  pub(c().packages).forEach((p) => p.title && add('/package-detail?p=' + encodeURIComponent(slugify(p.title)), '0.7'));
  pub((c().blog && c().blog.posts) || []).forEach((p) => p.title && add('/blog-post?b=' + encodeURIComponent(slugify(p.title)), '0.6'));
  // Custom pages
  pub(c().customPages).forEach((p) => p.slug && add('/p/' + encodeURIComponent(p.slug), '0.5'));
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => '  <url><loc>' + u.loc.replace(/&/g, '&amp;') + '</loc><priority>' + u.priority + '</priority></url>').join('\n') +
    '\n</urlset>\n';
  res.type('application/xml').send(xml);
});

app.get('/', (req, res) => res.render('index.njk', PAGES.index(req)));
// The 7-step /trip planner is not part of the Go For A Trip flow (per client docs):
// "Go For A Trip" is the category dropdown -> destination cards -> consent. Retire it.
app.get('/trip', (req, res) => res.redirect(302, '/destinations'));
for (const [name, data] of Object.entries(PAGES)) {
  if (name === 'trip') continue;
  app.get('/' + name, (req, res) => res.render(name + '.njk', data(req)));
}

/* Dynamic custom pages (FR-PAGES-010 / FR-OTHER-004) — /p/:slug */
app.get('/p/:slug', (req, res) => {
  const page = pub(c().customPages).find((p) => p.slug === req.params.slug);
  if (!page) return res.status(404).render('404.njk', {});
  const brand = (c().settings || {}).brandName || 'Triplipi';
  const seo = {
    ...defaultSeo(req),
    title: (page.crumb || plain(page.title) || page.navLabel || 'Page') + ' — ' + brand,
    description: clip(page.deck || page.body, 300),
    canonical: absUrl(req, '/p/' + page.slug),
    image: absUrl(req, page.heroImage || ''),
  };
  res.render('custompage.njk', { page, seo });
});

/* ============================================================
   FORM SUBMISSIONS — store every submission + email (if SMTP set)
   Used by: Contact, Ask for Guidance, Shop quote, provider fallback
   ============================================================ */
const SUBM_FILE = path.join(__dirname, 'data', 'submissions.json');
function readSubmissions() {
  try { return JSON.parse(fs.readFileSync(SUBM_FILE, 'utf8')); } catch (e) { return []; }
}
function writeSubmissions(list) {
  fs.writeFileSync(SUBM_FILE, JSON.stringify(list, null, 2));
}
let mailer = null;
if (process.env.SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}
app.post('/submit', upload.none(), (req, res) => {
  const body = req.body || {};
  const formName = body._form || 'Form';
  const fields = {};
  Object.keys(body).forEach((k) => { if (k[0] !== '_') fields[k] = body[k]; });

  const entry = { id: Date.now().toString(36), form: formName, fields, at: new Date().toISOString(), read: false };
  const list = readSubmissions();
  list.unshift(entry);
  writeSubmissions(list);

  /* email the owner if SMTP is configured (otherwise it's saved to the admin Inbox) */
  const to = body._to || store.get('settings').contactEmail;
  if (mailer && to) {
    const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
    mailer.sendMail({
      from: process.env.SMTP_FROM || `Triplipi <no-reply@${(to.split('@')[1] || 'triplipi.local')}>`,
      to,
      subject: `[${formName}] new submission`,
      text: lines,
    }).catch((err) => console.error('mail error:', err.message));
  }

  if ((req.headers.accept || '').includes('application/json')) return res.json({ ok: true });
  res.send('<!doctype html><meta charset="utf-8"><title>Thank you</title><body style="font-family:Georgia,serif;display:grid;place-items:center;min-height:100vh;background:#F2ECE1;color:#231F20;text-align:center"><div><h1>Thank you.</h1><p>Your message has been received.</p><a href="/" style="color:#D05527">Back to the site</a></div>');
});

/* ============================================================
   ADMIN ROUTES — organised by page
   ============================================================ */
const adminCtx = (active) => ({ pages: ADMIN_PAGES, active, defaultPass: adminCreds().passHash === DEFAULT_PASS_HASH });

/* attach live dropdown options to multiselect fields (sourced from the store) */
function resolveSchema(schema) {
  if (!schema.fields) return schema;   // pickers have no field forms
  return {
    ...schema,
    fields: schema.fields.map((f) => {
      if ((f.type !== 'multiselect' && f.type !== 'select') || !f.optionsFrom) return f;
      const src = store.get(f.optionsFrom) || [];
      return { ...f, options: src.map((o) => ({ value: o[f.optionValue], label: o[f.optionLabel] })) };
    }),
  };
}

app.get('/admin/login', (req, res) => res.render('admin/login.njk', { error: null }));
app.post('/admin/login', (req, res) => {
  const { user, pass } = req.body || {};
  const creds = adminCreds();
  if (user === creds.user && sha256(pass || '') === creds.passHash) {
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.add(sid);
    res.setHeader('Set-Cookie', `tl_admin=${sid}; HttpOnly; Path=/; SameSite=Lax`);
    return res.redirect('/admin');
  }
  res.render('admin/login.njk', { error: 'Wrong username or password.' });
});
app.post('/admin/logout', requireAuth, (req, res) => {
  sessions.delete(getCookie(req, 'tl_admin'));
  res.setHeader('Set-Cookie', 'tl_admin=; Path=/; Max-Age=0');
  res.redirect('/admin/login');
});

/* Dashboard — one card per page of the site + analytics */
app.get('/admin', requireAuth, (req, res) =>
  res.render('admin/dashboard.njk', {
    ...adminCtx(null), saved: req.query.saved,
    stats: analyticsSummary(),
    content: contentStats(),
    inboxCount: readSubmissions().filter((s) => !s.read).length,
  }));

/* Messages inbox — form submissions */
app.get('/admin/inbox', requireAuth, (req, res) => {
  const list = readSubmissions();
  res.render('admin/inbox.njk', { ...adminCtx('inbox'), submissions: list, smtp: !!mailer });
});
app.post('/admin/inbox/:id/delete', requireAuth, (req, res) => {
  writeSubmissions(readSubmissions().filter((s) => s.id !== req.params.id));
  res.redirect('/admin/inbox');
});
app.post('/admin/inbox/read', requireAuth, (req, res) => {
  const list = readSubmissions().map((s) => ({ ...s, read: true }));
  writeSubmissions(list);
  res.redirect('/admin/inbox');
});

/* Link health check — scans all external URLs, flags broken ones */
app.get('/admin/links', requireAuth, async (req, res) => {
  const checked = req.query.run ? await checkLinks() : null;
  res.render('admin/links.njk', { ...adminCtx('links'), checked });
});

/* Page hub — all sections of one page, in on-screen order, editable inline */
app.get('/admin/page/:pkey', requireAuth, (req, res) => {
  const page = adminPageByKey[req.params.pkey];
  if (!page) return res.status(404).send('Unknown page');
  const sections = page.sections.map((s) => ({
    schema: resolveSchema(schemaByKey[s.key]),
    hint: s.hint,
    value: store.get(schemaByKey[s.key].path),
  }));
  res.render('admin/page.njk', { ...adminCtx(page.key), page, sections, saved: req.query.saved });
});

/* legacy section URLs → jump to the right page hub */
app.get('/admin/section/:key', requireAuth, (req, res) => res.redirect(backTo(req.params.key)));

/* object save (also handles pickers: checkbox per item -> featured flag) */
app.post('/admin/section/:key', requireAuth, upload.any(), (req, res) => {
  const schema = schemaByKey[req.params.key];
  if (schema && schema.type === 'picker') {
    const body = req.body || {};
    const items = store.get(schema.path) || [];
    items.forEach((item, i) => { item.featured = body['pick_' + i] === 'on'; });
    store.set(schema.path, items);
    return res.redirect(backTo(schema.key, true));
  }
  if (!schema || schema.type !== 'object') return res.status(400).send('Bad request');
  const obj = store.get(schema.path) || {};
  for (const f of schema.fields) obj[f.name] = castField(f, req.body[f.name]);
  applyUploads(schema, req, obj);
  store.set(schema.path, obj);
  res.redirect(backTo(schema.key, true));
});

/* list item editors */
app.get('/admin/section/:key/new', requireAuth, (req, res) => {
  const schema = schemaByKey[req.params.key];
  res.render('admin/item.njk', {
    ...adminCtx(pageOfSection[schema.key]), schema: resolveSchema(schema), item: {}, index: null, backUrl: backTo(schema.key),
  });
});
app.get('/admin/section/:key/:idx/edit', requireAuth, (req, res) => {
  const schema = schemaByKey[req.params.key];
  const items = store.get(schema.path) || [];
  const idx = parseInt(req.params.idx, 10);
  res.render('admin/item.njk', {
    ...adminCtx(pageOfSection[schema.key]), schema: resolveSchema(schema), item: items[idx] || {}, index: idx, backUrl: backTo(schema.key),
  });
});
app.post('/admin/section/:key/save', requireAuth, upload.any(), (req, res) => {
  const schema = schemaByKey[req.params.key];
  const items = store.get(schema.path) || [];
  const item = {};
  for (const f of schema.fields) item[f.name] = castField(f, req.body[f.name]);
  applyUploads(schema, req, item);
  // universal status fields (publish / archive / auto-expire)
  item.published = req.body._published === 'on';
  item.archived = req.body._archived === 'on';
  item.expiry = (req.body._expiry || '').trim();
  const idx = req.body._index === '' ? null : parseInt(req.body._index, 10);
  if (idx === null || Number.isNaN(idx)) items.push(item);
  else items[idx] = { ...items[idx], ...item };
  store.set(schema.path, items);
  res.redirect(backTo(schema.key, true));
});
/* Drag-to-reorder: body.order is the new sequence of the items' current
   indices (a permutation of 0..n-1). Rebuilds the array in that order. */
app.post('/admin/section/:key/reorder', requireAuth, (req, res) => {
  const schema = schemaByKey[req.params.key];
  if (!schema) return res.status(404).json({ ok: false });
  const items = store.get(schema.path) || [];
  const order = String(req.body.order || '')
    .split(',').map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n));
  const valid = order.length === items.length
    && new Set(order).size === items.length
    && order.every((i) => i >= 0 && i < items.length);
  if (!valid) return res.status(400).json({ ok: false, error: 'bad order' });
  store.set(schema.path, order.map((i) => items[i]));
  res.json({ ok: true });
});
app.post('/admin/section/:key/:idx/delete', requireAuth, (req, res) => {
  const schema = schemaByKey[req.params.key];
  const items = store.get(schema.path) || [];
  items.splice(parseInt(req.params.idx, 10), 1);
  store.set(schema.path, items);
  res.redirect(backTo(schema.key, true));
});
app.post('/admin/section/:key/:idx/move', requireAuth, (req, res) => {
  const schema = schemaByKey[req.params.key];
  const items = store.get(schema.path) || [];
  const i = parseInt(req.params.idx, 10);
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < items.length) [items[i], items[j]] = [items[j], items[i]];
  store.set(schema.path, items);
  res.redirect(backTo(schema.key));
});

/* password change */
app.post('/admin/password', requireAuth, (req, res) => {
  const { current, next } = req.body;
  const creds = adminCreds();
  if (sha256(current || '') !== creds.passHash || !next || next.length < 8) {
    return res.redirect('/admin/page/site?saved=0');
  }
  fs.writeFileSync(ADMIN_FILE, JSON.stringify({ ...creds, passHash: sha256(next) }, null, 2));
  res.redirect('/admin/page/site?saved=1');
});

function castField(f, raw) {
  if (f.type === 'multiselect') return [].concat(raw || []).map(String).filter(Boolean);
  if (f.type === 'csv') return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (f.type === 'bool') return raw === 'on' || raw === 'true';
  return String(raw == null ? '' : raw);
}

/* 404 fallthrough */
app.use((req, res) => res.status(404).render('404.njk', {}));

/* global error handler — log it, never leak stack traces */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}]`, req.method, req.url, '-', err.message);
  if (res.headersSent) return;
  res.status(500).send(
    '<!doctype html><meta charset="utf-8"><title>Something went wrong</title>' +
    '<body style="font-family:Georgia,serif;display:grid;place-items:center;min-height:100vh;background:#F2ECE1;color:#231F20;">' +
    '<div style="text-align:center"><h1 style="font-size:2rem;">Something went wrong.</h1>' +
    '<p>The error has been logged. <a href="/" style="color:#D05527;">Back to the site</a></p></div>');
});

app.listen(PORT, () => {
  console.log(`Triplipi running       → http://localhost:${PORT}${PROD ? '  (production)' : ''}`);
  console.log(`Admin panel            → http://localhost:${PORT}/admin`);
  if (firstRun) console.log('First run — admin login: admin / triplipi2026 (change it after signing in)');
});
