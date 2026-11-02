#!/usr/bin/env bash
# Verify the H-1 origin-ingress policy without a Cloudflare account:
#   1. `nginx -t` accepts the production config and generated range includes.
#   2. A source inside Cloudflare's published ranges is served.
#   3. A source outside those ranges is closed (444), even when it forges
#      `CF-Connecting-IP`.
#
# Requires Docker. Safe to run locally or in CI; it creates throwaway networks
# and containers and removes them on exit.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
NGINX_IMAGE="${NGINX_IMAGE:-nginx:1.27-alpine}"
CURL_IMAGE="${CURL_IMAGE:-curlimages/curl:8.11.1}"
NET_CF="trendr-ingress-cf-$$"
NET_OUTSIDE="trendr-ingress-out-$$"
CONTAINER="trendr-ingress-nginx-$$"
CF_SUBNET="${CF_SUBNET:-173.245.48.0/24}"
CF_CLIENT="${CF_CLIENT:-173.245.48.10}"
OUTSIDE_SUBNET="${OUTSIDE_SUBNET:-198.51.100.0/24}"
TMP_DIR="$REPO_ROOT/.tmp/ingress-verify-$$"

log() { printf '[ingress] %s\n' "$*"; }
fail() {
  printf '[ingress] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NET_CF" "$NET_OUTSIDE" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v openssl >/dev/null 2>&1 || fail "openssl is required"
[[ -f "$REPO_ROOT/infra/cloudflare/nginx-real-ip.conf" ]] ||
  fail "run infra/scripts/refresh-cloudflare-ips.sh first"
[[ -f "$REPO_ROOT/infra/cloudflare/nginx-geo.conf" ]] ||
  fail "run infra/scripts/refresh-cloudflare-ips.sh first"

install -d "$TMP_DIR"

# Docker Desktop needs Windows paths; Linux accepts the POSIX path unchanged.
if command -v cygpath >/dev/null 2>&1; then
  REPO_DOCKER="$(cygpath -m "$REPO_ROOT")"
  TMP_DOCKER="$(cygpath -m "$TMP_DIR")"
else
  REPO_DOCKER="$REPO_ROOT"
  TMP_DOCKER="$TMP_DIR"
fi

log "generating a throwaway certificate"
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=localhost' \
  -keyout "$TMP_DOCKER/origin-key.pem" \
  -out "$TMP_DOCKER/origin.pem" >/dev/null 2>&1 ||
  fail "could not generate the throwaway certificate"

nginx_args=(
  --add-host api:127.0.0.1
  --add-host web:127.0.0.1
  --add-host mcp:127.0.0.1
  -v "$REPO_DOCKER/infra/nginx/trendr.conf:/etc/nginx/conf.d/default.conf:ro"
  -v "$REPO_DOCKER/infra/cloudflare:/etc/nginx/cloudflare:ro"
  -v "$TMP_DOCKER:/etc/nginx/certs:ro"
)

log "validating nginx syntax"
docker run --rm "${nginx_args[@]}" "$NGINX_IMAGE" nginx -t >/dev/null ||
  fail "nginx rejected the production config"

log "starting nginx on a Cloudflare-range network"
docker network create --subnet "$CF_SUBNET" "$NET_CF" >/dev/null
docker run -d --name "$CONTAINER" --network "$NET_CF" "${nginx_args[@]}" "$NGINX_IMAGE" >/dev/null
sleep 2

cf_nginx_ip="$(docker inspect -f "{{with index .NetworkSettings.Networks \"$NET_CF\"}}{{.IPAddress}}{{end}}" "$CONTAINER")"
[[ -n "$cf_nginx_ip" ]] || fail "could not determine the nginx container address"

body="$(docker run --rm --network "$NET_CF" --ip "$CF_CLIENT" "$CURL_IMAGE" \
  -fsS -m 5 -H 'CF-Connecting-IP: 203.0.113.9' "http://$cf_nginx_ip/healthz")" ||
  fail "a Cloudflare-range source was not served"
[[ "$body" == "ok" ]] || fail "unexpected body from the Cloudflare-range source: $body"
log "Cloudflare-range source served (200)"

docker network create --subnet "$OUTSIDE_SUBNET" "$NET_OUTSIDE" >/dev/null
docker network connect "$NET_OUTSIDE" "$CONTAINER"
outside_nginx_ip="$(docker inspect -f "{{with index .NetworkSettings.Networks \"$NET_OUTSIDE\"}}{{.IPAddress}}{{end}}" "$CONTAINER")"
[[ -n "$outside_nginx_ip" ]] || fail "could not determine the nginx address on the outside network"

if docker run --rm --network "$NET_OUTSIDE" "$CURL_IMAGE" \
  -fsS -m 5 -H 'CF-Connecting-IP: 203.0.113.9' "http://$outside_nginx_ip/healthz" >/dev/null 2>&1; then
  fail "a non-Cloudflare source reached the origin despite a forged CF-Connecting-IP"
fi
log "non-Cloudflare source closed (444) even with a forged header"

log "origin-ingress policy verified"
