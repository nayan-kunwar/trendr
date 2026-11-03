#!/usr/bin/env bash
# Nightly logical backup of the production Postgres database (task 10.1).
#
# Invoked by trendr-backup.timer, or manually:
#   sudo -u deploy /opt/trendr/infra/scripts/backup.sh
#
# Configuration (environment or /etc/trendr/backup.env):
#   TRENDR_DIR             repository checkout           (default /opt/trendr)
#   COMPOSE_FILE           prod compose file             (default $TRENDR_DIR/docker-compose.prod.yml)
#   ENV_FILE               production env file           (default $TRENDR_DIR/.env.production)
#   BACKUP_DIR             local dump directory          (default $TRENDR_DIR/backups)
#   BACKUP_RETENTION_DAYS  local retention in days       (default 30)
#   S3_URI                 s3://bucket/prefix (required unless REQUIRE_OFFSITE=0)
#   BACKUP_AGE_RECIPIENT   age public key (required unless REQUIRE_OFFSITE=0)
#   REQUIRE_OFFSITE        1 = offsite + encryption are mandatory (default);
#                          0 only for a local drill or a dev machine
#   BACKUP_METRIC_DIR      where the node_exporter textfile lands (default $BACKUP_DIR)
#
# The dump is written atomically (`.tmp` then rename) and requires a running
# `postgres` service. Redis is not backed up: it is a cache/queue, not a source
# of truth.
set -euo pipefail

TRENDR_DIR="${TRENDR_DIR:-/opt/trendr}"
COMPOSE_FILE="${COMPOSE_FILE:-$TRENDR_DIR/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-$TRENDR_DIR/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-$TRENDR_DIR/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-trendr}"
POSTGRES_USER="${POSTGRES_USER:-trendr}"
S3_URI="${S3_URI:-}"
BACKUP_AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
REQUIRE_OFFSITE="${REQUIRE_OFFSITE:-1}"
BACKUP_METRIC_DIR="${BACKUP_METRIC_DIR:-$BACKUP_DIR}"

log() { printf '[backup] %s\n' "$*"; }
fail() {
  printf '[backup] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null || fail "docker is not installed"
[[ -f "$COMPOSE_FILE" ]] || fail "compose file not found: $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || fail "env file not found: $ENV_FILE"
[[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] || fail "BACKUP_RETENTION_DAYS must be an integer"
[[ "$REQUIRE_OFFSITE" == "0" || "$REQUIRE_OFFSITE" == "1" ]] || fail "REQUIRE_OFFSITE must be 0 or 1"

# M-8: a dump that only ever lives on the same VPS is not a backup. Production
# runs require an encrypted offsite copy; the escape hatch is explicit so a
# forgotten variable cannot silently downgrade the posture.
if [[ "$REQUIRE_OFFSITE" == "1" ]]; then
  [[ -n "$S3_URI" ]] || fail "S3_URI is required (set REQUIRE_OFFSITE=0 only for a local drill)"
  [[ -n "$BACKUP_AGE_RECIPIENT" ]] || fail "BACKUP_AGE_RECIPIENT is required (set REQUIRE_OFFSITE=0 only for a local drill)"
fi

umask 077
# `umask 077` above gives the directory mode 700 without coreutils `install`,
# which cannot chmod on every host filesystem.
mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="$BACKUP_DIR/trendr-$timestamp.dump"
tmp="$base.tmp"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

log "dumping $POSTGRES_DB from service $POSTGRES_SERVICE"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T "$POSTGRES_SERVICE" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc >"$tmp"
[[ -s "$tmp" ]] || fail "pg_dump produced an empty file"
mv "$tmp" "$base"

# M-8: prove the archive is readable before it replaces the last good copy.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T "$POSTGRES_SERVICE"   pg_restore --list <"$base" >/dev/null   || fail "pg_restore could not read the dump"
log "wrote $base ($(du -h "$base" | cut -f1)); archive verified"

archive="$base"
if [[ -n "$BACKUP_AGE_RECIPIENT" ]]; then
  command -v age >/dev/null || fail "BACKUP_AGE_RECIPIENT is set but age is not installed"
  age --recipient "$BACKUP_AGE_RECIPIENT" --output "$base.age" "$base"
  rm -f "$base"
  archive="$base.age"
else
  gzip -f "$base"
  archive="$base.gz"
fi

if [[ -n "$S3_URI" ]]; then
  command -v aws >/dev/null || fail "S3_URI is set but the AWS CLI is not installed"
  log "uploading $(basename "$archive") to ${S3_URI%/}/"
  aws s3 cp "$archive" "${S3_URI%/}/$(basename "$archive")" --sse AES256 --only-show-errors
fi

# Local retention. Remote lifecycle rules should mirror BACKUP_RETENTION_DAYS.
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'trendr-*.dump.gz' -o -name 'trendr-*.dump.age' -o -name 'trendr-*.dump' \) \
  -mtime "+$BACKUP_RETENTION_DAYS" -print -delete

# M-8: last-success timestamp for the BackupStale alert. Point
# BACKUP_METRIC_DIR at node_exporter's textfile collector directory.
mkdir -p "$BACKUP_METRIC_DIR"
metric_tmp="$BACKUP_METRIC_DIR/trendr_backup.prom.tmp"
{
  printf '# HELP trendr_backup_last_success_timestamp_seconds Unix time of the last verified backup.
'
  printf '# TYPE trendr_backup_last_success_timestamp_seconds gauge
'
  printf 'trendr_backup_last_success_timestamp_seconds %s
' "$(date +%s)"
  printf '# HELP trendr_backup_size_bytes Size of the last archive.
'
  printf '# TYPE trendr_backup_size_bytes gauge
'
  printf 'trendr_backup_size_bytes %s
' "$(wc -c <"$archive" | tr -d ' ')"
} >"$metric_tmp"
mv "$metric_tmp" "$BACKUP_METRIC_DIR/trendr_backup.prom"

log "done: $archive"
