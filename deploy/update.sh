#!/usr/bin/env bash
# ============================================================
# Triplipi — pull the latest code & restart (incremental deploy)
# Run on the server from the project folder:  bash deploy/update.sh
# Live content (server/data/content.json) and uploads are git-ignored,
# so they are never touched by this.
# ============================================================
set -e
cd "$(dirname "$0")/.."
echo "▶ Pulling latest code…"
git pull --ff-only
echo "▶ Installing any new dependencies…"
npm install --omit=dev
echo "▶ Restarting the app…"
pm2 restart triplipi
echo "✅ Updated. Content and uploads were left untouched."
