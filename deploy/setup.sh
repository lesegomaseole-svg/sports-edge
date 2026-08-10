#!/usr/bin/env bash
#
# Sports Edge — Oracle Cloud Always Free provisioning script.
#
# Idempotent: safe to re-run. First run does full setup; later runs pull
# the latest code, rebuild, re-migrate, and restart the service — this one
# script is both the installer and the redeploy mechanism.
#
# Assumes a fresh Ubuntu 22.04/24.04 LTS instance (Oracle's Always Free
# Ampere A1 or AMD Micro shapes both work fine — everything here is
# installed via each project's official apt repo, which handles
# architecture automatically). Run as root (or via sudo).
#
# Usage:
#   REPO_URL="https://github.com/you/sports-edge.git" \
#   DUCKDNS_SUBDOMAIN="your-chosen-name" \
#   DUCKDNS_TOKEN="your-duckdns-token" \
#   ./setup.sh
#
# DUCKDNS_SUBDOMAIN/DUCKDNS_TOKEN are optional — omit them and this just
# skips the DNS step, leaving Caddy on a bare-IP fallback (see Caddyfile).
#
# What this does NOT do (see ../docs/oracle-runbook.md for these):
#   - Create the Oracle account/instance, or open the VCN ingress rule —
#     only you can click those buttons.
#   - Create the free DuckDNS subdomain itself — sign up at duckdns.org,
#     pick a name, get a token, THEN pass them in above.
#   - Populate /etc/sports-edge/sports-edge.env with real secrets — this
#     script creates the file with placeholders on first run and refuses
#     to overwrite it after that, but the actual values (API keys, the
#     auth secret, Anthropic auth) are yours to fill in.
#   - Log the `claude` CLI into your Anthropic account — that's an
#     interactive login flow this script can't drive non-interactively.

set -euo pipefail

REPO_URL="${REPO_URL:-}"
DUCKDNS_SUBDOMAIN="${DUCKDNS_SUBDOMAIN:-}"
DUCKDNS_TOKEN="${DUCKDNS_TOKEN:-}"
APP_USER="sports-edge"
APP_DIR="/opt/sports-edge/app"
DATA_DIR="/opt/sports-edge/data"
ENV_DIR="/etc/sports-edge"
ENV_FILE="$ENV_DIR/sports-edge.env"
SERVICE_NAME="sports-edge"
NODE_MAJOR="22"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (or with sudo)." >&2
  exit 1
fi

echo "=== 1/9: system packages ==="
apt-get update -y
apt-get install -y curl ca-certificates gnupg sqlite3

echo "=== 2/9: Node ${NODE_MAJOR}.x (NodeSource) ==="
if ! command -v node >/dev/null 2>&1 || [ "$(node --version | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  echo "Node $(node --version) already installed, skipping."
fi

echo "=== 3/9: Claude Code CLI ==="
# The app shells out to this (see src/agents/ClaudeCodeAgent.ts) — it's a
# separate install from the app itself. Installed globally so it's on
# every user's PATH, including the systemd service's.
npm install -g @anthropic-ai/claude-code

echo "=== 4/9: app user + directories ==="
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR" "$ENV_DIR"
chown -R "$APP_USER:$APP_USER" "/opt/sports-edge" "$DATA_DIR"

echo "=== 5/9: clone or pull the repo ==="
if [ -z "$REPO_URL" ] && [ ! -d "$APP_DIR/.git" ]; then
  echo "REPO_URL is not set and $APP_DIR has no existing checkout — nothing to clone." >&2
  echo "Re-run as: REPO_URL=<your git remote> ./setup.sh" >&2
  exit 1
fi
if [ -d "$APP_DIR/.git" ]; then
  echo "Existing checkout found — pulling latest."
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
  # Re-exec from the just-pulled copy of THIS FILE (added 2026-08-10):
  # confirmed live that bash can keep running a stale in-memory read of a
  # script after `git pull` rewrites it on disk mid-execution — a run
  # correctly pulled a fix to this exact file, but then executed the OLD
  # pre-fix logic for everything after this point anyway, because bash had
  # already buffered that part of the file before the pull changed it.
  # SPORTS_EDGE_REEXECED guards against looping forever: the re-exec'd
  # process hits this same block again (pull is now a fast no-op), and
  # without the guard would just re-exec itself indefinitely.
  if [ -z "${SPORTS_EDGE_REEXECED:-}" ]; then
    exec env SPORTS_EDGE_REEXECED=1 "$APP_DIR/deploy/setup.sh"
  fi
else
  sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR"
fi

echo "=== 6/9: install deps, build, migrate ==="
cd "$APP_DIR"
sudo -u "$APP_USER" npm install
sudo -u "$APP_USER" npm run build

# DATABASE_URL points at the persistent data dir, OUTSIDE the git-managed
# app dir — a `git pull` on redeploy never touches the actual database.
# Set here (not just in the env file) so `prisma migrate deploy` uses the
# same path the running service will.
export DATABASE_URL="file:$DATA_DIR/prod.db"
sudo -u "$APP_USER" env DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy

# Seed the sport/league catalog — but ONLY on a genuinely empty DB, not on
# every run. seed.ts upserts every Sport's `active` flag and every
# TrackedMarket's `enabled` flag back to its hardcoded defaults each time
# it runs (see its own comment on the else-branch) — fine on a fresh DB,
# but running it unconditionally on every redeploy would silently overwrite
# whatever you've since toggled by hand in the Market Manager UI. Migrations
# alone don't populate this data, so skipping this step entirely (the
# original bug) leaves Market Manager empty on first boot.
SPORT_COUNT=$(sqlite3 "$DATA_DIR/prod.db" "SELECT COUNT(*) FROM Sport;" 2>/dev/null || echo 0)
if [ "$SPORT_COUNT" = "0" ]; then
  echo "Sport catalog is empty — seeding for the first time."
  sudo -u "$APP_USER" env DATABASE_URL="$DATABASE_URL" npm run seed
else
  echo "Sport catalog already has $SPORT_COUNT entries — skipping seed (won't overwrite Market Manager toggles)."
fi

echo "=== 7/9: env file (secrets — placeholders only, won't overwrite) ==="
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" << 'ENVEOF'
# Sports Edge — production environment. Fill in every REPLACE_ME below.
# See ../docs/oracle-runbook.md for what each one is and where to get it.
# This file is NOT part of the git repo and a redeploy (git pull) never
# touches it.

PORT=3000
DATABASE_URL=file:/opt/sports-edge/data/prod.db

# Shared-secret auth gate (src/api/authMiddleware.ts) — REQUIRED before
# exposing this to the internet. Any password works with any username in
# the browser's Basic Auth prompt; only this value is actually checked.
AUTH_SHARED_SECRET=REPLACE_ME

# Rotated key (see the 2026-08 audit — the old one was exposed in this
# machine's local session transcripts and is being rotated separately).
THE_ODDS_API_KEY=REPLACE_ME
ODDS_PROVIDER=the-odds-api
ODDS_REGIONS=uk

NEWSAPI_KEY=REPLACE_ME
SPORTMONKS_API_KEY=REPLACE_ME
FOOTBALL_DATA_API_KEY=REPLACE_ME
OPENWEATHERMAP_API_KEY=REPLACE_ME

# Real analysis calls routinely take longer than the CLI's 180s default —
# confirmed live during this deployment's own testing (3 of 4 real picks
# timed out at the default). 420000 (7min) held up in practice.
CLAUDE_CODE_TIMEOUT_MS=420000

# Poll intervals — see each scheduler file's own header comment for why
# these particular defaults. Uncomment to override.
# FIXTURE_POLL_INTERVAL_HOURS=24
# NEWS_POLL_INTERVAL_MINUTES=15
# RESULTS_POLL_INTERVAL_HOURS=24
# CLV_POLL_INTERVAL_MINUTES=30
ENVEOF
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo ">>> Created $ENV_FILE with placeholders — edit it before starting the service (see runbook)."
else
  echo "$ENV_FILE already exists, leaving it alone."
fi

echo "=== 8/9: DuckDNS (free subdomain -> this instance's public IP) ==="
if [ -n "$DUCKDNS_SUBDOMAIN" ] && [ -n "$DUCKDNS_TOKEN" ]; then
  mkdir -p /opt/duckdns
  cat > /opt/duckdns/update.sh << DUCKEOF
#!/usr/bin/env bash
# ip= left blank on purpose — DuckDNS uses the requesting connection's own
# address, so this always points at wherever this script actually runs
# from, no manual IP lookup needed.
curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=" -o /var/log/duckdns.log
DUCKEOF
  chmod +x /opt/duckdns/update.sh
  /opt/duckdns/update.sh
  echo "DuckDNS response: $(cat /var/log/duckdns.log)"
  # Oracle's Always Free public IP is stable across reboots in practice,
  # but not contractually guaranteed the way a Reserved/Elastic IP would
  # be — this cron is cheap insurance (one small HTTP call) against ever
  # needing to notice and fix a silently stale DNS record by hand.
  # `|| true` on the read side: a fresh instance has no crontab yet, so
  # `crontab -l` exits non-zero, and piping nothing through `grep -v` does
  # too (grep exits 1 when it selects zero lines) — both expected on a
  # first run, neither a real error. Without the guard, `set -e` (inherited
  # by this subshell from the parent script) kills the subshell right at
  # that semicolon, before the echo below ever runs, and the whole script
  # dies silently with no cron job installed and everything after this
  # point — including the systemd unit — never created.
  (crontab -l 2>/dev/null | grep -v duckdns/update.sh || true; echo "*/5 * * * * /opt/duckdns/update.sh") | crontab -
  echo ">>> DNS: ${DUCKDNS_SUBDOMAIN}.duckdns.org now points at this instance, refreshed every 5min."
else
  echo "DUCKDNS_SUBDOMAIN/DUCKDNS_TOKEN not set — skipping. Caddy will need a real domain before it can get an automatic HTTPS cert (see Caddyfile's bare-IP fallback for a no-domain smoke test)."
fi

echo "=== 9/9: systemd unit ==="
cat > "/etc/systemd/system/${SERVICE_NAME}.service" << UNITEOF
[Unit]
Description=Sports Edge
After=network.target
# Belt-and-braces on top of RestartSec: 5 crashes in 60s means something's
# structurally broken, not transient — stop instead of restart-looping
# forever and hammering whatever's failing (an API, the DB, etc).
# MUST live in [Unit], not [Service] (fixed 2026-08-10) — systemd silently
# ignores StartLimitIntervalSec/StartLimitBurst under [Service] (logs
# "Unknown key name... ignoring" and just keeps going), which meant this
# circuit breaker was never actually active despite looking configured.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${APP_DIR}/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

# "=REPLACE_ME" specifically, not bare "REPLACE_ME" (fixed 2026-08-10):
# the file's own header comment ("Fill in every REPLACE_ME below") always
# matched the old bare pattern, so this check found a "placeholder" on
# every single run regardless of whether every real key was actually
# filled in — confirmed live on a fully-configured, already-running
# deployment. That meant the restart-and-verify branch below was
# effectively dead code from the moment it was written; this is what
# actually made it reachable.
if grep -q "=REPLACE_ME" "$ENV_FILE"; then
  echo ""
  echo "=== Setup complete, but NOT starting the service yet ==="
  echo "$ENV_FILE still has REPLACE_ME placeholders. Fill in real values,"
  echo "log the claude CLI in (see runbook), then run:"
  echo "  systemctl start ${SERVICE_NAME}"
else
  systemctl restart "$SERVICE_NAME"
  # Verify the restart actually took (added 2026-08-10, after a real 23h
  # outage this masked): `systemctl restart` returning 0 only means the
  # request was accepted, not that the new process is actually up —
  # Restart=on-failure deliberately does NOT re-launch a service that
  # stopped cleanly (SIGTERM, exit 0), which is the right call for
  # respecting an intentional `systemctl stop`, but means a redeploy whose
  # restart silently failed to bring the new process up (interrupted SSH
  # session, whatever) just sits there quietly, "successfully stopped,"
  # until someone happens to notice — in this case, a full day of missed
  # ingestion/analysis/settlement before anyone looked. Sleep briefly, then
  # actually check, and fail LOUDLY (non-zero exit, real error, recent
  # logs) rather than printing a success message that isn't verified.
  sleep 3
  if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    echo ""
    echo "=== ERROR: restart did not bring ${SERVICE_NAME} up ==="
    echo "systemctl status ${SERVICE_NAME}:"
    systemctl status "$SERVICE_NAME" --no-pager -l || true
    echo ""
    echo "Recent logs:"
    journalctl -u "$SERVICE_NAME" --no-pager -n 30 || true
    exit 1
  fi
  echo ""
  echo "=== Setup complete, service (re)started and confirmed active ==="
  echo "systemctl status ${SERVICE_NAME}"
fi
