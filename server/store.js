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

function load() {
  if (!cache) {
    ensureFile();
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (mergeNewLegalDocs(cache)) save();
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
