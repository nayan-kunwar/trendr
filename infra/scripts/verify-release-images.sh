#!/usr/bin/env bash
# Verify the GHCR release images against the keyless cosign identity produced
# by .github/workflows/publish.yml.
#
# Usage (from /opt/trendr):
#   bash infra/scripts/verify-release-images.sh
#
# Environment:
#   ENV_FILE         production env file (default <repo>/.env.production)
#   GHCR_OWNER       image namespace (default nayan-kunwar)
#   TRENDR_TAG       release tag to verify (default: read from ENV_FILE)
#   TRENDR_REPO_SLUG GitHub owner/repo that owns publish.yml (default nayan-kunwar/trendr)
#   REQUIRE_COSIGN   1 = fail when cosign is not installed (recommended in production)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$(cd "$SCRIPT_DIR/../.." && pwd)/.env.production}"
REQUIRE_COSIGN="${REQUIRE_COSIGN:-0}"
TRENDR_REPO_SLUG="${TRENDR_REPO_SLUG:-nayan-kunwar/trendr}"

log() { printf '[verify-images] %s\n' "$*"; }
warn() { printf '[verify-images] WARN: %s\n' "$*" >&2; }
fail() {
  printf '[verify-images] ERROR: %s\n' "$*" >&2
  exit 1
}

# Read a simple KEY=value line without sourcing the file: values such as
# EMAIL_FROM=Trendr <digest@example.com> are not shell-safe.
read_env() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

TRENDR_TAG="${TRENDR_TAG:-$(read_env TRENDR_TAG)}"
GHCR_OWNER="${GHCR_OWNER:-$(read_env GHCR_OWNER)}"
GHCR_OWNER="${GHCR_OWNER:-nayan-kunwar}"
if [[ -z "$TRENDR_TAG" ]]; then
  fail "set TRENDR_TAG or provide it in $ENV_FILE"
fi

if ! command -v cosign >/dev/null 2>&1; then
  if [[ "$REQUIRE_COSIGN" == "1" ]]; then
    fail 'cosign is not installed; install it or set REQUIRE_COSIGN=0 for a documented exception'
  fi
  warn 'cosign is not installed; image signatures are NOT verified for this deployment'
  exit 0
fi

identity="^https://github.com/${TRENDR_REPO_SLUG}/.github/workflows/publish.yml@refs/(tags|heads)/.+$"
issuer='https://token.actions.githubusercontent.com'
for app in api worker web mcp; do
  image="ghcr.io/${GHCR_OWNER}/trendr-${app}:${TRENDR_TAG}"
  log "verifying $image"
  cosign verify \
    --certificate-identity-regexp "$identity" \
    --certificate-oidc-issuer "$issuer" \
    "$image" >/dev/null
done
log "all four release images are signed by ${TRENDR_REPO_SLUG}/publish.yml"
