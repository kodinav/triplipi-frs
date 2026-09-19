/* ============================================================
   PATHS — where the site keeps what changes while it runs:
   content, the admin login, form messages, page views, uploads.

   Hostinger replaces the whole app folder on every deploy, so anything
   written inside it (server/data, assets/uploads) is lost on the next push.
   On a server these files therefore live in the hosting account's home
   folder, outside the app. Locally they stay in server/data as before.
   Set DATA_DIR to put them anywhere else.
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOCAL_DATA = path.join(__dirname, 'data');
const LOCAL_UPLOADS = path.join(ROOT, 'assets', 'uploads');
const RUNTIME_FILES = ['content.json', 'admin.json', 'submissions.json', 'analytics.json'];

const onServer = process.env.NODE_ENV === 'production' || process.platform === 'linux';
const wanted = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR)
  : onServer ? path.join(os.homedir(), 'triplipi-frs-data')
  : LOCAL_DATA;

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (e) {
    console.error(`data folder ${dir} is not writable (${e.message}) — falling back to ${LOCAL_DATA}`);
    return false;
  }
}

const DATA_DIR = wanted === LOCAL_DATA || writable(wanted) ? wanted : LOCAL_DATA;
const outside = DATA_DIR !== LOCAL_DATA;
const UPLOAD_DIR = outside ? path.join(DATA_DIR, 'uploads') : LOCAL_UPLOADS;
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// First boot with the new folder: bring along anything the app folder still
// holds, so switching locations never starts the site from scratch.
if (outside) {
  RUNTIME_FILES.forEach((f) => {
    const from = path.join(LOCAL_DATA, f);
    const to = path.join(DATA_DIR, f);
    if (!fs.existsSync(to) && fs.existsSync(from)) fs.copyFileSync(from, to);
  });
  if (fs.existsSync(LOCAL_UPLOADS)) {
    fs.readdirSync(LOCAL_UPLOADS).filter((f) => f !== '.gitkeep').forEach((f) => {
      const to = path.join(UPLOAD_DIR, f);
      if (!fs.existsSync(to)) fs.copyFileSync(path.join(LOCAL_UPLOADS, f), to);
    });
  }
}

module.exports = {
  DATA_DIR,
  UPLOAD_DIR,
  // shown in the admin so it is obvious whether edits survive a deploy
  storage: { dir: DATA_DIR, survivesDeploys: outside || !onServer, onServer },
};
