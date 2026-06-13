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
  noCache: !PROD,          // cache templates in production
});
app.set('view engine', 'njk');

app.use(express.urlencoded({ extended: true }));

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
    ] },
  { key: 'nav', group: 'Global', label: 'Header navigation links', type: 'list', path: 'settings.navLinks',
    itemTitle: 'label',
    fields: [
      { name: 'label', label: 'Label', ph: 'e.g. Packages' },
      { name: 'href', label: 'Link', type: 'url', ph: 'e.g. packages.html or https://…' },
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
      { name: 'image', label: 'Image', type: 'image' },
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
      { name: 'href', label: 'Link', type: 'url', ph: 'e.g. packages.html or https://…' },
      { name: 'external', label: 'External partner link?', type: 'bool' },
      { name: 'extProvider', label: 'Partner name (if external)', ph: 'e.g. HimalayanRail' },
      { name: 'extUrl', label: 'Partner URL (if external)', type: 'url', ph: 'https://partner-website.com' },
    ] },
  { key: 'packages', group: 'Content', label: 'Package cards', type: 'list', path: 'packages',
    itemTitle: 'title',
    fields: [
      { name: 'title', label: 'Title', ph: 'e.g. Stargazing in Spiti' },
      { name: 'region', label: 'Region · duration', ph: 'e.g. Himachal · 7 days' },
      { name: 'description', label: 'Description', type: 'textarea', richInline: true, ph: 'e.g. Kaza, Key Monastery, Chandratal lakes. All meals included.' },
      { name: 'image', label: 'Image', type: 'image' },
      { name: 'badgeLabel', label: 'Badge', ph: 'Sponsored, Affiliate, Quote Only — or leave blank' },
      { name: 'badgeClass', label: 'Badge style', ph: 'tag-gold, tag-affiliate — or leave blank' },
      { name: 'metaSpans', label: 'Meta chips (comma-separated)', type: 'csv', ph: 'e.g. 🏔 Premium, ⭐ 4.9, 🛏 6 nights' },
      { name: 'price', label: 'Price', ph: 'e.g. ₹42,500 — or On request' },
      { name: 'priceUnit', label: 'Price unit', ph: 'e.g. / person — leave blank for on-request' },
      { name: 'ctaLabel', label: 'Button label', ph: 'e.g. Details, Book now' },
      { name: 'ctaHref', label: 'Button link', type: 'url', ph: 'e.g. package-detail.html' },
      { name: 'ctaExternal', label: 'External partner link?', type: 'bool' },
      { name: 'ctaProvider', label: 'Partner name (if external)', ph: 'e.g. KeralaLuxe' },
      { name: 'ctaUrl', label: 'Partner URL (if external)', type: 'url', ph: 'https://partner-website.com' },
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
      { name: 'name', label: 'Name', ph: 'e.g. Ladakh' },
      { name: 'region', label: 'Region line', ph: 'e.g. North · India' },
      { name: 'image', label: 'Thumbnail', type: 'image' },
      { name: 'href', label: 'Link', type: 'url', ph: 'e.g. packages.html or https://…' },
    ] },


  { key: 'destCategories', label: 'Filter categories', type: 'list', path: 'destCategories',
    itemTitle: 'label',
    fields: [
      { name: 'label', label: 'Label shown on the pill', ph: 'e.g. Mountains & Hills' },
      { name: 'slug', label: 'Slug (used to tag destinations)', ph: 'lowercase-with-dashes, e.g. mountains-hills' },
    ] },

  { key: 'galleryCategories', label: 'Gallery categories', type: 'list', path: 'galleryCategories',
    itemTitle: 'label',
    fields: [
      { name: 'label', label: 'Label shown on the filter chip', ph: 'e.g. Mountains' },
      { name: 'slug', label: 'Slug (used to tag gallery items)', ph: 'lowercase-with-dashes, e.g. mountains' },
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

  /* ----- Homepage pickers — choose which master items are featured ----- */
  { key: 'pick-destinations', label: 'Pick destinations for the homepage', type: 'picker',
    path: 'destinations', itemTitle: 'name' },
  { key: 'pick-announcements', label: 'Pick announcements for the homepage', type: 'picker',
    path: 'announcements', itemTitle: 'title' },
  { key: 'pick-blogPosts', label: 'Pick blog posts for the homepage', type: 'picker',
    path: 'blog.posts', itemTitle: 'title' },
  { key: 'pick-packages', label: 'Pick packages for the homepage', type: 'picker',
    path: 'packages', itemTitle: 'title' },

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
      { key: 'ask', hint: 'The cream contact block near the bottom.' },
    ] },
  { key: 'destinations', label: 'Destinations', view: '/destinations',
    intro: 'The destinations index page.',
    sections: [
      { key: 'page-destinations', hint: 'Big title and intro at the top of the page.' },
      { key: 'destinations', hint: 'The master list of destinations. Order here = order everywhere. Tick "homepage" in the Homepage tab to feature one.' },
      { key: 'destCategories', hint: 'The filter pills above the grid. Counts are automatic — tag each destination with category slugs.' },
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
  { key: 'picks', label: 'Our Picks', view: '/picks',
    intro: 'The ranked list — rank numbers are automatic from the order here.',
    sections: [
      { key: 'page-picks', hint: 'Big title and intro at the top of the page.' },
      { key: 'picks', hint: 'The ranked rows, in order.' },
    ] },
  { key: 'about', label: 'About', view: '/about',
    intro: 'Title and intro of the About page.',
    sections: [{ key: 'page-about', hint: 'Big title and intro at the top of the page.' }] },
  { key: 'contact', label: 'Contact', view: '/contact',
    intro: 'Title and intro of the Contact page.',
    sections: [{ key: 'page-contact', hint: 'Big title and intro at the top of the page.' }] },
  { key: 'sponsor', label: 'Sponsored', view: '/gallery',
    intro: 'Sponsored banners shown mid-grid on the pages you choose. Each has a Call button. All targeted items appear, spread through the grid.',
    sections: [
      { key: 'sponsored', hint: 'Every item that targets a page is shown, spaced through the grid. Items without a title stay hidden (drafts).' },
    ] },
  { key: 'legal', label: 'Legal Pages', view: '/legal',
    intro: 'The legal documents shown at /legal and linked in the footer "Legal" column. Edit each one’s full content here.',
    sections: [
      { key: 'legalDocs', hint: 'Each document’s heading, intro and full body. “Show in footer” controls the footer Legal column; reorder to set the footer + sidebar order.' },
    ] },
  { key: 'site', label: 'Site Settings', view: '/', isSettings: true,
    intro: 'Brand, header navigation, footer and admin security.',
    sections: [
      { key: 'settings', hint: 'Brand name, header button, contact email, copyright.' },
      { key: 'nav', hint: 'The links in the header bar (and their order).' },
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
  res.render('partials.js.njk', { settings: store.get('settings'), legalDocs: store.get('legalDocs') || [] });
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

/* Clean URLs: /page is canonical; legacy /page.html 301-redirects to it */
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    const clean = req.path.slice(0, -5);
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return res.redirect(301, (clean === '/index' ? '/' : clean) + qs);
  }
  next();
});

const PAGES = {
  index: (req) => ({
    settings: c().settings,
    home: c().home,
    destinations: c().destinations.filter((d) => d.featured),
    highlights: c().highlights,
    announcements: c().announcements.filter((a) => a.featured),
    blogPosts: c().blog.posts.filter((p) => p.featured),
    packages: c().packages.filter((p) => p.featured),
  }),
  destinations: (req) => {
    const all = c().destinations;
    const categories = (c().destCategories || []).map((cat) => ({
      ...cat,
      count: all.filter((d) => (d.categories || []).includes(cat.slug)).length,
    }));
    const { items, pagination } = paginate(all, req);
    return { page: c().pages.destinations, cards: items, categories, pagination, baseUrl: '/destinations', sponsorSlots: sponsorSlots('destinations', items.length) };
  },
  packages: (req) => {
    const { items, pagination } = paginate(c().packages, req);
    return { page: c().pages.packages, packages: items, pagination, baseUrl: '/packages', sponsorSlots: sponsorSlots('packages', items.length) };
  },
  blog: (req) => {
    const { items, pagination } = paginate(c().blog.posts, req);
    return { page: c().pages.blog, blog: { ...c().blog, posts: items }, pagination, baseUrl: '/blog', sponsorSlots: sponsorSlots('blog', items.length) };
  },
  announcements: (req) => {
    const { items, pagination } = paginate(c().announcements, req);
    return { page: c().pages.announcements, announcements: items, pagination, baseUrl: '/announcements' };
  },
  gallery: (req) => {
    const all = c().galleryItems;
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
    const { items, pagination } = paginate(c().picks, req);
    return { page: c().pages.picks, picks: items, pagination, baseUrl: '/picks' };
  },
  about: () => ({ page: c().pages.about }),
  contact: () => ({ page: c().pages.contact, settings: c().settings }),
  legal: (req) => {
    const docs = c().legalDocs || [];
    const slug = (req && req.query && req.query.p) || 'privacy';
    const doc = docs.find((d) => d.slug === slug) || docs[0];
    return { legalDocs: docs, doc };
  },
  /* static passthroughs (templated copies, no data binding yet) */
  trip: () => ({}), shop: () => ({}), search: () => ({}),
  'blog-post': () => ({}),
  'destination-detail': () => ({}), 'package-detail': () => ({}), '404': () => ({}),
};

app.get('/', (req, res) => res.render('index.njk', PAGES.index(req)));
for (const [name, data] of Object.entries(PAGES)) {
  app.get('/' + name, (req, res) => res.render(name + '.njk', data(req)));
}

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

/* Dashboard — one card per page of the site */
app.get('/admin', requireAuth, (req, res) =>
  res.render('admin/dashboard.njk', { ...adminCtx(null), saved: req.query.saved }));

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
  const idx = req.body._index === '' ? null : parseInt(req.body._index, 10);
  if (idx === null || Number.isNaN(idx)) items.push(item);
  else items[idx] = { ...items[idx], ...item };
  store.set(schema.path, items);
  res.redirect(backTo(schema.key, true));
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
