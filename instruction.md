# KALASAG VPS deployment and operations runbook

This file is the handoff instruction for an AI agent operating the production VPS. It is specific to this repository, not a generic Vite deployment guide.

## 1. Target architecture

Use this production architecture unless the owner explicitly approves a different one:

```text
Browser / installed PWA
        |
        | HTTPS 443
        v
Nginx on the VPS
        |
        +-- serves the immutable Vite build from /var/www/kalasagph/current

Browser / Android APK
        |
        +-- Supabase Auth, Database, Realtime and Storage
        +-- VPS /api/live-data gateway
        |       +-- cyclone requests -> bounded loopback live hazard relay -> GDACS
        |       +-- other requests -> Supabase live-data Edge Function
        +-- Supabase news-ingest -> authenticated VPS news-source relay
        |       +-- reviewed publisher RSS/metadata endpoints only
        +-- authenticated Supabase ais-relay Edge Function
        +-- VPS address-search gateway -> Photon/OpenStreetMap
```

The VPS is primarily a static web host. Supabase remains the live backend. Do not move the database or provider credentials into the browser. Do not start Vite as a public production server.

The preferred AIS path is the authenticated Supabase Edge Function. The standalone relay in `server/ais-relay.mjs` is only an optional fallback; it restricts origins and IP usage but does not authenticate Supabase users.

Family danger notifications also require the trusted dispatcher in `server/family-alert-worker.mjs`. A database-side post-commit kick minimizes first-send latency, while this VPS worker continuously drains retries and alerts queued while a device was temporarily unreachable. Treat this worker as required production infrastructure, not an optional development relay.

## 2. Non-negotiable rules for the VPS AI

1. Never place a service-role key, database connection string, AISStream key, GFW token, TomTom key, or Supabase access token in a `VITE_*` variable, browser bundle, Nginx file, Git commit, chat response, command output, or public log.
2. `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are browser configuration. The publishable/legacy anonymous key is expected to be visible to clients; its safety depends on correct RLS. Never substitute a service-role or secret key.
3. Do not run `npm run dev`, `vite --host 0.0.0.0`, or `npm run preview` as the production service. Build with `npm run build` and serve `dist/` with Nginx.
4. Never expose TCP `5173`, `5432`, `6543`, `8788`, `8790`, or `8791` publicly. Only SSH, HTTP, and HTTPS should normally be reachable.
5. Do not run `scripts/reset-all.mjs`, `scripts/reset-db.mjs`, `scripts/reset.py`, `supabase db reset`, `migrate.cjs`, or raw files under `sql/` on production.
6. Do not run `supabase db push`, migration repair, or `--include-all` during a normal web deployment. This project has an imperative migration history and a legacy baseline outside `supabase/migrations`; database changes require a separate reviewed operation.
7. Do not disable TLS verification, JWT verification, RLS, CORS, CSP, provider caching, or rate limits to make an error disappear.
8. Use exact allowed origins. Never use `*`. An origin is only the scheme and host, for example `https://app.example.gov.ph`, without a path or trailing slash.
9. Back up every existing VPS configuration before replacing it. Build and test a new release before changing the live symlink.
10. If any required verification fails, keep the current release live, report the exact failing check, and diagnose it. Do not repeatedly hammer external providers.
11. Never print secret values while troubleshooting. Report secret names and whether they are present, not their contents.
12. Credentials previously pasted into development chats must be rotated before public launch. At minimum rotate the database password and all provider/API tokens that were disclosed.

## 3. Required inputs

Obtain these before changing the server. Do not invent placeholder values.

- `DOMAIN`: canonical public hostname, such as `kalasag.example.gov.ph`.
- Optional `WWW_DOMAIN`, only if its DNS record also points to this VPS.
- `ADMIN_EMAIL`: certificate-expiry contact.
- Source delivery method: a real repository URL and release commit, or a verified source/archive uploaded by the owner.
- Supabase project ref. This project currently uses `arkvqihazxrfdxuwzqur`.
- Supabase browser publishable/legacy anon key.
- Supabase service-role key for the protected family-alert worker. Store it only in the root-owned worker environment file; never reuse it in a `VITE_*` variable or return it to a client.
- A Supabase personal access token for CLI administration. Handle it only through a protected environment or secret manager.
- A separate 256-bit random news-relay secret shared only by the VPS relay and
  the Supabase `news-ingest` function. Never reuse `NEWS_INGEST_SECRET`.
- Current server-side provider credentials (`AISSTREAM_API_KEY`, `GFW_API_TOKEN`, and `TOMTOM_API_KEY`) only if a credential is missing or an explicitly approved rotation is being performed. A normal static deployment must not rewrite working provider secrets.
- Confirmation that DNS `A` and, if used, `AAAA` records resolve to the VPS.

If a domain is unavailable, the AI may create a temporary HTTP test deployment, but it must not call it production-ready. Trusted HTTPS is required for reliable browser geolocation, authentication redirects, PWA installation, and secure WebSockets.

## 4. Inspect the VPS before installing

Run read-only discovery first:

```bash
set -euo pipefail
cat /etc/os-release
uname -a
id
df -h
free -h
ss -lntup
systemctl --version
nginx -v 2>&1 || true
node --version 2>/dev/null || true
npm --version 2>/dev/null || true
```

This runbook assumes Ubuntu 22.04/24.04 or Debian 12 with systemd. Adapt package commands if the detected distribution differs. Node must be `22.12.0` or newer: Capacitor 8 requires Node 22+, and Vite 8 requires Node `^20.19.0` or `>=22.12.0`.

## 5. Install the operating-system prerequisites

For Ubuntu or Debian:

```bash
sudo apt update
sudo apt install -y \
  ca-certificates curl git nginx certbot python3-certbot-nginx \
  rsync ufw
```

Install a system-wide Node.js 22 LTS package from a trusted distribution source. If the OS repository does not provide a sufficiently new release, the NodeSource method is:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup_22.sh
test -s /tmp/nodesource_setup_22.sh
sudo -E bash /tmp/nodesource_setup_22.sh
sudo apt install -y nodejs
node --version
npm --version
```

Do not continue if Node is older than `22.12.0`.

Create a non-login deployment account, its dedicated group, and protected directories:

```bash
getent group kalasag >/dev/null 2>&1 || sudo groupadd --system kalasag
id -u kalasag >/dev/null 2>&1 || \
  sudo useradd --system --create-home --home-dir /opt/kalasagph \
    --gid kalasag --shell /usr/sbin/nologin kalasag
sudo usermod -a -G kalasag kalasag

sudo install -d -m 0750 -o kalasag -g kalasag /opt/kalasagph/sources
sudo install -d -m 0750 -o root -g kalasag /etc/kalasag
sudo install -d -m 0750 -o root -g www-data /var/www/kalasagph/releases
sudo install -d -m 0755 -o root -g www-data /var/www/letsencrypt
```

## 6. Put the source on the VPS

### Option A: real Git repository

Use a verified repository URL and a read-only deploy key. Verify the Git host key before the first connection. Deploy an explicit full commit SHA into a fresh source directory, not an unreviewed moving branch or an existing checkout:

```bash
export REPOSITORY_URL='<REPOSITORY_URL>'
export RELEASE_COMMIT='<FULL_COMMIT_SHA>'
test "${#RELEASE_COMMIT}" -eq 40
export SOURCE_ID="$RELEASE_COMMIT"
export SOURCE_DIR="/opt/kalasagph/sources/$SOURCE_ID"
test ! -e "$SOURCE_DIR"

sudo -u kalasag git clone "$REPOSITORY_URL" "$SOURCE_DIR"
cd "$SOURCE_DIR"
sudo -u kalasag git fetch --prune origin
sudo -u kalasag git checkout --detach "$RELEASE_COMMIT"
test "$(sudo -u kalasag git rev-parse HEAD)" = "$RELEASE_COMMIT"

sudo ln -sfn "sources/$SOURCE_ID" /opt/kalasagph/source.next
sudo mv -Tf /opt/kalasagph/source.next /opt/kalasagph/source
```

### Option B: uploaded source archive

The current development folder may arrive without usable Git history. In that case, require a SHA-256 checksum from the sender. Before extraction, list the archive and reject absolute paths or any `..` path component. Extract only into a new empty `/opt/kalasagph/sources/<CHECKSUM_PREFIX>` directory, verify that `package.json` is at its root, then atomically update the `/opt/kalasagph/source` symlink as shown above. Never merge an archive into an old source directory. Never upload local `.env`, `.env.local`, `node_modules`, `dist`, APKs, Gradle output, or editor caches as source.

Example archive checks:

```bash
export SOURCE_ARCHIVE='<UPLOADED_SOURCE_ARCHIVE.tar.gz>'
export EXPECTED_SHA256='<EXPECTED_SHA256>'
echo "$EXPECTED_SHA256  $SOURCE_ARCHIVE" | sha256sum --check --strict
if tar -tzf "$SOURCE_ARCHIVE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo 'Unsafe archive path detected' >&2
  exit 1
fi
```

After either option, verify that these files exist:

```bash
cd /opt/kalasagph/source
test -f package.json
test -f package-lock.json
test -f vite.config.ts
test -f deploy/nginx/kalasagph.conf.example
test -f supabase/config.toml
test -f supabase/functions/live-data/index.ts
test -f supabase/functions/ais-relay/index.ts
```

## 7. Create the build environment

Create a root-owned file that the `kalasag` group can read:

```bash
sudo install -m 0640 -o root -g kalasag /dev/null /etc/kalasag/app-build.env
sudoedit /etc/kalasag/app-build.env
```

Use this shape, replacing placeholders:

```dotenv
VITE_SUPABASE_URL=https://arkvqihazxrfdxuwzqur.supabase.co
VITE_SUPABASE_ANON_KEY=<SUPABASE_PUBLIC_ANON_OR_PUBLISHABLE_KEY>

# Route production clients through the VPS. Nginx sends cyclone requests to the
# bounded loopback relay and other resources to the Edge Function.
VITE_LIVE_DATA_URL=https://<DOMAIN>/api/live-data

# Leave empty to use the authenticated Supabase AIS Edge Function.
VITE_AIS_RELAY_URL=

# Public HTTPS gateway for Philippine address autocomplete.
VITE_ADDRESS_SEARCH_URL=https://<DOMAIN>/api/address-search
```

Do not add server-side provider credentials or a database URL to this file. All `VITE_*` values are embedded at build time. Changing one requires rebuilding the web release and any APK that should receive the same client configuration.

## 8. Configure Supabase production origins and secrets

The VPS does not need the raw PostgreSQL connection string to serve KALASAG. Supabase supplies platform secrets such as `SUPABASE_URL` to hosted Edge Functions. Never upload platform secret/service-role values yourself.

Create a separate server-only Edge Function secret file:

```bash
sudo install -m 0600 -o root -g root /dev/null /etc/kalasag/edge-functions.env
sudoedit /etc/kalasag/edge-functions.env
```

Contents:

```dotenv
AISSTREAM_API_KEY=<ROTATED_AISSTREAM_KEY>
GFW_API_TOKEN=<ROTATED_GFW_TOKEN>
TOMTOM_API_KEY=<ROTATED_TOMTOM_KEY>
LIVE_DATA_ALLOWED_ORIGINS=https://<DOMAIN>,https://localhost,capacitor://localhost
AIS_RELAY_ALLOWED_ORIGINS=https://<DOMAIN>,https://localhost,capacitor://localhost
NEWS_INGEST_SECRET=<SEPARATE_64_HEX_CHARACTER_RANDOM_SECRET>
```

Add `https://<WWW_DOMAIN>` only if it is genuinely served. Keep `https://localhost` and `capacitor://localhost`; installed Android clients use those origins.
Add `NEWS_RELAY_URL` and `NEWS_RELAY_SECRET` only after the authenticated relay
in section 12 passes its local and public probes. `NEWS_INGEST_SECRET` and
`NEWS_RELAY_SECRET` are separate trust boundaries and must not contain the same
value.

Use the pinned CLI version already verified for this project:

```bash
export PROJECT_REF='arkvqihazxrfdxuwzqur'
read -rsp 'Supabase access token: ' SUPABASE_ACCESS_TOKEN
echo
export SUPABASE_ACCESS_TOKEN

cd /opt/kalasagph/source
sudo -u kalasag env SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
  npx --yes supabase@2.109.1 link --project-ref "$PROJECT_REF"

sudo env SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
  npx --yes supabase@2.109.1 secrets set \
    --project-ref "$PROJECT_REF" \
    --env-file /etc/kalasag/edge-functions.env

sudo -u kalasag env SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
  npx --yes supabase@2.109.1 functions list --project-ref "$PROJECT_REF"

sudo -u kalasag env SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
  npx --yes supabase@2.109.1 secrets list --project-ref "$PROJECT_REF"

unset SUPABASE_ACCESS_TOKEN
```

Only names should be inspected in the secret listing. Never echo values.

The scheduled database job also needs three encrypted Vault entries. In the
Supabase Dashboard Vault UI, create or update these exact unique names:

- `kalasag_project_url`: `https://arkvqihazxrfdxuwzqur.supabase.co`
- `kalasag_publishable_key`: the same public anon/publishable key used by the app
- `kalasag_news_ingest_secret`: exactly the `NEWS_INGEST_SECRET` value above

Update an existing named secret instead of creating a duplicate. Confirm only
the names and timestamps in SQL Editor; never select `decrypted_secret` during
verification:

```sql
select name, updated_at
from vault.secrets
where name in (
  'kalasag_project_url',
  'kalasag_publishable_key',
  'kalasag_news_ingest_secret'
)
order by name;

select private.invoke_news_ingest() as request_id;
```

The second query must return a non-null request ID. Check the matching request
in the Supabase Edge Function logs and confirm `public.news_sources` receives a
new `last_checked_at`; a null request ID means one or more Vault entries are
missing. This database-side Vault copy is required in addition to the hosted
Edge Function secret.

The expected functions are:

- `live-data`, with gateway JWT verification enabled.
- `family-alert-dispatch`, with gateway JWT verification enabled and `FIREBASE_SERVICE_ACCOUNT_JSON` configured as a server-only secret.
- `news-ingest`, with gateway JWT verification enabled and `NEWS_INGEST_SECRET`,
  `NEWS_RELAY_URL`, and `NEWS_RELAY_SECRET` configured as server-only secrets.
- `ais-relay`, with gateway JWT verification disabled only because the function performs bounded first-WebSocket-frame user-token authentication.

Do not pass a global `--no-verify-jwt` flag. The required per-function settings are already in `supabase/config.toml`.

### Deploy Edge Functions only when needed

The hosted functions are already part of the current architecture. A static VPS deployment does not require redeploying them. Deploy only if they are missing or the reviewed release changes their code:

```bash
read -rsp 'Supabase access token: ' SUPABASE_ACCESS_TOKEN
echo
export SUPABASE_ACCESS_TOKEN

cd /opt/kalasagph/source
sudo -u kalasag env SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
  npx --yes supabase@2.109.1 functions deploy live-data family-alert-dispatch news-ingest ais-relay \
    --project-ref "$PROJECT_REF" --use-api

unset SUPABASE_ACCESS_TOKEN
```

### Database migration guardrail

Before any future database change, first link and inspect:

```bash
npx --yes supabase@2.109.1 migration list --linked
npx --yes supabase@2.109.1 db push --linked --dry-run
```

Review the output against the remote database and take a verified backup/PITR checkpoint. The current baseline schema is not fully represented in `supabase/migrations`, so do not execute the real push until the migration history has been reconciled and explicitly approved. Never use migration repair or `--include-all` blindly.

## 9. Configure Supabase Auth URLs

In Supabase Dashboard, open Authentication -> URL Configuration and set:

- Site URL: `https://<DOMAIN>`
- Exact redirect URL: `https://<DOMAIN>/auth/confirm`
- Exact redirect URL: `https://<DOMAIN>/reset-password`

Add the `WWW_DOMAIN` variants only if that hostname is supported. Do not use a broad wildcard when exact URLs work.

If using the repository email design, paste `supabase-confirmation-email.html` into the confirmation email template. It relies on `{{ .ConfirmationURL }}` and `{{ .SiteURL }}`; do not replace the confirmation URL with a raw Supabase `/auth/v1/verify` URL or a private/LAN IP.

## 10. Install dependencies, verify, and build

Run the build as the unprivileged account:

```bash
cd /opt/kalasagph/source
sudo -u kalasag npm ci

sudo -u kalasag bash -lc '
  set -euo pipefail
  set -a
  source /etc/kalasag/app-build.env
  set +a
  cd /opt/kalasagph/source
  npm run verify
  npm run security:audit
  npm run release:check
  npm run services:check
  npm run safe-grounds:check
'
```

What these checks cover:

- `verify`: lint, TypeScript/Vite production build, and the project security regression scan.
- `security:audit`: known production dependency advisories.
- `release:check`: live-data health plus AIS health and WebSocket upgrade.
- `services:check`: weather, earthquakes, heat, storms, floods, aircraft, safe grounds, traffic, GFW enrichment, and traffic tiles.
- `safe-grounds:check`: location-centered scans in multiple Philippine cities; this helps prevent location-specific hardcoding.

The AIS release check proves that the WebSocket can upgrade, but it does not prove a signed-in first-frame authentication acknowledgement or receipt of a real vessel. Verify those manually after deployment.

Do not schedule `services:check` or `safe-grounds:check` every minute. They deliberately call several external providers and can consume quotas or trigger HTTP 429 responses. Run them once per release and during deliberate diagnosis.

## 11. Publish an atomic static release

Use immutable, versioned releases so rollback does not depend on Git being present:

```bash
set -euo pipefail
export WEB_ROOT=/var/www/kalasagph
export RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
export RELEASE_DIR="$WEB_ROOT/releases/$RELEASE_ID"

test -f /opt/kalasagph/source/dist/index.html
sudo install -d -m 0750 -o root -g www-data "$RELEASE_DIR"

# Preserve the prior release's hashed chunks in the new release so an already
# open tab or installed service worker does not receive a 404 during rollout.
if [ -L "$WEB_ROOT/current" ]; then
  sudo install -d -m 0750 -o root -g www-data "$RELEASE_DIR/assets"
  sudo cp -a "$WEB_ROOT/current/assets/." "$RELEASE_DIR/assets/" 2>/dev/null || true
  sudo find -H "$WEB_ROOT/current" -maxdepth 1 -type f -name 'workbox-*.js' \
    -exec cp -a -t "$RELEASE_DIR/" {} +
fi

sudo rsync -a /opt/kalasagph/source/dist/ "$RELEASE_DIR/"
sudo chown -R root:www-data "$RELEASE_DIR"
sudo find "$RELEASE_DIR" -type d -exec chmod 0750 {} +
sudo find "$RELEASE_DIR" -type f -exec chmod 0640 {} +

if [ -L "$WEB_ROOT/current" ]; then
  readlink -f "$WEB_ROOT/current" | sudo tee /var/lib/kalasag-previous-release >/dev/null
fi

sudo ln -sfn "releases/$RELEASE_ID" "$WEB_ROOT/current.next"
sudo mv -Tf "$WEB_ROOT/current.next" "$WEB_ROOT/current"
readlink -f "$WEB_ROOT/current"
```

Do not immediately delete older releases. Keep at least two known-good versions. The publish step deliberately carries the prior hashed assets and Workbox runtime into the new release so already-open PWA clients can transition without chunk 404s.

## 12. Configure DNS, firewall, TLS, and Nginx

### Firewall

Confirm SSH key access before enabling the firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 5173/tcp
sudo ufw deny 8788/tcp
sudo ufw --force enable
sudo ufw status verbose
```

Do not disable root/password SSH until a second key-authenticated session has been tested. Use the VPS provider firewall or a reputable CDN/WAF for volumetric DDoS mitigation; Nginx and UFW cannot absorb an attack larger than the VPS network link.

If a CDN or load balancer is added, configure Nginx real-IP handling only for that provider's published proxy IP ranges. Never trust arbitrary `X-Forwarded-For`, or attackers can bypass IP limits. Without correct real-IP handling, all CDN users may share one apparent IP and rate-limit each other.

### Initial certificate

Verify DNS first:

```bash
getent ahosts '<DOMAIN>'
```

The repository Nginx template references certificate files, so obtain the initial certificate through a temporary HTTP-only configuration. Using the webroot method also allows automatic renewal without stopping Nginx.

```bash
sudo tee /etc/nginx/conf.d/kalasag-bootstrap.conf >/dev/null <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name <DOMAIN>;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        default_type text/plain;
        return 200 "KALASAG TLS bootstrap\n";
    }
}
NGINX

sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

sudo certbot certonly --webroot --webroot-path /var/www/letsencrypt \
  --domain '<DOMAIN>' \
  --email '<ADMIN_EMAIL>' \
  --agree-tos --no-eff-email
```

If `WWW_DOMAIN` is configured in DNS and will be served, include another `--domain '<WWW_DOMAIN>'` during certificate issuance.

Replace `<DOMAIN>` inside the temporary Nginx file before testing it. Do not leave a literal placeholder in an enabled configuration.

### Local live hazard relay

GDACS's bulk GeoJSON can exceed the Edge Function's bounded upstream response limit. Install the dedicated loopback relay before enabling the production Nginx configuration. It fetches at most 16 MiB, keeps a five-minute fresh cache and a 30-minute stale cache, and returns only tropical-cyclone point events inside or within 10 km of PAR.

```bash
sudo install -d -m 0755 -o root -g root /usr/local/lib/kalasag
sudo install -m 0644 -o root -g root \
  /opt/kalasagph/source/server/storm-relay.mjs \
  /usr/local/lib/kalasag/storm-relay.mjs
sudo install -m 0644 -o root -g root \
  /opt/kalasagph/source/deploy/systemd/kalasag-storm-relay.service \
  /etc/systemd/system/kalasag-storm-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now kalasag-storm-relay.service
curl -fsS 'http://127.0.0.1:8790/healthz'
curl -fsS 'http://127.0.0.1:8790/api/live-data?resource=storms'
```

The service must bind only to `127.0.0.1`. A successful empty cyclone `data` array means the source was reached and no cyclone center is currently in the monitoring zone. HTTP 503 means status cannot be confirmed; never rewrite an upstream failure into an empty list.

### Authenticated news-source relay

Some publishers reject Supabase Edge egress even though their public RSS or
metadata endpoint works from the production VPS. Install this narrow relay
before deploying `news-ingest`. It accepts only frozen source IDs, never a
caller-supplied URL, enforces HTTPS/host/content/size/time limits, and keeps a
one-minute fresh cache plus a bounded stale-if-error cache.

```bash
getent passwd kalasag-news-relay >/dev/null || \
  sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin kalasag-news-relay

export NEWS_RELAY_RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
export NEWS_RELAY_ROOT=/opt/kalasagph/news-relay
export NEWS_RELAY_RELEASE_DIR="$NEWS_RELAY_ROOT/releases/$NEWS_RELAY_RELEASE_ID"
sudo install -d -m 0755 -o root -g root \
  "$NEWS_RELAY_RELEASE_DIR/server" \
  "$NEWS_RELAY_RELEASE_DIR/supabase/functions/_shared"
sudo install -m 0644 -o root -g root \
  /opt/kalasagph/source/server/news-source-relay.mjs \
  "$NEWS_RELAY_RELEASE_DIR/server/news-source-relay.mjs"
sudo install -m 0644 -o root -g root \
  /opt/kalasagph/source/supabase/functions/_shared/news-normalization.js \
  "$NEWS_RELAY_RELEASE_DIR/supabase/functions/_shared/news-normalization.js"
if [ -L "$NEWS_RELAY_ROOT/current" ]; then
  readlink -f "$NEWS_RELAY_ROOT/current" | \
    sudo tee /var/lib/kalasag-previous-news-relay >/dev/null
fi
sudo ln -sfn "releases/$NEWS_RELAY_RELEASE_ID" "$NEWS_RELAY_ROOT/current.next"
sudo mv -Tf "$NEWS_RELAY_ROOT/current.next" "$NEWS_RELAY_ROOT/current"

sudo install -d -m 0750 -o root -g kalasag /etc/kalasag
sudo install -m 0644 -o root -g root \
  /opt/kalasagph/source/deploy/systemd/kalasag-news-source-relay.service \
  /etc/systemd/system/kalasag-news-source-relay.service
sudo install -m 0600 -o root -g root /dev/null /etc/kalasag/news-source-relay.env
sudoedit /etc/kalasag/news-source-relay.env
```

Use this exact shape with a newly generated 64-character hexadecimal secret:

```dotenv
NEWS_RELAY_SECRET=<64_HEX_CHARACTER_RANDOM_SECRET>
```

Put the same value in `/etc/kalasag/edge-functions.env` as
`NEWS_RELAY_SECRET`, and set
`NEWS_RELAY_URL=https://<DOMAIN>/internal/news-source`. Do not place either
value in a `VITE_*` variable. Do not upload these two hosted secrets until the
relay and final HTTPS location are ready. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kalasag-news-source-relay.service
sudo systemctl status kalasag-news-source-relay.service --no-pager
curl --retry 10 --retry-all-errors --retry-delay 2 -fsS \
  http://127.0.0.1:8791/healthz
```

The readiness endpoint returns HTTP 503 until every relay-first source has
completed at least one usable fetch. Do not continue merely because the systemd
process is running.

After the final HTTPS Nginx configuration is active, an unauthenticated public
probe must return `401`; do not print the secret while testing:

```bash
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  'https://<DOMAIN>/internal/news-source?source=gma-news')" = 401
sudo bash -lc '
  set -a
  . /etc/kalasag/news-source-relay.env
  set +a
  for source in gma-news abs-cbn-news daily-tribune inquirer-newsinfo manila-standard; do
    curl --retry 3 --retry-all-errors --retry-delay 2 -fsS \
      -H "X-Kalasag-News-Relay-Secret: $NEWS_RELAY_SECRET" \
      "https://<DOMAIN>/internal/news-source?source=$source" >/dev/null
  done
'
```

Now upload the two relay settings to the hosted Edge Function environment. A
secret update does not require rebuilding the website or APK:

```bash
read -rsp 'Supabase access token: ' SUPABASE_ACCESS_TOKEN
echo
export SUPABASE_ACCESS_TOKEN
cd /opt/kalasagph/source
sudo env SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" \
  npx --yes supabase@2.109.1 secrets set \
    --project-ref arkvqihazxrfdxuwzqur \
    --env-file /etc/kalasag/edge-functions.env
unset SUPABASE_ACCESS_TOKEN
```

Finally invoke the real Edge ingestion path, not just the relay in isolation:

```bash
sudo bash -lc '
  set -euo pipefail
  set -a
  . /etc/kalasag/app-build.env
  . /etc/kalasag/edge-functions.env
  set +a
  curl --fail-with-body -sS -X POST \
    -H "apikey: $VITE_SUPABASE_ANON_KEY" \
    -H "Authorization: Bearer $VITE_SUPABASE_ANON_KEY" \
    -H "X-Kalasag-Ingest-Secret: $NEWS_INGEST_SECRET" \
    "${VITE_SUPABASE_URL%/}/functions/v1/news-ingest"
'
```

Require successful results for all five configured publishers, then confirm
fresh `last_checked_at` and `last_success_at` timestamps in
`public.news_sources`. A relay-only 200 is not sufficient for activation.

Never add this relay location to the plaintext HTTP/IP bootstrap configuration,
and never turn it into a general-purpose proxy to bypass publisher controls.

### Trusted family-alert dispatcher

Install the worker and its locked-down systemd unit. The environment file contains a service-role credential and must never be copied into the website build or made readable by the web server.

```bash
sudo install -d -m 0750 -o root -g kalasag /etc/kalasag
sudo install -m 0644 -o root -g root \
  /opt/kalasagph/source/deploy/systemd/kalasag-family-alert-worker.service \
  /etc/systemd/system/kalasag-family-alert-worker.service

sudo install -m 0600 -o root -g root /dev/null /etc/kalasag/family-alert-worker.env
sudoedit /etc/kalasag/family-alert-worker.env
```

Use this exact shape, replacing the secret value without printing it in the terminal history:

```dotenv
SUPABASE_URL=https://arkvqihazxrfdxuwzqur.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY>
FAMILY_ALERT_DISPATCH_INTERVAL_MS=3000
FAMILY_ALERT_DISPATCH_BATCH_SIZE=50
```

Then enable it and confirm the first dispatch succeeds:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kalasag-family-alert-worker.service
sudo systemctl status kalasag-family-alert-worker.service --no-pager
sudo journalctl -u kalasag-family-alert-worker.service -n 50 --no-pager
```

Do not substitute the public anon/publishable key. The worker needs `service_role` only to claim private queued deliveries; the Edge Function never returns recipient tokens or queue payloads. If this service is stopped, the database post-commit kick may still deliver a first attempt, but delayed retries are no longer guaranteed to be drained.

### Nginx configuration

Copy the project template and preserve any existing live configuration first:

```bash
sudo test ! -f /etc/nginx/conf.d/kalasagph.conf || \
  sudo cp -a /etc/nginx/conf.d/kalasagph.conf \
    "/etc/nginx/conf.d/kalasagph.conf.backup.$(date -u +%Y%m%dT%H%M%SZ)"

sudo cp /opt/kalasagph/source/deploy/nginx/kalasagph.conf.example \
  /etc/nginx/conf.d/kalasagph.conf
sudoedit /etc/nginx/conf.d/kalasagph.conf
```

Make all of these changes:

1. Replace every `example.gov.ph` with the literal canonical domain.
2. Set `root /var/www/kalasagph/current;`.
3. Use the real Certbot certificate paths.
4. Replace the template's HTTP server with a webroot-aware canonical redirect. This location must remain so Certbot can renew without downtime:

   ```nginx
   server {
       listen 80;
       listen [::]:80;
       server_name <DOMAIN>;

       location ^~ /.well-known/acme-challenge/ {
           root /var/www/letsencrypt;
       }

       location / {
           return 301 https://<DOMAIN>$request_uri;
       }
   }
   ```

   Use the literal canonical domain rather than an untrusted `$host` value. Remove `/etc/nginx/conf.d/kalasag-bootstrap.conf` after this final server is enabled.
5. Change Permissions Policy to explicitly allow client GPS:

   ```nginx
   add_header Permissions-Policy "geolocation=(self), camera=(), microphone=(), payment=(), usb=()" always;
   ```

6. Keep the existing Supabase, map-tile, CSP, HSTS, connection-limit, hidden-file, and source-file protections. Do not relax CSP to `*` or add `unsafe-eval`. With the default Supabase AIS relay, remove `wss://$host` from the Nginx CSP. If the optional same-host relay is deliberately enabled, replace it with the literal `wss://<DOMAIN>`.
7. Add a sanitized access log format in Nginx's `http` context. It must omit `$request`, `$args`, and `$http_referer` so email confirmation tokens are not stored in logs:

   ```nginx
   log_format kalasag_noargs
     '$remote_addr [$time_local] '
     '"$request_method $uri $server_protocol" $status $body_bytes_sent '
     '"$http_user_agent"';
   ```

   In the HTTPS server:

   ```nginx
   access_log /var/log/nginx/kalasag.access.log kalasag_noargs;
   error_log /var/log/nginx/kalasag.error.log warn;
   ```

8. Enable compression in the HTTPS server:

   ```nginx
   gzip on;
   gzip_vary on;
   gzip_min_length 1024;
   gzip_types text/plain text/css application/javascript application/json application/manifest+json image/svg+xml;
   ```

9. Do not long-cache the application shell or service worker. Hashed assets may be cached for one year. Add these exact locations before the general `location /` block:

   ```nginx
   location = /index.html {
       try_files $uri =404;
       expires -1;
   }

   location = /sw.js {
       try_files $uri =404;
       expires -1;
   }

   location = /manifest.webmanifest {
       default_type application/manifest+json;
       try_files $uri =404;
       expires -1;
   }
   ```

10. Add default HTTP and HTTPS servers that return `444` for unknown hostnames. For the HTTPS default server, a certificate is still required; the canonical certificate may be reused. This prevents serving the application for arbitrary Host headers:

   ```nginx
   server {
       listen 80 default_server;
       listen [::]:80 default_server;
       server_name _;
       return 444;
   }

   server {
       listen 443 ssl default_server;
       listen [::]:443 ssl default_server;
       server_name _;
       ssl_certificate /etc/letsencrypt/live/<DOMAIN>/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/<DOMAIN>/privkey.pem;
       return 444;
   }
   ```
11. If every subdomain is not permanently HTTPS, initially use a short HSTS value such as `max-age=86400` without `includeSubDomains`. Increase it only after validation.
12. Remove the default Nginx site if it conflicts:

   ```bash
   sudo rm -f /etc/nginx/sites-enabled/default
   sudo rm -f /etc/nginx/conf.d/kalasag-bootstrap.conf
   ```

Validate before reload:

```bash
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
sudo systemctl status nginx --no-pager
sudo certbot renew --dry-run
```

## 13. Post-deployment verification

### Server checks

```bash
sudo nginx -t
sudo ss -lntup
curl -fsSI 'https://<DOMAIN>/'
curl -fsSI 'https://<DOMAIN>/index.html'
curl -fsSI 'https://<DOMAIN>/sw.js'
curl -fsSI 'https://<DOMAIN>/manifest.webmanifest'
curl -fsS 'https://<DOMAIN>/auth/confirm' >/dev/null
curl -fsS 'https://<DOMAIN>/reset-password' >/dev/null
```

Expected results:

- HTTP redirects to the canonical HTTPS hostname.
- TLS is trusted and hostname-valid.
- `/`, `/auth/confirm`, `/reset-password`, and `/app` return the SPA rather than Nginx 404.
- `index.html`, `sw.js`, and `manifest.webmanifest` require revalidation.
- Hashed files under `/assets/` have a one-year cache lifetime.
- The manifest is served as `application/manifest+json`.
- HSTS, CSP, `nosniff`, frame denial, referrer, and geolocation policies are present.
- Only intended public ports are listening.

Re-run the repository checks with the production environment after DNS and TLS are live:

```bash
sudo -u kalasag bash -lc '
  set -euo pipefail
  set -a
  source /etc/kalasag/app-build.env
  set +a
  cd /opt/kalasagph/source
  npm run release:check
  npm run services:check
  npm run safe-grounds:check
'
```

### Manual browser/mobile checks

These require a real client device; the VPS cannot supply a user's GPS position.

1. Create/sign into an account and verify `/app` opens.
2. Confirm the email link returns to `https://<DOMAIN>/auth/confirm` and does not expose a LAN address or Supabase port.
3. Grant browser location permission and confirm the map pin matches that device's location.
4. Run Find Safe Ground from at least two geographically different devices/locations. Results must be centered on each user's GPS coordinates, not the VPS IP and not a hardcoded city.
5. Verify safe-ground scanning expands through the supported 5 km, 10 km, and 20 km radii and selects nearby eligible locations.
6. Verify earthquakes, heat, storms, floods, road traffic, aircraft, and vessels populate without a stale global failure banner.
7. Sign in before testing vessels. Confirm the AIS socket receives its authenticated acknowledgement and then real live vessel messages.
8. Zoom the map through its supported range and confirm the base map does not disappear.
9. Confirm direct refreshes on `/app`, `/auth/confirm`, and `/reset-password` do not return 404.
10. Test PWA installation and an update from one release to the next.

Do not claim the release complete based only on `curl`; GPS permission, authenticated AIS data, map rendering, and PWA behavior need a browser/device check.

## 14. Update procedure

1. Record the current release:

   ```bash
   readlink -f /var/www/kalasagph/current
   ```

2. Fetch and check out an explicit reviewed commit, or verify the uploaded archive checksum.
3. Run `npm ci`.
4. Export `/etc/kalasag/app-build.env` and run all checks in section 10.
5. Install a new immutable news-relay release using the versioned copy and
   symlink procedure in **Authenticated news-source relay**, even when only its
   imported normalization module changed. Restart
   `kalasag-news-source-relay.service`, wait for `/healthz` to return 200, and
   probe every configured source through HTTPS.
6. Publish a new immutable web release using section 11.
7. Run `nginx -t` before reloading any configuration.
8. Invoke `news-ingest` end to end and smoke-test the canonical HTTPS URL.
9. Keep both previous web and news-relay releases until manual verification
   completes.

Backend-only Edge Function changes take effect for web and APK clients without rebuilding them, provided the API contract remains compatible. Any React/client configuration change requires rebuilding the website. Installed APK code does not update when the VPS website changes; publish a new signed APK/AAB with a higher Android version code.

## 15. Rollback

List releases and identify a known-good previous directory:

```bash
ls -1dt /var/www/kalasagph/releases/*
readlink -f /var/www/kalasagph/current
```

Switch atomically after verifying the selected path is under `/var/www/kalasagph/releases`:

```bash
export PREVIOUS_RELEASE='<RELEASE_DIRECTORY_NAME>'
export WEB_ROOT=/var/www/kalasagph
export PREVIOUS_PATH="$(realpath -e "$WEB_ROOT/releases/$PREVIOUS_RELEASE")"
case "$PREVIOUS_PATH" in
  "$WEB_ROOT"/releases/*) ;;
  *) echo 'Refusing rollback outside the release directory' >&2; exit 1 ;;
esac
test -f "$PREVIOUS_PATH/index.html"
sudo ln -sfn "releases/$PREVIOUS_RELEASE" /var/www/kalasagph/current.next
sudo mv -Tf /var/www/kalasagph/current.next /var/www/kalasagph/current
curl -fsS 'https://<DOMAIN>/' >/dev/null
```

If the news relay or its shared normalization module also needs rollback, use
the separately recorded immutable relay path and restart the service:

```bash
export NEWS_RELAY_ROOT=/opt/kalasagph/news-relay
export PREVIOUS_NEWS_RELAY_PATH="$(cat /var/lib/kalasag-previous-news-relay)"
export PREVIOUS_NEWS_RELAY_PATH="$(realpath -e "$PREVIOUS_NEWS_RELAY_PATH")"
case "$PREVIOUS_NEWS_RELAY_PATH" in
  "$NEWS_RELAY_ROOT"/releases/*) ;;
  *) echo 'Refusing relay rollback outside the release directory' >&2; exit 1 ;;
esac
test -f "$PREVIOUS_NEWS_RELAY_PATH/server/news-source-relay.mjs"
test -f "$PREVIOUS_NEWS_RELAY_PATH/supabase/functions/_shared/news-normalization.js"
sudo ln -sfn "releases/$(basename "$PREVIOUS_NEWS_RELAY_PATH")" \
  "$NEWS_RELAY_ROOT/current.next"
sudo mv -Tf "$NEWS_RELAY_ROOT/current.next" "$NEWS_RELAY_ROOT/current"
sudo systemctl restart kalasag-news-source-relay.service
curl --retry 10 --retry-all-errors --retry-delay 2 -fsS \
  http://127.0.0.1:8791/healthz
```

A symlink-only static rollback does not normally need an Nginx reload. If Edge
Functions or database migrations changed, a static and relay rollback may still
be insufficient; use the separately reviewed backend rollback plan. Never
destructively roll back the database without a tested backup.

## 16. Optional standalone AIS relay

Do not enable this merely because a VPS exists. The current Supabase relay provides stronger user authentication. Use the standalone relay only if the owner accepts its current origin/IP-based protection or after equivalent user-token authentication is implemented.

If explicitly approved, build with:

```dotenv
VITE_AIS_RELAY_URL=wss://<DOMAIN>/ais
```

Create `/etc/kalasag/ais-relay.env` with mode `0640`, owner `root`, group `kalasag`:

```dotenv
AISSTREAM_API_KEY=<ROTATED_SERVER_ONLY_KEY>
AIS_RELAY_HOST=127.0.0.1
AIS_RELAY_PORT=8788
AIS_RELAY_ALLOWED_ORIGINS=https://<DOMAIN>
AIS_RELAY_TRUST_PROXY=1
```

`AIS_RELAY_TRUST_PROXY=1` is allowed only because the relay binds to loopback and Nginx overwrites the client-IP header.

Create `/etc/systemd/system/kalasag-ais-relay.service`:

```ini
[Unit]
Description=KALASAG AIS relay
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=kalasag
Group=kalasag
WorkingDirectory=/opt/kalasagph/source
Environment=NODE_ENV=production
EnvironmentFile=/etc/kalasag/ais-relay.env
ExecStart=/usr/bin/node --use-system-ca /opt/kalasagph/source/server/ais-relay.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LimitNOFILE=8192
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

Add both Nginx locations; the current template includes `/ais` but not the `/healthz` expected by `npm run release:check`:

```nginx
location = /ais {
    proxy_pass http://127.0.0.1:8788/ais;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
    proxy_buffering off;
}

location = /healthz {
    proxy_pass http://127.0.0.1:8788/healthz;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
}
```

Also add the literal `wss://<DOMAIN>` to Nginx CSP `connect-src`. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kalasag-ais-relay
sudo systemctl status kalasag-ais-relay --no-pager
curl -fsS http://127.0.0.1:8788/healthz
sudo nginx -t
sudo systemctl reload nginx
curl -fsS https://<DOMAIN>/healthz
```

Never expose `8788` publicly. `upstreamConnected: false` with zero subscribers is normal because this relay connects to AISStream only while a client is subscribed.

## 17. Monitoring and incident response

Minimum monitoring:

- External HTTPS uptime check for `/` every 5 minutes.
- Certificate-expiry alert.
- Disk, memory, load, and Nginx 5xx monitoring.
- Supabase function error/rate-limit monitoring from the Supabase dashboard.
- `kalasag-family-alert-worker.service` must be active; alert if it restarts repeatedly or reports dispatcher HTTP failures.
- `kalasag-news-source-relay.service` must be active; alert on repeated
  restarts, prolonged stale-cache use, or publisher HTTP failures.
- Provider quota and HTTP 429 monitoring.
- Optional standalone relay: systemd status and `/healthz`, no more frequently than necessary.

Useful commands:

```bash
sudo systemctl status nginx --no-pager
sudo systemctl status kalasag-family-alert-worker.service --no-pager
sudo systemctl status kalasag-news-source-relay.service --no-pager
sudo journalctl -u kalasag-family-alert-worker.service -n 100 --no-pager
sudo journalctl -u kalasag-news-source-relay.service -n 100 --no-pager
sudo journalctl -u nginx -n 100 --no-pager
sudo tail -n 100 /var/log/nginx/kalasag.error.log
sudo certbot certificates
df -h
free -h
```

If the optional relay is running:

```bash
sudo systemctl status kalasag-ais-relay --no-pager
sudo journalctl -u kalasag-ais-relay -n 100 --no-pager
curl -fsS http://127.0.0.1:8788/healthz
```

### Common failure map

- `403 Request origin is not allowed`: add the exact HTTPS origin to both Supabase allowlist secrets; remove paths and trailing slash; retain APK origins.
- `401` from `live-data`: verify the public Supabase key, login session, function deployment, and `live-data` JWT setting. Do not disable verification.
- `Failed to fetch`: inspect TLS, DNS, CSP, CORS, browser online state, Supabase status, and Edge Function logs.
- Road traffic HTTP `429`: stop repeated checks, respect `Retry-After`, verify Edge caching, and inspect the provider quota. Do not remove rate limiting.
- Vessel health succeeds but no vessels appear: health/upgrade alone does not validate AIS authentication or provider messages; test with a signed-in client and inspect Edge logs without logging tokens.
- GPS unavailable in browser: require trusted HTTPS, `geolocation=(self)`, user permission, and device location services. Never use VPS-IP geolocation as a replacement.
- Safe ground is far away: capture the client coordinates, confirm the request uses those coordinates, run the multi-city safe-ground check, and inspect distance/radius filtering. Never hardcode the tester's city.
- Confirmation link fails or hangs: verify Supabase Site URL/redirect URLs, TLS, SPA fallback, and that Nginx did not log or alter the token query.
- Direct route returns 404: restore `try_files $uri $uri/ /index.html` in the SPA location.
- Newly deployed PWA appears stale: verify `sw.js` and `index.html` are not long-cached, hashed assets exist, and the service worker updated. Do not delete the previous release immediately.

## 18. Known deployment-adjacent follow-ups

These are code-level decisions, not reasons to expose the dev server:

- The PWA configuration currently uses automatic update while the UI contains a user-controlled reload prompt. Because KALASAG has forms and chat, a future code pass should align this to a prompt-based update strategy so unsent work is not lost.
- Service-worker registration currently occurs inside the protected application, so first-time visitors who stay on public/auth pages may not register it.
- The web manifest starts at `/`, which is correct for the public website but differs from the Android APK, which intentionally opens the login/application flow.
- A production Android release needs its own signed APK/AAB workflow and higher version code. The debug APK is not a production distribution artifact.

Do not silently change these behaviors during a VPS deployment. Report them to the owner as separate application changes.

## 19. Definition of done

The AI may report the VPS deployment complete only when:

- The exact release source/checksum is recorded.
- `npm ci`, `npm run verify`, `npm run security:audit`, `npm run release:check`, `npm run services:check`, and `npm run safe-grounds:check` pass, or any provider outage is explicitly documented and accepted by the owner.
- Nginx serves only the production `dist` release over trusted HTTPS.
- Unknown hosts are rejected and public ports are limited to the intended set.
- The production Supabase origin allowlists and Auth redirect URLs are exact.
- No server-only secret is present in `dist`, Nginx, Git, or logs.
- Authentication, live hazard data, traffic, aircraft, authenticated AIS, GPS, safe-ground selection, direct SPA routes, map zooming, and PWA update behavior have been manually checked.
- A previous static release is retained and its rollback command is known.
- The final handoff states the domain, release ID, test results, remaining known limitations, and where operational logs are located, without revealing credentials.
