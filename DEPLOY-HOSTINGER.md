# Deploying Triplipi to Hostinger

Triplipi is a **Node.js app** (Express + an admin CMS + image uploads). It needs a
plan that runs a long-running Node process — on Hostinger that means a **VPS plan**.
Shared / Premium / Business hosting is PHP-based and cannot run this app.

This guide: VPS → Node → upload → PM2 → nginx → domain → HTTPS.

---

## ⚡ Easy path (minimal typing)

If you'd rather not run lots of commands, do this instead of sections 3–8:

1. **Point your domain** (hPanel → Domains → DNS): add two **A records** — `@` and
   `www` — both set to your **VPS IP**. (UI only, no commands.)
2. **Get the code onto the VPS** from your GitHub repo. Open hPanel →
   **VPS → Browser terminal** and paste (replace the repo URL):
   ```bash
   git clone https://github.com/YOUR_USERNAME/triplipi.git /var/www/triplipi
   ```
3. **Run the one setup script** (replace the domain + email):
   ```bash
   cd /var/www/triplipi && sudo bash deploy/setup.sh triplipi.com you@email.com
   ```
   It installs everything, starts the app, configures nginx, and turns on HTTPS.
   When it finishes, your site is live at `https://triplipi.com`.

That's the whole thing. The detailed manual steps below are only if you want to
understand or troubleshoot each part.

---

## 0. What you need
- A **Hostinger VPS** (the cheapest KVM 1 plan is plenty).
- A **domain** (e.g. triplipi.com) you can point at the VPS.
- The project folder from your computer.

---

## 1. Create the VPS
1. hPanel → **VPS → Buy / Manage**. When asked for an OS/template, pick
   **Ubuntu 22.04** (or the "Ubuntu 24.04" template). If offered a template with
   **Node.js / OpenLiteSpeed preinstalled**, plain Ubuntu is simplest — we install Node ourselves.
2. Note the VPS **IP address** and the **root password** Hostinger gives you.

## 2. Connect over SSH
From your Mac's Terminal:
```bash
ssh root@YOUR_VPS_IP
```
(enter the root password). Everything below runs on the VPS.

## 3. Install Node.js 20 + tools
```bash
apt update && apt -y upgrade
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs nginx
npm install -g pm2
node -v        # should print v20.x
```

## 4. Upload the project
**Option A — from your Mac** (run this in a LOCAL terminal, not the VPS):
```bash
cd ~/Desktop
rsync -av --exclude node_modules aetheria/ root@YOUR_VPS_IP:/var/www/triplipi/
```
**Option B — git**: push the project to a private GitHub repo, then on the VPS
`git clone <repo-url> /var/www/triplipi`.

Then on the VPS:
```bash
cd /var/www/triplipi
npm install --omit=dev
```

## 5. Start it with PM2 (auto-restart + boot on reboot)
```bash
cd /var/www/triplipi
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # run the command it prints, then:
pm2 save
```
Check it's up:
```bash
curl -I http://localhost:3000      # expect HTTP/1.1 200 OK
```

## 6. Put nginx in front (port 80 → the app)
```bash
nano /etc/nginx/sites-available/triplipi
```
Paste (replace `triplipi.com`):
```nginx
server {
    listen 80;
    server_name triplipi.com www.triplipi.com;

    client_max_body_size 20M;          # allow image/video uploads (15M cap in-app)

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
Enable + reload:
```bash
ln -s /etc/nginx/sites-available/triplipi /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

## 7. Point the domain at the VPS
In hPanel → **Domains → DNS / Nameservers** for your domain, add **A records**:
| Type | Name | Value |
|------|------|-------|
| A | @ | YOUR_VPS_IP |
| A | www | YOUR_VPS_IP |

DNS can take 15 min–2 h. Test: `http://triplipi.com` should show the site.

## 8. Add HTTPS (free, automatic)
```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d triplipi.com -d www.triplipi.com
```
Follow the prompts (enter an email, agree, choose redirect-to-HTTPS). Certbot
auto-renews. Your site is now live on `https://triplipi.com`.

---

## After it's live
- **Admin**: `https://triplipi.com/admin` — log in (`admin` / `triplipi2026`) and
  **change the password immediately** (Site Settings → Admin password).
- **Updating content**: done entirely through the admin; no redeploy needed.
- **Updating code**: re-upload (step 4), then `npm install --omit=dev && pm2 restart triplipi`.
- **Logs**: `pm2 logs triplipi`
- **Back up these two folders** (they are the whole site's state):
  - `/var/www/triplipi/server/data/`  (all content + admin login)
  - `/var/www/triplipi/assets/uploads/`  (uploaded images/videos)
  A simple backup: `tar czf triplipi-backup.tar.gz server/data assets/uploads`

## Updating the site after it's live

There are two independent kinds of update — neither rebuilds anything from scratch:

### Content (text, images, legal pages, categories, sponsored, ordering…)
Edit it in the **admin panel** at `/admin`. Changes are live instantly. Nothing to
deploy. Your content lives in `server/data/content.json` and `assets/uploads/`, which
are **git-ignored on the server** — so they are never overwritten by a code update.

### Code / design (CSS, templates, new features)
Push the change to GitHub from your computer:
```bash
git add -A && git commit -m "what changed" && git push
```
Then on the VPS (hPanel → Browser terminal) run **one line**:
```bash
cd /var/www/triplipi && bash deploy/update.sh
```
That pulls the new code, installs any new dependencies, and restarts the app —
leaving all content and uploads untouched.

---

## If you only have shared/Cloud hosting (not VPS)
This app can't run there. Two options:
1. **Upgrade to a Hostinger VPS** (recommended — keeps the admin CMS working).
2. Host the Node app elsewhere that supports Node (Render, Railway, Fly.io) and just
   point your Hostinger domain's DNS at it. Ask and I'll write that guide instead.
