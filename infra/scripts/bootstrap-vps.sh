#!/usr/bin/env bash
# Idempotent VPS bootstrap for the production stack (task 10.1).
#
# Run as root on a fresh Debian/Ubuntu host:
#   sudo TRENDR_REPO=https://github.com/nayan-kunwar/trendr.git \
#        ./infra/scripts/bootstrap-vps.sh
#
# The script installs Docker, creates the deploy user and checkout, opens only
# SSH/80/443, installs the backup timer, and starts the stack when
# .env.production and the Cloudflare origin certificate are present.
#
# Optional environment:
#   DEPLOY_USER  (deploy)         unprivileged service/checkout owner
#   TRENDR_DIR   (/opt/trendr)    checkout and compose working directory
#   TRENDR_REPO  (github URL)     repository to clone
#   TRENDR_REF   (main)           branch/tag to clone
#   SSH_PORT     (22)             port allowed through ufw
#   GHCR_USER / GHCR_TOKEN        credentials for private GHCR packages
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
TRENDR_DIR="${TRENDR_DIR:-/opt/trendr}"
TRENDR_REPO="${TRENDR_REPO:-https://github.com/nayan-kunwar/trendr.git}"
TRENDR_REF="${TRENDR_REF:-main}"
SSH_PORT="${SSH_PORT:-22}"
GHCR_USER="${GHCR_USER:-$DEPLOY_USER}"
GHCR_TOKEN="${GHCR_TOKEN:-}"

COMPOSE_FILE="$TRENDR_DIR/docker-compose.prod.yml"
ENV_FILE="$TRENDR_DIR/.env.production"
CERTS_DIR="$TRENDR_DIR/infra/nginx/certs"

log() { printf '[bootstrap] %s\n' "$*"; }
warn() { printf '[bootstrap] WARN: %s\n' "$*" >&2; }
fail() {
  printf '[bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "run as root (sudo)"

# ── Base packages and Docker ────────────────────────────────────────────────
# shellcheck source=/dev/null
. /etc/os-release
case "${ID}" in
  debian | ubuntu) ;;
  *) fail "unsupported distribution: ${ID}; use Debian or Ubuntu" ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg git ufw
if ! apt-get install -y age; then
  warn "age is unavailable; client-side backup encryption will be disabled"
fi

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  log "installing Docker Engine and the Compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "${ID}" "${VERSION_CODENAME}" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

# ── Deploy user and checkout ────────────────────────────────────────────────
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  log "creating user $DEPLOY_USER"
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$TRENDR_DIR"
if [[ ! -d "$TRENDR_DIR/.git" ]]; then
  if [[ -n "$(ls -A "$TRENDR_DIR" 2>/dev/null)" ]]; then
    fail "$TRENDR_DIR is not empty and is not a git checkout"
  fi
  log "cloning $TRENDR_REPO ($TRENDR_REF)"
  sudo -u "$DEPLOY_USER" git clone --branch "$TRENDR_REF" "$TRENDR_REPO" "$TRENDR_DIR"
else
  warn "using the existing checkout at $TRENDR_DIR; deploy updates separately"
fi

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
  "$TRENDR_DIR/backups" "$CERTS_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
    "$TRENDR_DIR/.env.production.example" "$ENV_FILE"
  warn "created $ENV_FILE from the example; fill every secret before deploying"
fi

# ── Firewall ────────────────────────────────────────────────────────────────
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp" comment 'SSH'
ufw allow 80/tcp comment 'HTTP (redirect + Cloudflare origin)'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable
log "ufw enabled: SSH/${SSH_PORT}, 80, 443"

# ── Backup timer ────────────────────────────────────────────────────────────
sed -e "s|/opt/trendr|$TRENDR_DIR|g" \
  -e "s|^User=deploy$|User=$DEPLOY_USER|" \
  -e "s|^Group=deploy$|Group=$DEPLOY_USER|" \
  "$TRENDR_DIR/infra/systemd/trendr-backup.service" \
  >/etc/systemd/system/trendr-backup.service
install -m 644 "$TRENDR_DIR/infra/systemd/trendr-backup.timer" \
  /etc/systemd/system/trendr-backup.timer
systemctl daemon-reload
systemctl enable --now trendr-backup.timer
log "backup timer installed (daily 02:30 UTC)"

# ── Start when secrets and certificates are present ─────────────────────────
if [[ -f "$CERTS_DIR/origin.pem" && -f "$CERTS_DIR/origin-key.pem" ]]; then
  chown "$DEPLOY_USER:$DEPLOY_USER" "$CERTS_DIR/origin.pem" "$CERTS_DIR/origin-key.pem"
  chmod 644 "$CERTS_DIR/origin.pem"
  chmod 600 "$CERTS_DIR/origin-key.pem"
else
  warn "Cloudflare origin certificate missing in $CERTS_DIR; skipping start"
  warn "see $CERTS_DIR/README.md, then re-run this script"
  exit 0
fi

missing=()
for key in POSTGRES_PASSWORD API_PUBLIC_URL WEB_PUBLIC_URL JWT_SECRET \
  API_KEY_PEPPER UNSUBSCRIBE_SECRET METRICS_TOKEN MCP_HTTP_AUTH_TOKENS GITHUB_TOKENS; do
  value="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  [[ -n "${value//[[:space:]]/}" ]] || missing+=("$key")
done
if [[ "$(grep -E '^EMAIL_PROVIDER=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)" == "resend" ]]; then
  value="$(grep -E '^RESEND_API_KEY=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  [[ -n "${value//[[:space:]]/}" ]] || missing+=("RESEND_API_KEY")
fi
if ((${#missing[@]} > 0)); then
  warn "missing values in $ENV_FILE: ${missing[*]}"
  warn "fill them, then re-run this script to pull and start the stack"
  exit 0
fi

if [[ -n "$GHCR_TOKEN" ]]; then
  printf '%s' "$GHCR_TOKEN" |
    sudo -u "$DEPLOY_USER" docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

log "pulling images and starting the stack"
sudo -u "$DEPLOY_USER" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
sudo -u "$DEPLOY_USER" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
  up -d --wait --wait-timeout 300

log "stack is up; verify with: curl -fsS https://<host>/readyz"
