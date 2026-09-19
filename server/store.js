/* ============================================================
   STORE — tiny JSON content store with atomic writes.
   Single source of truth: content.json in the data folder (see paths.js)
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const FILE = path.join(DATA_DIR, 'content.json');
const DEFAULT_FILE = path.join(__dirname, 'data', 'content.default.json');

let cache = null;

/* First run on a fresh server: seed the live file from the committed default.
   The live content.json lives outside the app folder on a server, so a code
   deploy never replaces it. */
function ensureFile() {
  if (!fs.existsSync(FILE) && fs.existsSync(DEFAULT_FILE)) {
    fs.copyFileSync(DEFAULT_FILE, FILE);
  }
}

/* A code deploy can introduce a new default legal document (e.g. the compliance
   page). Existing sites already have their own content.json, so append any
   default doc whose slug they have never had — once. Slugs are remembered in
   `_seededLegal`, so a doc the admin later deletes is not resurrected. */
function mergeNewLegalDocs(content) {
  if (!fs.existsSync(DEFAULT_FILE)) return false;
  let defaults;
  try { defaults = JSON.parse(fs.readFileSync(DEFAULT_FILE, 'utf8')); } catch (e) { return false; }
  const live = Array.isArray(content.legalDocs) ? content.legalDocs : (content.legalDocs = []);
  const seeded = new Set(content._seededLegal || []);
  const have = new Set(live.map((d) => d.slug));
  let changed = false;
  (defaults.legalDocs || []).forEach((d) => {
    if (!d.slug || seeded.has(d.slug)) return;
    if (!have.has(d.slug)) { live.push(d); changed = true; }
    seeded.add(d.slug); changed = true;
  });
  if (changed) content._seededLegal = [...seeded];
  return changed;
}

/* One-time content migrations for changes a code deploy can't make by itself
   (the live content.json is never re-seeded). Each id runs once and is
   remembered in `_migrations`, so an admin's later edits are never undone. */
const MIGRATIONS = [
  {
    // Client "Travel Tips Tab" doc: the Gallery tab is renamed Travel Tips.
    id: 'travel-tips',
    run(content, defaults) {
      const nav = content.settings && Array.isArray(content.settings.navLinks) ? content.settings.navLinks : null;
      if (nav) {
        const gallery = nav.find((l) => String(l.href || '').replace(/\/+$/, '') === '/gallery');
        if (gallery) Object.assign(gallery, { label: 'Travel Tips', href: '/travel-tips', mega: 'none' });
        else if (!nav.some((l) => l.href === '/travel-tips')) {
          const at = nav.findIndex((l) => l.href === '/about');
          nav.splice(at < 0 ? nav.length : at, 0, { label: 'Travel Tips', href: '/travel-tips', mega: 'none' });
        }
      }
      content.pages = content.pages || {};
      if (!content.pages['travel-tips']) content.pages['travel-tips'] = (defaults.pages || {})['travel-tips'] || {};
      if (!Array.isArray(content.travelTips)) content.travelTips = defaults.travelTips || [];
      // Gallery remnants that would otherwise point at a page that no longer exists
      (content.aboutOffers || []).forEach((o) => {
        if (o.linkHref !== '/gallery') return;
        o.linkHref = '/blog';
        if (o.linkLabel === 'Visit the gallery') o.linkLabel = 'Read the blog';
      });
      (content.announcements || []).forEach((a) => {
        if (a.href === '/gallery' || a.section === 'gallery') a.archived = true;   // kept in admin, hidden on site
      });
    },
  },
  {
    // Header menu rebuilt to the client's order: Destination, Find Trip Deals,
    // Our Picks, Check Packages, Resources, Contact. "Go For A Trip" becomes
    // "Find Trip Deals" — no dropdown, straight to /categories (where "All
    // Destination Categories" already went) — and the five reading pages move
    // into the new Resources dropdown instead of sitting in the bar.
    id: 'resources-nav',
    run(content) {
      const nav = content.settings && content.settings.navLinks;
      if (!Array.isArray(nav)) return;
      const at = (l) => String(l.href || '').replace(/\/+$/, '');
      const trip = nav.find((l) => l.mega === 'trip' || /^go for a trip$/i.test(String(l.label || '').trim()));
      if (trip) Object.assign(trip, { label: 'Find Trip Deals', href: '/categories', mega: 'none' });
      else if (!nav.some((l) => at(l) === '/categories')) {
        const i = nav.findIndex((l) => l.mega === 'destinations');
        nav.splice(i < 0 ? 0 : i + 1, 0, { label: 'Find Trip Deals', href: '/categories', mega: 'none' });
      }
      const inResources = ['/announcements', '/travel-tips', '/gallery', '/blog', '/about'];
      const kept = nav.filter((l) => !inResources.includes(at(l)));
      if (!kept.some((l) => l.mega === 'resources')) kept.push({ label: 'Resources', href: '/travel-tips', mega: 'resources' });
      // fixed order; anything the admin added stays, in its own order, at the end
      const order = ['/destinations', '/categories', '/picks', '/packages', 'resources', '/contact'];
      const rank = (l) => {
        const i = order.indexOf(l.mega === 'resources' ? 'resources' : at(l));
        return i < 0 ? order.length : i;
      };
      kept.sort((a, b) => rank(a) - rank(b));
      content.settings.navLinks = kept;
    },
  },
  {
    // Two FAQs existed: the legal doc at /legal?p=faq and a custom page at
    // /p/faqs that duplicated it and held the footer's FAQs link. Keep the
    // legal one, show it in the footer, and retire the copy (kept in admin).
    id: 'single-faq',
    run(content) {
      const faq = (content.legalDocs || []).find((d) => d.slug === 'faq');
      if (faq) faq.inFooter = true;
      (content.customPages || []).forEach((p) => {
        if (p.slug === 'faqs') Object.assign(p, { inFooter: false, published: false });
      });
    },
  },
  {
    // Announcements gets its own tab in the bar (it was only inside Resources),
    // and the FAQ moves from the footer's Legal column into Explore.
    id: 'announcements-tab-faq-explore',
    run(content) {
      const nav = content.settings && content.settings.navLinks;
      if (Array.isArray(nav) && !nav.some((l) => String(l.href || '').replace(/\/+$/, '') === '/announcements')) {
        const at = nav.findIndex((l) => String(l.href || '').replace(/\/+$/, '') === '/packages');
        nav.splice(at < 0 ? nav.length : at + 1, 0, { label: 'Announcements', href: '/announcements', mega: 'none' });
      }
      const faq = (content.legalDocs || []).find((d) => d.slug === 'faq');
      if (faq) faq.inFooter = false;   // it is listed under Explore now
    },
  },
  {
    // These three labels were editable in Site settings but the menus ignored
    // them and printed their own text. The menus read them now, so the stored
    // values are set to what the site has been showing all along.
    id: 'menu-link-labels',
    run(content) {
      const s = content.settings || (content.settings = {});
      const m = s.megaMenus || (s.megaMenus = {});
      if (!m.destAllLabel || m.destAllLabel === 'View all categories') m.destAllLabel = 'All Destination Categories';
      if (!m.destAllHref || m.destAllHref === '/destinations') m.destAllHref = '/categories';
      if (!m.picksHeadLabel || m.picksHeadLabel === 'View all picks') m.picksHeadLabel = 'View all';
      // Leftovers from menus that no longer exist — no field edits them and no
      // template reads them.
      ['destHeadLabel', 'destHeadHref', 'tripHeadLabel', 'tripHeadHref', 'tripAllLabel', 'tripAllHref']
        .forEach((k) => { delete m[k]; });
    },
  },
];

function runMigrations(content) {
  const done = new Set(content._migrations || []);
  const pending = MIGRATIONS.filter((m) => !done.has(m.id));
  if (!pending.length) return false;
  let defaults = {};
  try { defaults = JSON.parse(fs.readFileSync(DEFAULT_FILE, 'utf8')); } catch (e) { /* run with no defaults */ }
  pending.forEach((m) => { m.run(content, defaults); done.add(m.id); });
  content._migrations = [...done];
  return true;
}

function load() {
  if (!cache) {
    ensureFile();
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const legal = mergeNewLegalDocs(cache);
    const migrated = runMigrations(cache);
    if (legal || migrated) save();
  }
  return cache;
}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE); // atomic on POSIX
}

/* dot-path helpers: get(content, 'home.hero') */
function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  const parent = keys.reduce((o, k) => (o[k] = o[k] || {}), obj);
  parent[last] = value;
}

module.exports = {
  get content() { return load(); },
  get: (dotted) => getPath(load(), dotted),
  set: (dotted, value) => { setPath(load(), dotted, value); save(); },
  save: () => save(),
};
