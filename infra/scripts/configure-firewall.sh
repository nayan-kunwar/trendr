#!/usr/bin/env bash
# Restrict public origin ingress (80/443) to Cloudflare's edge ranges (H-1).
#
# UFW only covers the host INPUT chain. Docker publishes container ports via
# DNAT and the FORWARD chain, which bypasses UFW, so the same policy is also
# installed in the DOCKER-USER chain. A direct request to the origin IP is
# dropped even when UFW is not in the packet path.
#
# Usage:
#   sudo infra/scripts/configure-firewall.sh
#
# Reads infra/cloudflare/ips.txt and is idempotent: rules created by this
# script carry the `trendr-cloudflare` comment and are replaced on every run.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
IPS_FILE="$REPO_ROOT/infra/cloudflare/ips.txt"

log() { printf '[firewall] %s\n' "$*"; }
warn() { printf '[firewall] WARN: %s\n' "$*" >&2; }
fail() {
  printf '[firewall] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "run as root (sudo)"
[[ -s "$IPS_FILE" ]] || fail "missing $IPS_FILE; run refresh-cloudflare-ips.sh first"

mapfile -t V4 < <(grep -vE '^[[:space:]]*(#|$)' "$IPS_FILE" | grep -v ':')
mapfile -t V6 < <(grep -vE '^[[:space:]]*(#|$)' "$IPS_FILE" | grep ':')
((${#V4[@]} > 0)) || fail "no IPv4 Cloudflare ranges in $IPS_FILE"

# ── UFW (host INPUT) ────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1; then
  # Delete rules from a previous run, newest first so the numbering stays valid.
  while IFS= read -r number; do
    [[ -n "$number" ]] && ufw --force delete "$number" >/dev/null 2>&1 || true
  done < <(ufw status numbered 2>/dev/null |
    awk -F'[][]' '/# trendr-cloudflare/ { gsub(/ /, "", $2); print $2 }' |
    sort -rn)

  # Remove the pre-H-1 wide-open rules if an existing host still has them.
  ufw --force delete allow 80/tcp >/dev/null 2>&1 || true
  ufw --force delete allow 443/tcp >/dev/null 2>&1 || true

  for cidr in "${V4[@]}" "${V6[@]}"; do
    for port in 80 443; do
      ufw allow from "$cidr" to any port "$port" proto tcp comment 'trendr-cloudflare' >/dev/null
    done
  done
  ufw --force enable >/dev/null
  log "ufw: 80/443 allowed only from ${#V4[@]} IPv4 and ${#V6[@]} IPv6 Cloudflare ranges"
else
  warn "ufw is not installed; skipping host INPUT rules"
fi

# ── Docker (FORWARD, bypasses UFW) ─────────────────────────────────────────
# Scope every rule to the WAN interface. Without it, `--dports 80,443` would
# also match outbound container HTTP/HTTPS, whose input interface is the Docker
# bridge. Set WAN_IFACE when the host has multiple uplinks.
WAN_IFACE="${WAN_IFACE:-}"
if [[ -z "$WAN_IFACE" ]] && command -v ip >/dev/null 2>&1; then
  WAN_IFACE="$(ip -4 route show default 2>/dev/null | awk '/^default/ {print $5; exit}')"
fi

apply_docker_chain() {
  local ipt="$1"
  shift
  local -a ranges=("$@")

  if ! "$ipt" -S DOCKER-USER >/dev/null 2>&1; then
    # Docker normally creates this chain at daemon start. Create it and the
    # FORWARD jump defensively so the policy is not silently skipped.
    "$ipt" -N DOCKER-USER 2>/dev/null || true
  fi
  if ! "$ipt" -S DOCKER-USER >/dev/null 2>&1; then
    warn "$ipt: DOCKER-USER is unavailable; Docker traffic is not filtered"
    return 0
  fi
  if ! "$ipt" -C FORWARD -j DOCKER-USER >/dev/null 2>&1; then
    "$ipt" -I FORWARD 1 -j DOCKER-USER
  fi

  "$ipt" -N TRENDR-INGRESS 2>/dev/null || true
  "$ipt" -F TRENDR-INGRESS
  "$ipt" -A TRENDR-INGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  for cidr in "${ranges[@]}"; do
    "$ipt" -A TRENDR-INGRESS -i "$WAN_IFACE" -s "$cidr" -p tcp -m multiport --dports 80,443 -j RETURN
  done
  "$ipt" -A TRENDR-INGRESS -i "$WAN_IFACE" -p tcp -m multiport --dports 80,443 -j DROP
  "$ipt" -A TRENDR-INGRESS -j RETURN

  # Keep exactly one jump at the top of DOCKER-USER.
  while "$ipt" -C DOCKER-USER -j TRENDR-INGRESS >/dev/null 2>&1; do
    "$ipt" -D DOCKER-USER -j TRENDR-INGRESS
  done
  "$ipt" -I DOCKER-USER 1 -j TRENDR-INGRESS
  log "$ipt: forwarded 80/443 restricted to ${#ranges[@]} Cloudflare ranges on $WAN_IFACE"
}

if [[ -z "$WAN_IFACE" ]]; then
  warn "could not determine the WAN interface; set WAN_IFACE=<iface>; Docker ingress filtering skipped"
else
  if command -v iptables >/dev/null 2>&1; then
    apply_docker_chain iptables "${V4[@]}"
  else
    warn "iptables is not installed; Docker ingress filtering skipped"
  fi

  if ((${#V6[@]} > 0)) && command -v ip6tables >/dev/null 2>&1; then
    apply_docker_chain ip6tables "${V6[@]}"
  fi
fi