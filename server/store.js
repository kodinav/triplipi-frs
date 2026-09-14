/* ============================================================
   STORE — tiny JSON content store with atomic writes.
   Single source of truth: server/data/content.json
   ============================================================ */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'content.json');
const DEFAULT_FILE = path.join(__dirname, 'data', 'content.default.json');

let cache = null;

/* First run on a fresh server: seed the live file from the committed default.
   The live content.json is git-ignored, so code deploys never overwrite it. */
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
    // The Go For A Trip header tab is back (the earlier 'check-packages' migration
    // had dropped it). Put it where it was — after Destination, ahead of Check
    // Packages — unless the site already has one.
    id: 'restore-go-for-a-trip',
    run(content) {
      const nav = content.settings && content.settings.navLinks;
      if (!Array.isArray(nav)) return;
      const isTrip = (l) => l.mega === 'trip' || String(l.label || '').trim().toLowerCase() === 'go for a trip';
      if (nav.some(isTrip)) return;
      const dest = nav.findIndex((l) => l.mega === 'destinations');
      const pkgs = nav.findIndex((l) => String(l.href || '').replace(/\/+$/, '') === '/packages');
      const at = dest >= 0 ? dest + 1 : pkgs >= 0 ? pkgs : 0;
      nav.splice(at, 0, { label: 'Go For A Trip', href: '/destinations', mega: 'trip' });
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
