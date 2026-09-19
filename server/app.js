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
/* FR-OTHER-011 — image optimisation. The photography is served from Unsplash's
   CDN, which resizes on the fly, so every card can ask for the width it
   actually paints instead of a full-size file. Anything else is left alone. */
/* host name of a URL — the consent card names the provider with it */
env.addFilter('host', (url) => { try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch (e) { return 'External website'; } });
env.addFilter('srcset', (url) => {
  const u = String(url || '');
  if (!/^https?:\/\/images\.unsplash\.com\//.test(u)) return '';
  const base = u.split('?')[0];
  return [400, 800, 1200, 1600]
    .map((w) => `${base}?q=75&auto=format&fit=crop&w=${w} ${w}w`)
    .join(', ');
});
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
/* the ad switch and publisher ID reach every page template */
app.use((req, res, next) => { res.locals.ads = adsConfig(); next(); });
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/admin') && !req.path.startsWith('/assets')
      && !req.path.includes('.') && (req.headers.accept || '').includes('text/html')) {
    _analytics.total += 1;
    // detail pages live behind one path (/blog-post?b=…), so keep the item key
    // or every post would be counted as a single "page"
    const item = req.query && (req.query.d || req.query.b || req.query.p);
    const key = item ? req.path + '?' + String(item).slice(0, 80) : req.path;
    _analytics.pages[key] = (_analytics.pages[key] || 0) + 1;
    const day = new Date().toISOString().slice(0, 10);
    _analytics.days[day] = (_analytics.days[day] || 0) + 1;
    _analyticsDirty = true;
  }
  next();
});
/* Turn a counted URL into something an owner recognises. */
const PAGE_LABELS = {
  '/': 'Home', '/destinations': 'Destinations', '/categories': 'Categories',
  '/packages': 'Check Packages', '/picks': 'Our Picks', '/blog': 'Blog',
  '/travel-tips': 'Travel Tips', '/gallery': 'Gallery', '/announcements': 'Announcements',
  '/about': 'About', '/contact': 'Contact', '/shop': 'Shop', '/legal': 'Legal', '/search': 'Search',
};
function prettyPage(url) {
  const [path, key] = url.split('?');
  const d = store.content;
  const find = (arr, match, title) => { const hit = (arr || []).find(match); return hit ? plain(hit[title]) || hit[title] : null; };
  if (key) {
    if (path === '/destination-detail') return { label: find(d.destinations, (x) => x.slug === key, 'name') || key, kind: 'Destination' };
    if (path === '/blog-post') return { label: find((d.blog || {}).posts, (x) => slugify(plain(x.title)) === key, 'title') || key, kind: 'Blog post' };
    if (path === '/package-detail') return { label: find(d.packages, (x) => slugify(plain(x.title)) === key, 'title') || key, kind: 'Package' };
    if (path === '/legal') return { label: find(d.legalDocs, (x) => x.slug === key, 'crumb') || key, kind: 'Legal page' };
  }
  return { label: PAGE_LABELS[path] || path, kind: 'Page' };
}
function analyticsSummary() {
  const a = _analytics;
  const top = Object.entries(a.pages).sort((x, y) => y[1] - x[1]).slice(0, 10)
    .map(([url, views]) => ({ url, views, ...prettyPage(url) }));
  const today = new Date().toISOString().slice(0, 10);
  // Always the same 14-day window ending today, empty days included, so the
  // chart keeps its shape on a new site instead of one bar filling the card.
  const days = [];
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 864e5);
    const day = d.toISOString().slice(0, 10);
    days.push({
      day, views: a.days[day] || 0, isToday: i === 0,
      dom: d.getUTCDate(),
      label: d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
    });
  }
  const peak = days.reduce((m, x) => Math.max(m, x.views), 0) || 1;
  const week = days.slice(-7).reduce((n, x) => n + x.views, 0);
  const first = Object.keys(a.days).sort()[0];
  const since = first ? new Date(first + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null;
  return { total: a.total, top, today: a.days[today] || 0, week, days, peak, since };
}

/* ---------- external link health checker (D7 / FR-OTHER) ---------- */
let _linkReport = { at: null, running: false, results: [] };
/* Every external URL the site can send a visitor to, with the item it belongs
   to so a broken one can be found and fixed in the CMS. */
function externalLinks() {
  const d = store.content;
  const urls = new Map();   // url -> "Where it lives"
  const add = (url, where) => { const u = String(url || '').trim(); if (/^https?:\/\//i.test(u) && !urls.has(u)) urls.set(u, where); };
  (d.sponsored || []).forEach((s) => add(s.linkUrl, 'Sponsored · ' + (s.title || 'untitled')));
  (d.packages || []).forEach((p) => { if (p.ctaExternal) add(p.ctaUrl, 'Package · ' + (plain(p.title) || 'untitled')); });
  (d.announcements || []).forEach((a) => { if (a.external || a.section === 'external') add(a.extUrl || a.target, 'Announcement · ' + (plain(a.title) || 'untitled')); });
  (d.travelTips || []).forEach((t) => {
    add(t.link1Url, 'Travel tip · ' + (t.title || 'untitled'));
    add(t.link2Url, 'Travel tip · ' + (t.title || 'untitled'));
  });
  (d.banners || []).forEach((b) => add(b.extUrl || b.href, 'Banner · ' + (plain(b.text) || 'untitled')));
  add((d.shop || {}).shutterstockUrl, 'Shop · Shutterstock portfolio');
  const st = d.settings || {};
  [['socialInstagram', 'Instagram'], ['socialYoutube', 'YouTube'], ['socialFacebook', 'Facebook'],
   ['socialPinterest', 'Pinterest'], ['socialX', 'X / Twitter']]
    .forEach(([k, label]) => add(st[k], 'Footer · ' + label));
  /* Anything typed into a rich-text body counts as well — FR-LINK-003 wants no
     unchecked external link anywhere on the site. */
  const scanHtml = (html, where) => {
    String(html || '').replace(/href=["'](https?:\/\/[^"']+)["']/gi, (_, u) => { add(u, where); return ''; });
  };
  (d.destinations || []).forEach((x) => ['overview', 'secNotes', 'extItinerary', 'extCulture']
    .forEach((f) => scanHtml(x[f], 'Destination · ' + (x.name || 'untitled'))));
  ((d.blog || {}).posts || []).forEach((x) => scanHtml(x.body, 'Blog post · ' + (plain(x.title) || 'untitled')));
  (d.travelTips || []).forEach((x) => scanHtml(x.body, 'Travel tip · ' + (x.title || 'untitled')));
  (d.legalDocs || []).forEach((x) => scanHtml(x.body, 'Legal · ' + (x.crumb || x.slug)));
  (d.customPages || []).forEach((x) => scanHtml(x.body, 'Page · ' + (x.navLabel || x.slug)));
  return urls;
}
async function checkLinks() {
  const urls = externalLinks();
  const list = [...urls.keys()];
  const results = await Promise.all(list.map(async (url) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 7000);
      let r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
      if (r.status >= 400) r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
      clearTimeout(t);
      return { url, where: urls.get(url), status: r.status, ok: r.status < 400 };
    } catch (e) { return { url, where: urls.get(url), status: 0, ok: false, error: e.name }; }
  }));
  results.sort((a, b) => Number(a.ok) - Number(b.ok));   // broken first
  _linkReport = { at: new Date().toISOString(), running: false, results };
  return results;
}
/* D7 — links are checked on their own, not only when someone presses the
   button, so the dashboard can flag a dead partner URL the day it dies. */
const LINK_SCAN_EVERY = 6 * 60 * 60 * 1000;
const scanLinks = () => { if (!_linkReport.running) { _linkReport.running = true; checkLinks().catch(() => { _linkReport.running = false; }); } };
setInterval(scanLinks, LINK_SCAN_EVERY);
setTimeout(scanLinks, 20000);
const brokenLinks = () => _linkReport.results.filter((r) => !r.ok);

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
  // images, video and documents (FR-OTHER-006: "upload content, pages,
  // documents, videos, and images")
  fileFilter: (req, file, cb) =>
    cb(null, /^(image|video|audio)\//.test(file.mimetype)
      || /^application\/(pdf|msword|vnd\.|rtf)/.test(file.mimetype)
      || /^text\/(plain|csv)/.test(file.mimetype)),
});
/* FR-OTHER-011 — shrink and compress raster uploads in place: at most 1600px
   wide, quality 80. `sharp` is an optional dependency; if it isn't installed
   the original file is kept as uploaded. */
let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* optional */ }
async function optimiseUpload(file) {
  if (!sharp || !/^image\/(jpeg|png|webp)$/.test(file.mimetype)) return;
  const src = file.path; const tmp = src + '.opt';
  try {
    const img = sharp(src).rotate().resize({ width: 1600, withoutEnlargement: true });
    if (file.mimetype === 'image/png') await img.png({ compressionLevel: 9, palette: true }).toFile(tmp);
    else if (file.mimetype === 'image/webp') await img.webp({ quality: 80 }).toFile(tmp);
    else await img.jpeg({ quality: 80, mozjpeg: true }).toFile(tmp);
    if (fs.statSync(tmp).size < fs.statSync(src).size) fs.renameSync(tmp, src); else fs.unlinkSync(tmp);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to clean */ } }
}
/* For each 'image' field, an uploaded file (named <field>__file) wins over the URL input */
function applyUploads(schema, req, values) {
  (req.files || []).forEach((f) => { optimiseUpload(f); });   // async; the URL is valid either way
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
      { name: 'contactEmail', label: 'Contact email (shown on the site, and where forms go by default)', ph: 'e.g. hello@triplipi.com' },
      { name: 'formEmailContact', label: 'Send Contact form to (optional)', ph: 'Leave blank to use the contact email' },
      { name: 'formEmailPartner', label: 'Send partner applications to (optional)', ph: 'Leave blank to use the contact email' },
      { name: 'formEmailGuidance', label: 'Send “Ask for guidance” to (optional)', ph: 'Leave blank to use the contact email' },
      { name: 'copyright', label: 'Copyright line', ph: 'e.g. © 2026 Triplipi. All rights reserved.' },
      { name: 'siteUrl', label: 'Public website address (for SEO)', type: 'url', ph: 'e.g. https://triplipi.com' },
      { name: 'metaDescription', label: 'Default search-engine description', type: 'textarea', ph: 'One or two sentences describing the site, used when a page has none.' },
      { name: 'ogImage', label: 'Default social-share image', type: 'image', ph: 'A wide image shown when the site is shared on social media.' },
      // FR-HOME-022 — the footer's social row. Blank ones are simply not shown.
      // FR-OTHER-008 — copy and download protection (see assumption A7: a
      // deterrent, not a guarantee). Off switches are here so the owner can
      // relax it if it gets in the way.
      { name: 'protectContent', label: 'Protect content (blocks right-click, copy/save shortcuts and image dragging)', type: 'bool' },
      { name: 'protectSelection', label: 'Also block selecting text on the site', type: 'bool' },
      { name: 'watermarkText', label: 'Watermark over photos (optional)', ph: 'e.g. © Triplipi' },
      { name: 'socialInstagram', label: 'Instagram page', type: 'url', ph: 'https://instagram.com/yourhandle' },
      { name: 'socialYoutube', label: 'YouTube channel', type: 'url', ph: 'https://youtube.com/@yourchannel' },
      { name: 'socialFacebook', label: 'Facebook page', type: 'url', ph: 'https://facebook.com/yourpage' },
      { name: 'socialPinterest', label: 'Pinterest profile', type: 'url', ph: 'https://pinterest.com/yourhandle' },
      { name: 'socialX', label: 'X / Twitter profile', type: 'url', ph: 'https://x.com/yourhandle' },
    ] },
  { key: 'nav', group: 'Navbar', label: 'Header navigation links', type: 'list', path: 'settings.navLinks',
    itemTitle: 'label',
    fields: [
      { name: 'label', label: 'Label', ph: 'e.g. Travel Tips' },
      { name: 'href', label: 'Link', type: 'url', ph: 'e.g. /travel-tips or https://…' },
      { name: 'mega', label: 'Dropdown menu', type: 'select', options: [
        { value: 'none', label: 'No dropdown — plain link' },
        { value: 'destinations', label: 'Opens the Destination categories dropdown' },
        { value: 'picks', label: 'Opens the Our Picks dropdown' },
        { value: 'resources', label: 'Opens the Resources dropdown' },
      ] },
    ] },
  { key: 'megaMenus', group: 'Navbar', label: 'Dropdown menu links (“View all …”)', type: 'object', path: 'settings.megaMenus',
    fields: [
      { name: 'destAllLabel', label: 'Destination dropdown — last link label', ph: 'All Destination Categories' },
      { name: 'destAllHref', label: 'Destination dropdown — last link', type: 'url', ph: '/categories' },
      { name: 'picksHeadLabel', label: 'Our Picks dropdown — “View all” label', ph: 'View all' },
      { name: 'picksHeadHref', label: 'Our Picks dropdown — “View all” link', type: 'url', ph: '/picks' },
    ] },

  /* ----- Homepage ----- */
  { key: 'hero', group: 'Homepage', label: 'Hero banner', type: 'object', path: 'home.hero',
    fields: [
      { name: 'titleHtml', label: 'Headline (HTML, <em> = accent)', type: 'textarea', richInline: true, ph: 'e.g. The world, <em>slowly</em>.' },
      { name: 'lead', label: 'Lead paragraph', type: 'textarea', richInline: true, ph: 'One or two sentences shown under the headline.' },
      { name: 'bgImage', label: 'Background image', type: 'image' },
    ] },
  { key: 'featuredHead', group: 'Homepage', label: 'Section heading — Featured Destinations', type: 'object', path: 'home.featuredHead',
    fields: [
      { name: 'overline', label: 'Overline' , ph: 'Small label above the heading, e.g. Travel Highlights' },
      { name: 'titleHtml', label: 'Heading (HTML)', type: 'textarea', richInline: true, ph: 'e.g. Stories from the <em>field</em>.' },
      { name: 'blurb', label: 'Side blurb', type: 'textarea', richInline: true, ph: 'Short text shown beside the heading.' },
    ] },
  { key: 'destinations', group: 'Homepage', label: 'Destinations', type: 'list', path: 'destinations',
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
      { name: 'metaTitle', label: 'Search-engine title (optional)', ph: 'Leave blank to use the name above' },
      { name: 'metaDescription', label: 'Search-engine description (optional)', type: 'textarea', ph: 'One or two sentences shown in Google results.' },
      { name: 'extBudget', label: 'Read more — Costs & budget', type: 'textarea', rich: true },
      { name: 'extFaq', label: 'Read more — Traveller FAQ', type: 'textarea', rich: true },
      { name: 'gallery', label: 'Detail gallery image URLs (comma-separated)', type: 'csv', ph: 'https://… , https://…' },
    ] },
  { key: 'highlightsHead', group: 'Homepage', label: 'Section heading — Travel Highlights', type: 'object', path: 'home.highlightsHead',
    fields: [
      { name: 'overline', label: 'Overline' , ph: 'Small label above the heading, e.g. Travel Highlights' },
      { name: 'titleHtml', label: 'Heading (HTML)', type: 'textarea', richInline: true, ph: 'e.g. Stories from the <em>field</em>.' },
    ] },
  { key: 'highlights', group: 'Homepage', label: 'Travel highlight cards', type: 'list', path: 'highlights',
    itemTitle: 'title',
    fields: [
      { name: 'title', label: 'Title', ph: 'e.g. Stargazing in Spiti' },
      { name: 'place', label: 'Place', ph: 'e.g. Himachal' },
      { name: 'kicker', label: 'Kicker (small label)', ph: 'e.g. Experience' },
      { name: 'image', label: 'Image', type: 'image' },
      // FR-HOME-009 + Flow 7.5: a highlight lands either on a destination page
      // or on a page of its own — the admin picks which.
      { name: 'destinationSlug', label: 'Opens this destination (optional)', type: 'select', optionsFrom: 'destinations', optionValue: 'slug', optionLabel: 'name' },
      { name: 'href', label: 'Or open this page instead (optional)', type: 'url', ph: 'e.g. /p/press or https://…' },
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
        { value: 'trip', label: 'Find Trip Deals (all categories)' },
        { value: 'picks', label: 'Our Picks' },
        { value: 'packages', label: 'Check Packages' },
        { value: 'shop', label: 'Shop' },
        { value: 'travel-tips', label: 'Travel Tips' },
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
      { name: 'metaTitle', label: 'Search-engine title (optional)', ph: 'Leave blank to use the name above' },
      { name: 'metaDescription', label: 'Search-engine description (optional)', type: 'textarea', ph: 'One or two sentences shown in Google results.' },
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
          { name: 'postTitle', label: 'Which post does it open?', type: 'select', optionsFrom: 'blog.posts', optionValue: 'title', optionLabel: 'title' },
] },
  { key: 'blogSide', group: 'Content', label: 'Side stories', type: 'list', path: 'blog.side',
    itemTitle: 'title',
    fields: [
      { name: 'title', label: 'Title', ph: 'e.g. Stargazing in Spiti' },
      { name: 'category', label: 'Category line', ph: 'e.g. Essay · Ladakh' },
      { name: 'meta', label: 'Meta', ph: 'e.g. 9 min read · 6 days ago' },
      { name: 'image', label: 'Thumbnail', type: 'image' },
          { name: 'postTitle', label: 'Which post does it open?', type: 'select', optionsFrom: 'blog.posts', optionValue: 'title', optionLabel: 'title' },
] },
  { key: 'blogPosts', group: 'Content', label: 'Post grid', type: 'list', path: 'blog.posts',
    itemTitle: 'title',
    fields: [
      { name: 'title', label: 'Title', ph: 'e.g. Stargazing in Spiti' },
      { name: 'category', label: 'Category line', ph: 'e.g. Essay · Ladakh' },
      { name: 'excerpt', label: 'Excerpt', type: 'textarea', richInline: true, ph: 'One or two sentences shown under the title.' },
      { name: 'bylineSpans', label: 'Byline parts (comma-separated)', type: 'csv', ph: 'e.g. 14 min read, By Editor' },
      { name: 'image', label: 'Thumbnail', type: 'image' },
      { name: 'destinationSlug', label: 'Related destination (for the card’s Know More / Check Packages)', type: 'select', optionsFrom: 'destinations', optionValue: 'slug', optionLabel: 'name' },
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
      { name: 'story', label: 'Travel story & experience', type: 'textarea', rich: true, hint: 'The personal part — what the trip was actually like. Shown as its own section under the article, in every layout.' },
      { name: 'metaTitle', label: 'Search-engine title (optional)', ph: 'Leave blank to use the name above' },
      { name: 'metaDescription', label: 'Search-engine description (optional)', type: 'textarea', ph: 'One or two sentences shown in Google results.' },
      { name: 'gallery', label: 'Photos & films in this post (comma-separated URLs — .mp4/.webm play as video)', type: 'csv', ph: 'https://… , https://….mp4' },
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
      { name: 'destinationSlug', label: 'Related destination (for the card’s Know More / Check Packages)', type: 'select', optionsFrom: 'destinations', optionValue: 'slug', optionLabel: 'name' },
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
      { name: 'providerEmail', label: 'Provider email (used when there is no website — a consent-gated enquiry form is shown instead)', ph: 'e.g. sales@partner.com' },
      { name: 'pages', label: 'Show on pages', type: 'multiselect', options: [
        { value: 'home', label: 'Home (FR-HOME-015: up to 20)' },
        { value: 'destinations', label: 'Destinations listing' },
        { value: 'destination', label: 'Inside each destination page' },
        { value: 'packages', label: 'Check Packages' },
        { value: 'picks', label: 'Our Picks' },
        { value: 'blog', label: 'Blog' },
        { value: 'blogpost', label: 'Inside a blog post (up to 4)' },
        { value: 'gallery', label: 'Gallery' },
        { value: 'shop', label: 'Shop' },
      ] },
    ] },

  /* ----- Google AdSense (FR-HOME-014, FR-DEST-012, FR-TRIP-012,
     FR-BLOG-006, FR-GAL-004, FR-PICKS-005). Each section is configured on its
     own — they are not linked — and Check Packages carries no ads at all
     (client direction, v1.4). ----- */
  { key: 'ads', group: 'Money', label: 'AdSense — account & switch', type: 'object', path: 'ads',
    fields: [
      { name: 'enabled', label: 'Serve live Google ads', type: 'bool' },
      { name: 'publisherId', label: 'AdSense publisher ID', ph: 'ca-pub-0000000000000000' },
      { name: 'showPlaceholders', label: 'Show a marked placeholder where each ad will sit (while waiting for Google approval)', type: 'bool' },
      { name: 'note', label: 'Note to yourself (never shown on the site)', type: 'textarea', ph: 'e.g. applied to AdSense on 3 May — waiting for review' },
    ] },
  { key: 'adUnits', group: 'Money', label: 'AdSense — ad slots', type: 'list', path: 'adUnits',
    itemTitle: 'label',
    fields: [
      { name: 'label', label: 'Name it for yourself', ph: 'e.g. Home — after the third card' },
      { name: 'page', label: 'Which section', type: 'select', options: [
        { value: 'home', label: 'Home (up to 10)' },
        { value: 'destinations', label: 'Destination listing (up to 20)' },
        { value: 'destination', label: 'Inside a destination page (up to 20)' },
        { value: 'trip', label: 'Go For A Trip pages (up to 20)' },
        { value: 'blog', label: 'Blog listing (up to 4)' },
        { value: 'blogpost', label: 'Inside a blog post (up to 4)' },
        { value: 'gallery', label: 'Gallery (up to 4)' },
        { value: 'picks', label: 'Our Picks (up to 4)' },
      ] },
      { name: 'slotId', label: 'Ad slot ID from AdSense', ph: 'e.g. 1234567890' },
      { name: 'format', label: 'Shape', type: 'select', options: [
        { value: 'auto', label: 'Responsive (recommended)' },
        { value: 'rectangle', label: 'Rectangle' },
        { value: 'horizontal', label: 'Wide strip' },
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

  /* ----- Travel Tips (formerly the Gallery tab — client "Travel Tips Tab" doc) ----- */
  { key: 'travelTips', label: 'Travel tip sections', type: 'list', path: 'travelTips',
    itemTitle: 'title',
    fields: [
      { name: 'title', label: 'Section name', ph: 'e.g. How to Plan a Trip' },
      { name: 'image', label: 'Representational image (one per section)', type: 'image' },
      { name: 'imageAlt', label: 'Image description (for screen readers)', ph: 'e.g. A map and notebook laid out for trip planning' },
      { name: 'body', label: 'Text content', type: 'textarea', rich: true },
      { name: 'link1Label', label: 'Affiliate / sponsor link 1 — text', ph: 'e.g. Compare flights and hotels' },
      { name: 'link1Url', label: 'Affiliate / sponsor link 1 — URL', type: 'url', ph: 'https://partner-website.com' },
      { name: 'link2Label', label: 'Affiliate / sponsor link 2 — text', ph: 'e.g. Download a trip-planning checklist' },
      { name: 'link2Url', label: 'Affiliate / sponsor link 2 — URL', type: 'url', ph: 'https://partner-website.com' },
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
    path: 'destinations', itemTitle: 'name', max: 12 /* FR-HOME-005 */ },
  { key: 'pick-announcements', label: 'Pick announcements for the homepage', type: 'picker',
    path: 'announcements', itemTitle: 'title', max: 20 /* FR-HOME-012 */ },
  { key: 'pick-blogPosts', label: 'Pick blog posts for the homepage', type: 'picker',
    path: 'blog.posts', itemTitle: 'title' },
  { key: 'pick-gallery', label: 'Pick media for the homepage wall', type: 'picker',
    path: 'galleryItems', itemTitle: 'label', max: 100 /* FR-HOME-023: 50 films + 50 photographs */ },

  /* ----- Page heroes ----- */
  ...['destinations', 'packages', 'blog', 'announcements', 'travel-tips', 'gallery', 'picks', 'about', 'contact'].map((p) => ({
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
  { key: 'homepage', group: 'pages', label: 'Homepage', view: '/',
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
      { key: 'mediaHead', hint: 'Heading row of the media wall (photos & films).' },
      { key: 'pick-gallery', hint: 'Tick which gallery items appear on the homepage media wall — up to 50 videos and 50 images. Films auto-play on hover; images enlarge.' },
      { key: 'ask', hint: 'The cream contact block near the bottom.' },
    ] },
  { key: 'destinations', group: 'content', label: 'Destinations', view: '/destinations',
    intro: 'The destinations index page.',
    sections: [
      { key: 'page-destinations', hint: 'Big title and intro at the top of the page.' },
      { key: 'destinations', hint: 'The master list of destinations. Order here = order everywhere. Tick "homepage" in the Homepage tab to feature one.' },
      { key: 'destCategories', hint: 'The universal category taxonomy — powers the filter pills, the /categories page (add a round image per category), and destination/package tagging. Counts are automatic.' },
    ] },
  { key: 'packages', group: 'content', label: 'Packages', view: '/packages',
    intro: 'All travel packages. The homepage shows the first two automatically.',
    sections: [
      { key: 'page-packages', hint: 'Big title and intro at the top of the page.' },
      { key: 'packages', hint: 'Every package card — pricing, badges, partner links.' },
    ] },
  { key: 'blog', group: 'content', label: 'Blog', view: '/blog',
    intro: 'The blog landing page. The homepage strip shows the first three posts.',
    sections: [
      { key: 'page-blog', hint: 'Big title and intro at the top of the page.' },
      { key: 'blogFeature', hint: 'The large featured story at the top.' },
      { key: 'blogSide', hint: 'The 4 small stories beside the featured one.' },
      { key: 'blogPosts', hint: 'The main grid of posts.' },
    ] },
  { key: 'announcements', group: 'content', label: 'Announcements', view: '/announcements',
    intro: 'All announcements. The homepage shows the 4 newest automatically.',
    sections: [
      { key: 'page-announcements', hint: 'Big title and intro at the top of the page.' },
      { key: 'announcements', hint: 'Every announcement card.' },
    ] },
  { key: 'gallery', group: 'content', label: 'Gallery', view: '/gallery',
    intro: 'Photo and video tiles in the masonry grid.',
    sections: [
      { key: 'page-gallery', hint: 'Big title and intro at the top of the page.' },
      { key: 'galleryItems', hint: 'Every tile. Pick a category from the dropdown; type "Film / video" shows a play button.' },
      { key: 'galleryCategories', hint: 'The filter chips above the grid. Counts are automatic.' },
    ] },
  { key: 'travel-tips', group: 'content', label: 'Travel Tips', view: '/travel-tips',
    intro: 'The Travel Tips page — one block per topic, shown top to bottom in this order.',
    sections: [
      { key: 'page-travel-tips', hint: 'Big title and intro at the top of the page.' },
      { key: 'travelTips', hint: 'Each topic: its name, one image, the text, and up to two affiliate/sponsor links. The links open in a new tab with no consent prompt.' },
    ] },
  { key: 'picks', group: 'content', label: 'Our Picks', view: '/picks',
    intro: 'Four ranked lists, shown as tabs. Each pick is tagged to a list; rank numbers come from the order within that list.',
    sections: [
      { key: 'page-picks', hint: 'Big title and intro at the top of the page.' },
      { key: 'pickLists', hint: 'The tabs across the top — each is one ranked list. Order here sets the tab order; the first tab opens by default.' },
      { key: 'picks', hint: 'Every ranked place. Set "Which list" so it shows under the right tab; order within each list sets its rank.' },
    ] },
  { key: 'shop', group: 'content', label: 'Shop', view: '/shop',
    intro: 'The photography & footage licensing page — media tiles, Shutterstock link, and the quote form.',
    sections: [
      { key: 'shop', hint: 'Page headings, the two tab labels, your Shutterstock URL, the bottom strip, and where quote requests are emailed.' },
      { key: 'shopItems', hint: 'Every licensable image/video. Each becomes a selectable tile; visitors add items and request a quote — which lands in Messages (and is emailed if SMTP is set).' },
    ] },
  { key: 'about', group: 'pages', label: 'About', view: '/about',
    intro: 'The About page — hero, owner story, mission, what you offer, and the contact CTA.',
    sections: [
      { key: 'page-about', hint: 'Hero title and intro at the top of the page.' },
      { key: 'about', hint: 'The four sections: owner story, mission & vision, “what we offer” heading, and the contact call-to-action.' },
      { key: 'aboutStats', hint: 'The number tiles in the Mission section (e.g. 450 destinations).' },
      { key: 'aboutOffers', hint: 'The “what we offer” cards (the three things you do).' },
    ] },
  { key: 'contact', group: 'pages', label: 'Contact', view: '/contact',
    intro: 'Title and intro of the Contact page.',
    sections: [{ key: 'page-contact', hint: 'Big title and intro at the top of the page.' }] },
  { key: 'legal', group: 'pages', label: 'Legal Pages', view: '/legal',
    intro: 'The legal documents shown at /legal and linked in the footer "Legal" column. Edit each one’s full content here.',
    sections: [
      { key: 'legalDocs', hint: 'Each document’s heading, intro and full body. “Show in footer” controls the footer Legal column; reorder to set the footer + sidebar order.' },
    ] },
  /* FR-HOME-015..017, FR-DEST-019 — the paid placements. The schema existed but
     had no page in the panel, so nobody could manage them. */
  { key: 'ads', group: 'money', label: 'Advertising (AdSense)', view: '/',
    intro: 'Google ads, section by section. Ads stay off until you switch them on with your publisher ID — until then each slot shows a marked placeholder so you can see where they will sit. Check Packages carries no ads.',
    sections: [
      { key: 'ads', hint: 'Your AdSense account and the master switch. Google must approve the site before live ads appear.' },
      { key: 'adUnits', hint: 'One row per ad slot. Pick the section it belongs to and paste the slot ID from AdSense. Limits per the spec: Home 10, Destination 20 each, Go For A Trip 20, Blog 4, blog post 4, Gallery 4, Our Picks 4.' },
    ] },
  { key: 'sponsored', group: 'money', label: 'Sponsored & affiliate', view: '/',
    intro: 'Paid placements: sponsored packages, partner cards and affiliate links, and the pages each one appears on. Every outbound link shows the consent notice before it leaves your site.',
    sections: [
      { key: 'sponsored', hint: 'One card per paid placement. Pick the pages it should appear on, give it a partner name (shown in the consent notice) and either a link or a phone number.' },
    ] },
  { key: 'banners', group: 'money', label: 'Promo Banners', view: '/',
    intro: 'Promotional banners and animation strips placed in fixed zones across the site. Use Status to schedule or hide each one.',
    sections: [
      { key: 'banners', hint: 'Pick a zone (site-wide top bar, or below/mid the homepage). Slim strips show text + a button; wide banners show your image. External links open the consent modal.' },
    ] },
  { key: 'pages', group: 'pages', label: 'Custom Pages', view: '/',
    intro: 'Build standalone pages (Careers, Press, FAQs…) that live at /p/your-slug. Optionally link them in the footer.',
    sections: [
      { key: 'customPages', hint: 'Each page has a heading, intro, optional hero image and a full rich-text body. “Show in footer” adds it to the footer Company column.' },
    ] },
  { key: 'navbar', group: 'settings', label: 'Navbar', view: '/', isSettings: true,
    intro: 'The links in the header navigation bar. Drag the handle to reorder, edit a label or link, or add a new one. A link can optionally open one of the built-in dropdown menus.',
    sections: [
      { key: 'nav', hint: 'Each header link: its label, where it points, and (optionally) which dropdown it opens. Drag ⠿ to reorder; “+ Add item” for a new link.' },
      { key: 'megaMenus', hint: 'The “View all …” links inside the dropdown menus — their text and where they go.' },
    ] },
  { key: 'site', group: 'settings', label: 'Site Settings', view: '/', isSettings: true,
    intro: 'Brand, header button, footer and admin security.',
    sections: [
      { key: 'settings', hint: 'Brand name, header button, contact email, copyright.' },
    ] },
];
/* FRS §6 System Capacity Summary — shown beside each list so the admin knows
   the agreed ceiling. Not enforced as a hard block; the panel warns instead. */
const CAPACITY = {
  adUnits: 46,             // 10 + 20 + 4 + 4 + 4 + 4 across the sections (FRS §6)
  highlights: 12,          // FR-HOME-008
  destinations: 450,
  destCategories: 100,
  packages: null,          // unlimited (FR-PKG-006)
  announcements: null,     // master list unlimited (FR-HOME-013A)
  picks: 80,               // 4 lists x 20 (FR-PICKS-002)
  pickLists: 10,
  galleryItems: 100,       // 50 videos + 50 images (FR-GAL-001)
  shopItems: 100,          // 50 + 50 (FR-SHOP-001)
  travelTips: null,
  sponsored: 20,           // on Home (FR-HOME-015)
  banners: null,
  customPages: null,
  legalDocs: null,
};

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
  // Destination (and Go For A Trip) dropdown: the first 10 categories holding a
  // destination, then the "All Destination Categories" link — 11 rows.
  const dests = pub(store.get('destinations') || []);
  const navCategories = (store.get('destCategories') || [])
    .map((cat) => ({ slug: cat.slug, label: cat.label, count: dests.filter((d) => (d.categories || []).includes(cat.slug)).length }))
    .filter((cat) => cat.count > 0)
    .slice(0, 10);
  res.render('partials.js.njk', {
    settings: store.get('settings'),
    legalDocs: store.get('legalDocs') || [],
    customPages: pub(store.get('customPages') || []).filter((p) => p.inFooter),
    siteTopBanners: siteTop,
    siteBottomBanners: siteBottom,
    navCategories,
    ads: adsConfig(),
    // Our Picks dropdown: up to 10 lists, then "View all" (FR: 10 + 1 rows)
    pickLists: (store.get('pickLists') || []).slice(0, 10),
  });
});
app.use('/assets/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));   // timestamped names never change
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
function sponsorSlots(pageKey, count, max) {
  const slots = {};
  // the index travels with the sponsor so one without a website can point its
  // enquiry form back at itself (/package-quote?sp=…)
  const list = (c().sponsored || [])
    .map((sp, i) => ({ ...sp, _idx: i }))
    .filter((sp) => isVisible(sp) && (sp.pages || []).includes(pageKey) && (sp.title || '').trim())
    .slice(0, max || Infinity);
  list.forEach((sp, j) => {
    let pos = Math.floor(((j + 1) * count) / (list.length + 1));
    while (slots[pos] !== undefined) pos += 1;   // avoid collisions on tiny grids
    slots[pos] = sp;
  });
  return slots;
}

/* FRS §6 System Capacity Summary — the published limits, applied when content
   is served so the site never exceeds what was agreed, and shown next to each
   list in the admin. `capped` keeps the first N; `cappedMedia` keeps the first
   N videos AND the first N images, because the FRS counts those separately. */
const LIMITS = {
  homeFeatured: 12,        // FR-HOME-005
  homeHighlights: 12,      // FR-HOME-008
  homeAnnouncements: 20,   // FR-HOME-012
  homeSponsored: 20,       // FR-HOME-015
  picksSponsored: 4,       // FR-PICKS-005
  picksPerList: 20,        // FR-PICKS-002
  sectionVideos: 50,       // FR-HOME-023, FR-GAL-001, FR-SHOP-001
  sectionImages: 50,
  destVideos: 20,          // FR-DEST-011
  destImages: 20,
  postVideos: 5,           // FR-BLOG-005
  postImages: 20,
};
const capped = (arr, n) => (arr || []).slice(0, n);
const isVideoUrl = (u) => /\.(mp4|webm|mov|ogg)(\?|$)/i.test(String(u || ''));
function cappedMedia(list, maxVideos, maxImages, isVideo) {
  let v = 0, i = 0;
  return (list || []).filter((item) => {
    if (isVideo(item)) return v++ < maxVideos;
    return i++ < maxImages;
  });
}

/* Google AdSense. Ad units are spread through a page's grid the same way
   sponsored cards are, and each section keeps its own set — FRS §6 caps them:
   Home 10, Destination Guide 20, Go For A Trip 20, Blog 4, Gallery 4,
   Our Picks 4, and none on Check Packages. */
const AD_LIMITS = { home: 10, destinations: 20, destination: 20, trip: 20, blog: 4, blogpost: 4, gallery: 4, picks: 4 };
function adsConfig() {
  const a = c().ads || {};
  return {
    enabled: !!a.enabled && !!(a.publisherId || '').trim(),
    publisherId: (a.publisherId || '').trim(),
    showPlaceholders: a.showPlaceholders !== false,
  };
}
function adUnits(pageKey) {
  const limit = AD_LIMITS[pageKey] || 0;
  return (c().adUnits || [])
    .filter((u) => isVisible(u) && u.page === pageKey)
    .slice(0, limit);
}
/* position in the grid -> ad unit, like sponsorSlots */
function adSlots(pageKey, count) {
  const list = adUnits(pageKey);
  const slots = {};
  list.forEach((u, j) => {
    let pos = Math.floor(((j + 1) * count) / (list.length + 1));
    while (slots[pos] !== undefined) pos += 1;
    slots[pos] = u;
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

/* ---------- item lifecycle (FR-OTHER-005: add, edit, publish, hide, unhide,
   activate, deactivate, archive, delete) ----------
   Three stored flags carry every state: `published` (false = hidden),
   `archived` (true = out of public view but kept), and `expiry` (a date that
   archives the item by itself). statusOf() collapses them into one word for
   the admin UI. */
function statusOf(item) {
  if (!item || typeof item !== 'object') return 'live';
  if (item.archived === true) return 'archived';
  if (item.published === false) return 'hidden';
  if (item.expiry) {
    const d = new Date(item.expiry);
    if (!Number.isNaN(d.getTime())) return d.getTime() < Date.now() ? 'expired' : 'scheduled';
  }
  return 'live';
}
/* Every collection the admin can manage, as [label, array] — one list feeds the
   dashboard counts, the expiry sweep and the link checker. */
function allCollections() {
  const d = c();
  return [
    ['Destinations', d.destinations], ['Packages', d.packages],
    ['Blog posts', d.blog && d.blog.posts], ['Announcements', d.announcements],
    ['Travel tips', d.travelTips], ['Gallery', d.galleryItems], ['Our Picks', d.picks],
    ['Shop media', d.shopItems], ['Promo banners', d.banners],
    ['Sponsored placements', d.sponsored], ['Custom pages', d.customPages],
    ['Categories', d.destCategories], ['Legal pages', d.legalDocs],
  ];
}
/* FR-OTHER-003A — an item past its expiry date archives itself. Runs on boot,
   hourly, and whenever the admin opens a page, so the panel never shows an
   expired item as live. */
function sweepExpired() {
  const now = Date.now();
  let changed = 0;
  allCollections().forEach(([, arr]) => (arr || []).forEach((item) => {
    if (!item || item.archived === true || !item.expiry) return;
    const d = new Date(item.expiry);
    if (!Number.isNaN(d.getTime()) && d.getTime() < now) { item.archived = true; item.autoArchived = true; changed += 1; }
  }));
  if (changed) store.save();
  return changed;
}
setInterval(sweepExpired, 60 * 60 * 1000);
setTimeout(sweepExpired, 3000);

/* Content status overview for the admin dashboard (FR-OTHER-010):
   per-collection counts of live / archived / hidden / scheduled items. */
function contentStats() {
  const d = c();
  const collections = [
    ['Destinations', d.destinations],
    ['Packages', d.packages],
    ['Blog posts', d.blog && d.blog.posts],
    ['Announcements', d.announcements],
    ['Travel tips', d.travelTips],
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
/* A link typed into the CMS that points off-site is treated as external —
   consent card, provider name from its host — whether or not the editor
   remembered the "external" switch (FR-LINK-003). */
function markExternal(item, hrefKey) {
  const href = item && item[hrefKey];
  if (!item || item.external || !/^https?:\/\//i.test(String(href || ''))) return item;
  let host = 'External website';
  try { host = new URL(href).hostname.replace(/^www\./, ''); } catch (e) { /* keep default */ }
  return { ...item, external: true, extUrl: href, extProvider: item.extProvider || host };
}

/* Newest first — the FRS asks for the "latest" announcements. Dates are typed
   free-form in the CMS ("12 May 2026"); an unreadable one keeps its list order. */
function newestFirst(list) {
  return (list || []).map((a, i) => ({ a, i, t: Date.parse(a && a.date) }))
    .sort((x, y) => (Number.isNaN(y.t) ? -Infinity : y.t) - (Number.isNaN(x.t) ? -Infinity : x.t) || x.i - y.i)
    .map((x) => x.a);
}
function resolveAnnouncements(list) {
  return (list || []).map((a) => {
    let href = a.href || '/announcements';
    const t = (a.target || '').trim();
    switch (a.section) {
      // an unset target must not produce a bare /detail URL — that lands on
      // whichever item happens to be first (FR-HOME-013B)
      case 'destination': href = t ? '/destination-detail?d=' + encodeURIComponent(t) : '/destinations'; break;
      case 'trip': href = t ? '/destinations?cat=' + encodeURIComponent(t) + '&from=categories' : '/categories'; break;   // Find Trip Deals
      case 'picks': href = '/picks'; break;
      case 'packages': href = t ? '/packages?d=' + encodeURIComponent(t) : '/packages'; break;
      case 'shop': href = '/shop'; break;
      case 'travel-tips': href = '/travel-tips'; break;
      case 'gallery': href = '/gallery'; break;
      case 'blog': href = t ? '/blog-post?b=' + encodeURIComponent(t) : '/blog'; break;
      case 'external': href = a.extUrl || a.href || '#'; break;
      case 'url': if (t) href = t; break;
      default: break;
    }
    // the same guard for hrefs typed straight into the CMS
    if (/^\/(destination-detail|blog-post|package-detail|package-quote)\/?$/.test(href)) {
      href = { '/destination-detail': '/destinations', '/blog-post': '/blog' }[href.replace(/\/$/, '')] || '/packages';
    }
    return markExternal({ ...a, href }, 'href');
  });
}

/* Active promo banners grouped by zone (FR-OTHER-012). */
function bannersByZone() {
  const out = {};
  pub(c().banners).forEach((b) => {
    const zone = b.zone || 'home-top';
    (out[zone] = out[zone] || []).push(markExternal(b, 'href'));
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
  [['About', '/about'], ['Contact', '/contact'], ['Travel Tips', '/travel-tips'], ['Gallery', '/gallery'], ['Shop', '/shop']]
    .forEach(([title, url]) => out.push({ type: 'Page', title, desc: '', url }));
  pub(d.travelTips).forEach((x) => out.push({ type: 'Travel tip', title: x.title, desc: clip(x.body, 120), url: '/travel-tips#' + slugify(x.title) }));
  return out;
}
function runSearch(q, mode) {
  let query = String(q || '').trim().toLowerCase();
  // "…" around the words means an exact match, as does mode=exact
  let exact = mode === 'exact';
  if (/^".+"$/.test(query)) { exact = true; query = query.slice(1, -1).trim(); }
  if (!query) return [];
  const wordRe = exact ? new RegExp('(^|[^a-z0-9])' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i') : null;
  return searchIndex()
    .filter((it) => {
      const hay = plain(it.title) + ' ' + plain(it.desc || '');
      return exact ? wordRe.test(hay) : hay.toLowerCase().includes(query);
    })
    .sort((a, b) => (plain(a.title).toLowerCase() === query ? 0 : 1) - (plain(b.title).toLowerCase() === query ? 0 : 1));
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
  '/travel-tips': 'Travel Tips',
  '/gallery': 'Gallery',
  '/picks': 'Our Picks',
  '/about': 'About Us',
  '/contact': 'Contact',
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

/* ---------- breadcrumbs (the "link bar") ----------
   The trail a visitor clicked travels in the URL: ?cat= keeps the category step
   and ?from= remembers which tab they came in through. Going forward, coming
   Back and opening a shared link therefore all show the same trail, instead of
   collapsing to "Destination". */
const CRUMB_SOURCES = {
  destinations: { label: 'Destination', href: '/destinations' },
  categories: { label: 'Categories', href: '/categories' },
  picks: { label: 'Our Picks', href: '/picks' },
  blog: { label: 'Blog', href: '/blog' },
  packages: { label: 'Check Packages', href: '/packages' },
};
/* Home / <where they came in> / <category, if any>. `base` is the section to
   name when no ?from= was given; `catHref` is where the category step points. */
function crumbTrail(q, { base = 'destinations', catHref = '/destinations?cat=' } = {}) {
  const from = String((q && q.from) || '');
  const cat = String((q && q.cat) || '');
  const out = [{ label: 'Home', href: '/' }, { ...(CRUMB_SOURCES[from] || CRUMB_SOURCES[base]) }];
  const catObj = cat ? (c().destCategories || []).find((x) => x.slug === cat) : null;
  if (catObj) out.push({ label: catObj.label, href: catHref + encodeURIComponent(cat) + (from ? '&from=' + encodeURIComponent(from) : '') });
  return out;
}
/* The page you are on is the last crumb, and is not a link. */
function endTrail(crumbs, label) {
  if (label) crumbs.push({ label });
  else if (crumbs.length) delete crumbs[crumbs.length - 1].href;
  return crumbs;
}
/* Carry the trail onto a child link: "&cat=hidden-gems&from=categories" */
function trailQS(q) {
  const parts = [];
  if (q && q.cat) parts.push('cat=' + encodeURIComponent(q.cat));
  if (q && q.from) parts.push('from=' + encodeURIComponent(q.from));
  return parts.length ? '&' + parts.join('&') : '';
}

const PAGES = {
  index: (req) => {
    const s = c().settings || {};
    const brand = s.brandName || 'Triplipi';
    return {
      settings: s,
      home: c().home,
      destinations: capped(pub(c().destinations).filter((d) => d.featured), LIMITS.homeFeatured),
      adSlots: adSlots('home', capped(pub(c().destinations).filter((d) => d.featured), LIMITS.homeFeatured).length),
      // FR-HOME-023..027 — the media wall: up to 50 videos + 50 images
      mediaItems: cappedMedia(pub(c().galleryItems).filter((g) => g.featured),
        LIMITS.sectionVideos, LIMITS.sectionImages, (g) => g.type === 'video'),
      // FR-HOME-015..017 — sponsored packages, ads and affiliate links on Home
      sponsorSlots: sponsorSlots('home', capped(pub(c().destinations).filter((d) => d.featured), LIMITS.homeFeatured).length, LIMITS.homeSponsored),
      highlights: capped(pub(c().highlights), LIMITS.homeHighlights).map((h) => ({
        ...h,
        href: h.destinationSlug ? '/destination-detail?d=' + encodeURIComponent(h.destinationSlug)
          : (h.href || '/destinations'),
      })).map((h) => markExternal(h, 'href')),
      // FR-HOME-012: the twenty latest, drawn from the master list
      announcements: resolveAnnouncements(capped(newestFirst(pub(c().announcements).filter((a) => a.featured)), LIMITS.homeAnnouncements)),
      blogPosts: pub(c().blog.posts).filter((p) => p.featured),
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
    // Each card: Know More (→ the destination) + Check Packages (→ its packages)
    const cards = items;
    const q = (req && req.query) || {};
    return { page: c().pages.destinations, cards, categories, activeCat, adSlots: adSlots('destinations', items.length), activeCatLabel: catObj ? catObj.label : '', totalAll: all.length, pagination, baseUrl, sponsorSlots: sponsorSlots('destinations', items.length),
      crumbs: endTrail(crumbTrail(q)), trail: trailQS(q) };
  },
  categories: (req) => {
    // Circular category grid (8-up). The universal taxonomy (destCategories) —
    // each links into the destinations index filtered by that category slug.
    const cats = (c().destCategories || []).filter(isVisible);
    return {
      page: {
        titleHtml: 'Browse by <em>category</em>.',
        lead: 'Pick a kind of trip — mountains for solitude, beaches for slowness, heritage for the stories etched into stone. Every category opens its own curated index.',
      },
      categories: cats,
      // FR-TRIP-012 — the trip funnel's own ad configuration
      adSlots: adSlots('trip', cats.length),
    };
  },
  packages: (req) => {
    // FR-PKG-002: only show packages that lead somewhere — a provider/affiliate
    // link, a details link, or a contact-form fallback (provider name/info).
    const hasLink = (p) => !!(p.ctaUrl || (p.ctaExternal && p.ctaUrl) || p.ctaHref || p.ctaProvider || p.providerInfo);
    const allPkgs = pub(c().packages).filter(hasLink);
    let all = allPkgs;
    const q = (req && req.query) || {};
    // destination filter (?d=) — every "Check Packages" button lands here. A known
    // destination with no packages of its own says so, then lists everything.
    let destFilter = null, destEmpty = null;
    if (q.d) {
      const tagged = all.filter((p) => (p.destinationSlugs || []).includes(q.d));
      const destName = ((c().destinations || []).find((x) => x.slug === q.d) || {}).name;
      if (tagged.length) { all = tagged; destFilter = destName || q.d; }
      else if (destName) destEmpty = destName;
    }
    // Category rail (?cat=) — the same visible taxonomy as /categories, counted
    // against whatever ?d= left. Only categories holding a package get a tile,
    // but a link to an empty one filters to nothing and says so, instead of
    // silently falling back to every package.
    const allCats = pub(c().destCategories).map((cat) => ({
      ...cat, count: all.filter((p) => (p.categories || []).includes(cat.slug)).length,
    }));
    const categories = allCats.filter((cat) => cat.count > 0);
    const catObj = allCats.find((x) => x.slug === q.cat) || null;
    const activeCat = catObj ? catObj.slug : '';
    const totalAll = all.length;
    if (catObj) all = all.filter((p) => (p.categories || []).includes(activeCat));
    const { items, pagination } = paginate(all, req);
    // preserve active filters across pagination
    const qs = [];
    if (q.d) qs.push('d=' + encodeURIComponent(q.d));
    if (catObj) qs.push('cat=' + encodeURIComponent(activeCat));
    const baseUrl = '/packages' + (qs.length ? '?' + qs.join('&') : '');
    // Home / Check Packages / <destination, if filtered> / <category, if picked>
    const crumbs = crumbTrail(q, { base: 'packages', catHref: '/packages?cat=' });
    if (destFilter || destEmpty) crumbs.splice(2, 0, { label: destFilter || destEmpty, href: '/packages?d=' + encodeURIComponent(q.d) });
    return {
      page: c().pages.packages, packages: items, pagination, baseUrl,
      sponsorSlots: sponsorSlots('packages', items.length),
      destFilter, destEmpty, categories, activeCat, activeCatLabel: catObj ? catObj.label : '',
      totalAll, dParam: q.d || '', crumbs: endTrail(crumbs), trail: trailQS(q),
    };
  },
  blog: (req) => {
    const { items, pagination } = paginate(pub(c().blog.posts), req);
    const dests = c().destinations || [];
    // the featured story and the side strip each open their own post
    const postHref = (title) => {
      const all = pub(c().blog.posts || []);
      const t = plain(title || '');
      // the chosen post, or the newest one, so the card never leads nowhere
      const hit = all.find((x) => plain(x.title) === t) || all[0];
      return hit ? '/blog-post?b=' + encodeURIComponent(slugify(plain(hit.title))) : '/blog';
    };
    // Each blog card gets "Know More" (→ its destination) + "Check Packages"
    // (→ that destination's packages).
    const posts = items.map((p) => {
      const dest = dests.find((d) => d.slug === p.destinationSlug) || null;
      return { ...p, dest: dest ? { slug: dest.slug, name: dest.name, cat: (dest.categories || [])[0] || '' } : null };
    });
    const feature = { ...(c().blog.feature || {}) };
    feature.href = postHref(feature.postTitle);
    const side = (c().blog.side || []).map((x) => ({ ...x, href: postHref(x.postTitle) }));
    return { page: c().pages.blog, blog: { ...c().blog, posts, feature, side }, adSlots: adSlots('blog', items.length), pagination, baseUrl: '/blog', sponsorSlots: sponsorSlots('blog', items.length) };
  },
  announcements: (req) => {
    const { items, pagination } = paginate(resolveAnnouncements(newestFirst(pub(c().announcements))), req);
    return { page: c().pages.announcements, announcements: items, pagination, baseUrl: '/announcements' };
  },
  gallery: (req) => {
    const all = cappedMedia(pub(c().galleryItems), LIMITS.sectionVideos, LIMITS.sectionImages, (g) => g.type === 'video');
    const categories = (c().galleryCategories || []).map((cat) => ({
      ...cat,
      count: all.filter((g) => g.category === cat.slug).length,
    }));
    const { items, pagination } = paginate(all, req);
    return {
      page: c().pages.gallery, items, categories, pagination, baseUrl: '/gallery', adSlots: adSlots('gallery', items.length), sponsorSlots: sponsorSlots('gallery', items.length),
      typeCounts: {
        image: all.filter((g) => g.type === 'image').length,
        video: all.filter((g) => g.type === 'video').length,
      },
    };
  },
  // Travel Tips (formerly Gallery): every topic stacked in admin order, each with
  // an anchor id so search results and deep links can land on it.
  'travel-tips': () => ({
    page: c().pages['travel-tips'] || {},
    tips: pub(c().travelTips).map((t) => ({ ...t, anchor: slugify(t.title) })),
  }),
  picks: (req) => {
    const allPicks = pub(c().picks);
    const lists = (c().pickLists || []).map((l) => ({
      ...l, count: allPicks.filter((p) => p.list === l.key).length,
    }));
    // active list: ?list= when it names a real list; anything else — no param,
    // ?list=all, a stale key — is the All tab, every pick in one grid.
    const reqList = (req && req.query && req.query.list) || '';
    const active = reqList && reqList !== 'all' ? lists.find((l) => l.key === reqList) || null : null;
    const inList = active
      ? capped(allPicks.filter((p) => p.list === active.key), LIMITS.picksPerList)
      : allPicks;   // the All view shows every list's picks together
    const { items, pagination } = paginate(inList, req);
    const baseUrl = active ? '/picks?list=' + encodeURIComponent(active.key) : '/picks?list=all';
    // Each pick renders as a destination card with Know More + Check Packages
    // (Our Picks Tab doc): resolve its destination for season/tagline and the packages link.
    const dests = c().destinations || [];
    const picks = items.map((p) => {
      const dest = dests.find((d) => d.slug === p.destinationSlug) || null;
      return { ...p, dest: dest ? { slug: dest.slug, name: dest.name, season: dest.season, tagline: dest.tagline, cat: (dest.categories || [])[0] || '' } : null };
    });
    return { page: c().pages.picks, picks, lists, active, totalAll: allPicks.length, pagination, baseUrl,
      sponsorSlots: sponsorSlots('picks', items.length, LIMITS.picksSponsored),   // FR-PICKS-005
      adSlots: adSlots('picks', items.length) };
  },
  about: () => ({ page: c().pages.about, about: c().about || {}, aboutStats: c().aboutStats || [], aboutOffers: (c().aboutOffers || []).map((o) => markExternal(o, 'linkHref')) }),
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
    const { items, pagination } = paginate(
      cappedMedia(pub(c().shopItems), LIMITS.sectionVideos, LIMITS.sectionImages, (it) => it.type === 'video'), req);
    return { shop: c().shop || {}, items, pagination, baseUrl: '/shop', settings: c().settings, sponsorSlots: sponsorSlots('shop', items.length) };
  },
  'destination-detail': (req) => {
    const all = c().destinations || [];
    const slug = (req && req.query && req.query.d) || '';
    let dest = all.find((d) => d.slug === slug) || all[0] || {};
    const brand = (c().settings || {}).brandName || 'Triplipi';
    const img = absUrl(req, dest.heroImage || dest.image || '');
    const desc = clip(dest.lead || dest.tagline || dest.overview, 300);
    const seo = {
      brand,
      title: plain(dest.metaTitle) || (dest.name || 'Destination') + ' — ' + brand,
      description: plain(dest.metaDescription) || desc,
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
    const pageAds = adUnits('destination');   // FR-DEST-012: up to 20 per page
    // FR-DEST-011 — the gallery on a destination page holds 20 films + 20 photos
    if (Array.isArray(dest.gallery)) {
      dest = { ...dest, gallery: cappedMedia(dest.gallery, LIMITS.destVideos, LIMITS.destImages, isVideoUrl) };
    }
    // FR-DEST-019 — unlimited sponsored/affiliate placements inside a destination
    const sponsors = (c().sponsored || []).filter((sp) => (sp.pages || []).includes('destination') && (sp.title || '').trim());
    return { dest, sponsors, pageAds, related: all.filter((d) => d.slug !== dest.slug).slice(0, 4), seo,
      crumbs: endTrail(crumbTrail((req && req.query) || {}), dest.name) };
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
      title: plain(pkg.metaTitle) || (plain(pkg.title) || 'Package') + ' — ' + brand,
      description: plain(pkg.metaDescription) || desc,
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
    // "Check Packages" at the bottom of the sidebar opens this destination's packages
    const dest = (c().destinations || []).find((d) => (pkg.destinationSlugs || []).includes(d.slug)) || null;
    return { pkg, dest: dest ? { slug: dest.slug, name: dest.name } : null, seo,
      crumbs: endTrail(crumbTrail((req && req.query) || {}, { base: 'packages', catHref: '/packages?cat=' }), plain(pkg.title)) };
  },
  'package-quote': (req) => {
    // "Seek your quote" contact form for a package with no provider website —
    // routed to the package provider's email (Check Packages Tab doc, pp.7-9).
    // A sponsored placement with no website sends its enquiry here too (?sp=).
    const brand = (c().settings || {}).brandName || 'Triplipi';
    const siteEmail = (c().settings || {}).contactEmail || '';
    const spIdx = (req && req.query && req.query.sp) || '';
    if (spIdx !== '') {
      const sp = (c().sponsored || [])[parseInt(spIdx, 10)] || {};
      return {
        pkg: { title: sp.title || 'Enquiry' },
        provider: sp.partner || sp.title || 'our partner',
        toEmail: sp.providerEmail || siteEmail,
        seo: { ...defaultSeo(req), title: 'Enquiry — ' + brand, robots: 'noindex, nofollow' },
      };
    }
    const all = c().packages || [];
    const key = (req && req.query && req.query.p) || '';
    const pkg = all.find((x) => slugify(x.title) === key) || all[parseInt(key, 10)] || {};
    const provider = pkg.ctaProvider || pkg.title || 'our partner';
    const toEmail = pkg.providerEmail || siteEmail;
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
      title: plain(post.metaTitle) || (plain(post.title) || 'Story') + ' — ' + brand,
      description: plain(post.metaDescription) || desc,
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
    // The closing "Check Packages" button opens the post's destination packages
    const dest = (c().destinations || []).find((d) => d.slug === post.destinationSlug) || null;
    // FR-BLOG-005 — a post carries up to 5 films and 20 photographs
    const postOut = Array.isArray(post.gallery)
      ? { ...post, gallery: cappedMedia(post.gallery, LIMITS.postVideos, LIMITS.postImages, isVideoUrl) }
      : post;
    return {
      post: postOut, related, seo,
      pageAds: adUnits('blogpost'),   // FR-BLOG-006: up to 4 ad slots per post
      dest: dest ? { slug: dest.slug, name: dest.name, cat: (dest.categories || [])[0] || '' } : null,
      // FR-BLOG-008 — sponsored packages / affiliate placements inside a post
      sponsors: Object.values(sponsorSlots('blogpost', 1, 4)),
    };
  },
  search: (req) => {
    const q = (req && req.query && req.query.q) || '';
    const mode = (req && req.query && req.query.mode) === 'exact' ? 'exact' : 'partial';
    const results = runSearch(q, mode);
    return { q, mode, results, count: results.length, seo: { ...defaultSeo(req), robots: 'noindex, follow' } };
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
  ['/', '/destinations', '/categories', '/packages', '/blog', '/announcements', '/travel-tips', '/gallery', '/picks', '/about', '/contact', '/shop']
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
/* FR-TRIP-001..007 — the Go For A Trip funnel, as the site is wired today:
   step 1 categories (/categories) → step 2 destination digests for that
   category (/destinations?cat=) → step 3 the destination page → step 4 its
   packages (/packages?d=) → step 5 package highlights (/package-detail) →
   step 6 the consent modal → step 7 redirect or stay. /trip is kept as the
   funnel's entry so old links and the FRS's own URL still work. */
app.get('/trip', (req, res) => res.redirect(302, req.query.d
  ? '/packages?d=' + encodeURIComponent(req.query.d)
  : '/categories'));
/* FR-BLOG-001 — "Destination Guide Blog" and "Our Experience Blog" are one
   section: either tab lands on the same page. */
app.get('/our-experience-blog', (req, res) => res.redirect(301, '/blog'));
app.get('/destination-guide-blog', (req, res) => res.redirect(301, '/blog'));
for (const [name, data] of Object.entries(PAGES)) {
  if (name === 'trip') continue;
  app.get('/' + name, (req, res) => res.render(name + '.njk', data(req)));
}

/* Dynamic custom pages (FR-PAGES-010 / FR-OTHER-004) — /p/:slug */
// The /p/faqs custom page duplicated the FAQ legal doc and is retired — send
// its old links (it was in the footer) to the one FAQ that remains.
app.get('/p/faqs', (req, res) => res.redirect(301, '/legal?p=faq'));
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

  /* FR-EMAIL-003 — each form can go to its own address: the form may carry an
     explicit _to (package provider, shop quote), otherwise Site settings routes
     it by name, otherwise the site contact email. */
  const st = store.get('settings') || {};
  const routed = /partner/i.test(formName) ? st.formEmailPartner
    : /guidance/i.test(formName) ? st.formEmailGuidance
    : /contact/i.test(formName) ? st.formEmailContact : '';
  const known = new Set([st.contactEmail, st.formEmailContact, st.formEmailPartner, st.formEmailGuidance, (c().shop || {}).quoteEmail]
    .concat((c().packages || []).map((p) => p.providerEmail), (c().sponsored || []).map((p) => p.providerEmail))
    .filter(Boolean).map((e) => String(e).trim().toLowerCase()));
  const asked = String(body._to || '').trim().toLowerCase();
  const to = (asked && known.has(asked) ? asked : '') || routed || st.contactEmail;
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
app.get('/admin', requireAuth, (req, res) => {
  sweepExpired();
  const content = contentStats();
  const broken = brokenLinks();
  const soon = [];
  const in14 = Date.now() + 14 * 24 * 60 * 60 * 1000;
  allCollections().forEach(([label, arr]) => (arr || []).forEach((item) => {
    if (!item || item.archived || !item.expiry) return;
    const t = new Date(item.expiry).getTime();
    if (!Number.isNaN(t) && t > Date.now() && t < in14) soon.push({ label, title: plain(item.title || item.name || item.label) || 'Untitled', on: item.expiry });
  }));
  res.render('admin/dashboard.njk', {
    ...adminCtx(null), saved: req.query.saved,
    stats: analyticsSummary(),
    content,
    inboxCount: readSubmissions().filter((s) => !s.read).length,
    broken, linkScanAt: _linkReport.at, expiringSoon: soon.slice(0, 6),
    mailConfigured: !!mailer,
    capacity: CAPACITY, schemas: SCHEMAS.filter((x) => x.type === 'list'),
  });
});

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
  if (req.query.run) await checkLinks();
  const at = _linkReport.at;
  res.render('admin/links.njk', {
    ...adminCtx('links'),
    results: _linkReport.results,
    brokenCount: brokenLinks().length,
    checkedAt: at ? new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : null,
  });
});

/* Page hub — all sections of one page, in on-screen order, editable inline */
app.get('/admin/page/:pkey', requireAuth, (req, res) => {
  const page = adminPageByKey[req.params.pkey];
  if (!page) return res.status(404).send('Unknown page');
  sweepExpired();
  const sections = page.sections.map((s) => {
    const schema = schemaByKey[s.key];
    const value = store.get(schema.path);
    const arr = Array.isArray(value) ? value : [];
    return {
      schema: resolveSchema(schema),
      hint: s.hint,
      value,
      // the hub shows a short preview; the full list lives at /admin/collection
      preview: arr.slice(0, 6),
      picked: arr.filter((x) => x && x.featured).length,
      max: schema.max || null,
      live: arr.filter((x) => statusOf(x) === 'live' || statusOf(x) === 'scheduled').length,
      limit: CAPACITY[schema.key] || null,
    };
  });
  res.render('admin/page.njk', { ...adminCtx(page.key), page, sections, saved: req.query.saved });
});

/* One collection, in full: search, status filter and paging, so a list of 450
   destinations stays usable (FR-DEST-008). The page hub shows a preview and
   sends the admin here for the whole list. */
const ADMIN_PER_PAGE = 25;
app.get('/admin/collection/:key', requireAuth, (req, res) => {
  const schema = schemaByKey[req.params.key];
  if (!schema || schema.type !== 'list') return res.redirect('/admin');
  sweepExpired();
  const all = (store.get(schema.path) || []).map((item, idx) => ({ item, idx, status: statusOf(item) }));
  const q = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || 'all');
  let rows = all;
  if (status !== 'all') rows = rows.filter((r) => (status === 'live' ? r.status === 'live' || r.status === 'scheduled' : r.status === status));
  if (q) rows = rows.filter((r) => JSON.stringify(r.item).toLowerCase().includes(q));
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const pages = Math.max(1, Math.ceil(rows.length / ADMIN_PER_PAGE));
  const slice = rows.slice((Math.min(page, pages) - 1) * ADMIN_PER_PAGE, Math.min(page, pages) * ADMIN_PER_PAGE);
  const counts = {
    all: all.length,
    live: all.filter((r) => r.status === 'live' || r.status === 'scheduled').length,
    hidden: all.filter((r) => r.status === 'hidden').length,
    archived: all.filter((r) => r.status === 'archived').length,
  };
  res.render('admin/collection.njk', {
    ...adminCtx(pageOfSection[schema.key]), schema: resolveSchema(schema),
    // NB: not `pages` — that name is the sidebar's list of admin pages
    rows: slice, counts, q, status, page: Math.min(page, pages), pageCount: pages, total: rows.length,
    // the exact list the admin is looking at, so Edit/Add/actions can come back to it
    listUrl: '/admin/collection/' + schema.key + '?q=' + encodeURIComponent(q)
      + '&status=' + encodeURIComponent(status) + '&page=' + Math.min(page, pages),
    limit: CAPACITY[schema.key] || null, saved: req.query.saved,
    home: adminPageByKey[pageOfSection[schema.key]] || null,
  });
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

/* Where "Back" and "Save" return to: the list the admin came from (with its
   search and filters intact), never an arbitrary URL. */
const safeBack = (req, schema) => {
  const from = String((req.query && req.query.from) || '');
  return /^\/admin\/[A-Za-z0-9/_?=&%.-]*$/.test(from) ? from : backTo(schema.key);
};

/* list item editors */
app.get('/admin/section/:key/new', requireAuth, (req, res) => {
  const schema = schemaByKey[req.params.key];
  res.render('admin/item.njk', {
    ...adminCtx(pageOfSection[schema.key]), schema: resolveSchema(schema), item: {}, index: null, backUrl: safeBack(req, schema),
  });
});
app.get('/admin/section/:key/:idx/edit', requireAuth, (req, res) => {
  const schema = schemaByKey[req.params.key];
  const items = store.get(schema.path) || [];
  const idx = parseInt(req.params.idx, 10);
  res.render('admin/item.njk', {
    ...adminCtx(pageOfSection[schema.key]), schema: resolveSchema(schema), item: items[idx] || {}, index: idx, backUrl: safeBack(req, schema),
  });
});
app.post('/admin/section/:key/save', requireAuth, upload.any(), (req, res) => {
  const schema = schemaByKey[req.params.key];
  const items = store.get(schema.path) || [];
  const item = {};
  for (const f of schema.fields) item[f.name] = castField(f, req.body[f.name]);
  applyUploads(schema, req, item);
  // one status word from the form (FR-OTHER-005), stored as the two flags the
  // site reads, plus the optional self-archiving date (FR-OTHER-003A)
  const st = req.body._status || (req.body._published === 'on' ? 'live' : 'hidden');
  item.published = st !== 'hidden';
  item.archived = st === 'archived';
  item.expiry = (req.body._expiry || '').trim();
  if (st !== 'archived') item.autoArchived = false;
  const idx = req.body._index === '' ? null : parseInt(req.body._index, 10);
  if (idx === null || Number.isNaN(idx)) items.push(item);
  else items[idx] = { ...items[idx], ...item };
  store.set(schema.path, items);
  // back to wherever the admin came from (the full list keeps its filters)
  res.redirect(req.body._back || backTo(schema.key, true));
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
/* FR-OTHER-005 — publish / hide / archive / restore without opening the item.
   One route, one word: live, hidden or archived. */
app.post('/admin/section/:key/:idx/status', requireAuth, (req, res) => {
  const schema = schemaByKey[req.params.key];
  const items = store.get(schema.path) || [];
  const item = items[parseInt(req.params.idx, 10)];
  if (item) {
    const to = String(req.body.to || 'live');
    Object.assign(item, {
      published: to !== 'hidden',
      archived: to === 'archived',
    });
    if (to !== 'archived') delete item.autoArchived;
    store.set(schema.path, items);
  }
  res.redirect(req.body._back || backTo(schema.key));
});
/* Copying an item is the quickest way to add the next one (FR-OTHER-005 "add") */
app.post('/admin/section/:key/:idx/duplicate', requireAuth, (req, res) => {
  const schema = schemaByKey[req.params.key];
  const items = store.get(schema.path) || [];
  const i = parseInt(req.params.idx, 10);
  if (items[i]) {
    const copy = JSON.parse(JSON.stringify(items[i]));
    const t = schema.itemTitle;
    if (t && typeof copy[t] === 'string') copy[t] = copy[t] + ' (copy)';
    Object.assign(copy, { published: false, archived: false, featured: false });
    items.splice(i + 1, 0, copy);
    store.set(schema.path, items);
  }
  res.redirect(req.body._back || backTo(schema.key));
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
