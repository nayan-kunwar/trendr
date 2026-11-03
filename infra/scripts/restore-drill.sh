#!/usr/bin/env bash
# M-8 — restore drill: prove the newest archive actually restores and holds
# data, without touching the live database.
#
#   sudo -u deploy /opt/trendr/infra/scripts/restore-drill.sh
#
# It restores into a scratch database (`trendr_restore_drill`) inside the
# postgres container, checks the core tables, and drops the scratch database.
# Run it after every schema-changing deploy and at least monthly.
#
# Configuration mirrors backup.sh:
#   TRENDR_DIR, COMPOSE_FILE, ENV_FILE, BACKUP_DIR, POSTGRES_SERVICE,
#   POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
#   BACKUP_AGE_IDENTITY   age private key, required only for `.age` archives
set -euo pipefail

TRENDR_DIR="${TRENDR_DIR:-/opt/trendr}"
COMPOSE_FILE="${COMPOSE_FILE:-$TRENDR_DIR/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-$TRENDR_DIR/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-$TRENDR_DIR/backups}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-trendr}"
POSTGRES_USER="${POSTGRES_USER:-trendr}"
BACKUP_AGE_IDENTITY="${BACKUP_AGE_IDENTITY:-}"
SCRATCH_DB="${SCRATCH_DB:-trendr_restore_drill}"

log() { printf '[restore-drill] %s\n' "$*"; }
fail() {
  printf '[restore-drill] ERROR: %s\n' "$*" >&2
  exit 1
}

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

command -v docker >/dev/null || fail "docker is not installed"
[[ -f "$COMPOSE_FILE" ]] || fail "compose file not found: $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || fail "env file not found: $ENV_FILE"
[[ "$SCRATCH_DB" =~ ^[a-zA-Z0-9_]+$ ]] || fail "SCRATCH_DB must be a simple identifier"

archive="$(find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'trendr-*.dump.age' -o -name 'trendr-*.dump.gz' -o -name 'trendr-*.dump' \) \
  -print | sort | tail -n 1)"
[[ -n "$archive" ]] || fail "no archive found in $BACKUP_DIR"
log "using $(basename "$archive")"

emit_dump() {
  case "$archive" in
    *.age)
      command -v age >/dev/null || fail "age is not installed (needed to decrypt the archive)"
      [[ -n "$BACKUP_AGE_IDENTITY" ]] || fail "BACKUP_AGE_IDENTITY is required for an .age archive"
      age --decrypt -i "$BACKUP_AGE_IDENTITY" "$archive"
      ;;
    *.gz) gzip -dc "$archive" ;;
    *) cat "$archive" ;;
  esac
}

cleanup() {
  compose exec -T "$POSTGRES_SERVICE" \
    psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\"" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "recreating scratch database $SCRATCH_DB"
compose exec -T "$POSTGRES_SERVICE" \
  psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\"" \
  -c "CREATE DATABASE \"$SCRATCH_DB\"" >/dev/null

log "restoring"
emit_dump | compose exec -T "$POSTGRES_SERVICE" \
  pg_restore -U "$POSTGRES_USER" -d "$SCRATCH_DB" --no-owner --no-privileges --exit-on-error

log "checking restored schema and data"
tables="$(compose exec -T "$POSTGRES_SERVICE" \
  psql -U "$POSTGRES_USER" -d "$SCRATCH_DB" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
[[ "${tables//[[:space:]]/}" -ge 10 ]] || fail "restored schema has only $tables tables"

items="$(compose exec -T "$POSTGRES_SERVICE" \
  psql -U "$POSTGRES_USER" -d "$SCRATCH_DB" -tAc "SELECT count(*) FROM items")"
migrations="$(compose exec -T "$POSTGRES_SERVICE" \
  psql -U "$POSTGRES_USER" -d "$SCRATCH_DB" -tAc \
  "SELECT count(*) FROM drizzle.__drizzle_migrations")"
runs="$(compose exec -T "$POSTGRES_SERVICE" \
  psql -U "$POSTGRES_USER" -d "$SCRATCH_DB" -tAc "SELECT count(*) FROM ingestion_runs")"

log "restored ${tables//[[:space:]]/} tables, ${items//[[:space:]]/} items, ${runs//[[:space:]]/} runs, ${migrations//[[:space:]]/} migrations"
log "drill passed; the live database was not touched"
