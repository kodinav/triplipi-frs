#!/usr/bin/env bash
# ============================================================
# Triplipi — one-shot VPS setup (Ubuntu 22.04 / 24.04)
# Run from the project folder:
#     sudo bash deploy/setup.sh yourdomain.com you@email.com
# It installs Node + nginx + PM2, starts the app, wires the
# domain, and turns on HTTPS. Safe to re-run.
# ============================================================
set -e

DOMAIN="${1:-}"
EMAIL="${2:-}"
APPDIR="$(cd "$(dirname "$0")/.." && pwd)"   # project root (parent of deploy/)
PORT=3000

echo "▶ Triplipi setup"
echo "  project : $APPDIR"
echo "  domain  : ${DOMAIN:-<none — IP only>}"
echo

# 1. Node 20 + nginx + pm2 ----------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "▶ Installing Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
command -v nginx >/dev/null 2>&1 || { echo "▶ Installing nginx…"; apt-get install -y nginx; }
command -v pm2   >/dev/null 2>&1 || { echo "▶ Installing PM2…";   npm install -g pm2; }

# 2. App dependencies + start -------------------------------
echo "▶ Installing app dependencies…"
cd "$APPDIR"
npm install --omit=dev

echo "▶ Starting the app with PM2…"
pm2 start ecosystem.config.js || pm2 restart triplipi
pm2 save
pm2 startup systemd -u root --hp /root | tail -n 1 | bash || true
pm2 save

# 3. nginx reverse proxy ------------------------------------
if [ -n "$DOMAIN" ]; then
  echo "▶ Configuring nginx for $DOMAIN…"
  cat > /etc/nginx/sites-available/triplipi <<NGINX
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;
    client_max_body_size 20M;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/triplipi /etc/nginx/sites-enabled/triplipi
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
fi

# 4. HTTPS (only if DNS already points here) ----------------
if [ -n "$DOMAIN" ] && [ -n "$EMAIL" ]; then
  echo "▶ Setting up HTTPS…"
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" \
    --non-interactive --agree-tos -m "$EMAIL" --redirect \
    || echo "⚠ HTTPS step skipped — make sure the domain's DNS points to this server, then re-run: certbot --nginx -d $DOMAIN -d www.$DOMAIN"
fi

echo
echo "✅ Done."
echo "   Site : http://${DOMAIN:-YOUR_SERVER_IP}"
echo "   Admin: http://${DOMAIN:-YOUR_SERVER_IP}/admin  (admin / triplipi2026 — change it!)"
echo "   Logs : pm2 logs triplipi"
