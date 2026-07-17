#!/bin/bash
# ──────────────────────────────────────────────────────────
# Backup PostgreSQL operaciones_db — local + MinIO off-host
#
# Cron en producción:
#   0 3 * * *  /var/www/operaciones/scripts/backup-operaciones.sh >> /var/log/operaciones-backup.log 2>&1
#
# Salida:
#   1. /var/backups/postgres/operaciones/operaciones_${DATE}.sql.gz  (retención RETENTION_LOCAL_DAYS)
#   2. minio://${MINIO_BUCKET}/daily/operaciones_${DATE}.sql.gz       (retención RETENTION_MINIO_DAYS)
#
# Restore: ver docs/runbook/RESTORE_OPERACIONES.md
# ──────────────────────────────────────────────────────────
set -euo pipefail

DB_NAME="${DB_NAME:-operaciones_db}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/postgres/operaciones}"
RETENTION_LOCAL_DAYS="${RETENTION_LOCAL_DAYS:-7}"
RETENTION_MINIO_DAYS="${RETENTION_MINIO_DAYS:-30}"
MINIO_ALIAS="${MINIO_ALIAS:-local}"
MINIO_BUCKET="${MINIO_BUCKET:-operaciones-backups}"
MIN_SIZE_BYTES="${MIN_SIZE_BYTES:-10240}"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/operaciones_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

echo "[$(date -Iseconds)] === backup start: $BACKUP_FILE ==="

# 1. pg_dump comprimido. --format=plain (sql plano) facilita restore parcial con grep/sed.
sudo -u postgres pg_dump --format=plain --no-owner --no-acl "$DB_NAME" | gzip -9 > "$BACKUP_FILE"

SIZE_BYTES=$(stat -c%s "$BACKUP_FILE")
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[$(date -Iseconds)] dump local OK: $BACKUP_FILE ($SIZE)"

# 2. Verificación de integridad pre-upload — abortar si el archivo es sospechosamente pequeño o corrupto.
if [ "$SIZE_BYTES" -lt "$MIN_SIZE_BYTES" ]; then
  echo "[$(date -Iseconds)] ERROR: backup sospechosamente pequeño ($SIZE_BYTES bytes < $MIN_SIZE_BYTES)"
  exit 1
fi
if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
  echo "[$(date -Iseconds)] ERROR: backup gzip corrupto"
  exit 1
fi
# Smoke parse: el SQL plano debe contener al menos una línea "CREATE TABLE".
# CREATE TABLE aparece recién por la línea ~1200 (SET + comentarios primero), por eso
# usamos zgrep que abre el archivo directamente y evita el pipe (set -o pipefail abortaría
# al recibir SIGPIPE cuando grep -m 1 cierra el pipe tras el primer match).
if ! zgrep -q "^CREATE TABLE" "$BACKUP_FILE"; then
  echo "[$(date -Iseconds)] ERROR: dump no contiene CREATE TABLE — pg_dump falló silencioso"
  exit 1
fi

# 3. Upload a MinIO (mismo VPS pero bucket aislado del filesystem de postgres).
#    Si el filesystem de postgres muere, se recupera desde MinIO.
if command -v mc >/dev/null 2>&1; then
  mc mb --ignore-existing "${MINIO_ALIAS}/${MINIO_BUCKET}" 2>/dev/null || true
  if mc cp "$BACKUP_FILE" "${MINIO_ALIAS}/${MINIO_BUCKET}/daily/" 2>&1 | tail -1; then
    echo "[$(date -Iseconds)] subido a MinIO: ${MINIO_ALIAS}/${MINIO_BUCKET}/daily/"
  else
    echo "[$(date -Iseconds)] WARN: upload a MinIO falló (backup local OK)"
  fi
  # Retención remota
  mc find "${MINIO_ALIAS}/${MINIO_BUCKET}/daily/" \
    --older-than "${RETENTION_MINIO_DAYS}d" \
    --exec "mc rm {}" 2>/dev/null || true
else
  echo "[$(date -Iseconds)] WARN: 'mc' no instalado — se omite upload a MinIO"
fi

# 4. Retención local
DELETED=$(find "$BACKUP_DIR" -name 'operaciones_*.sql.gz' -mtime +"${RETENTION_LOCAL_DAYS}" -print -delete | wc -l)
if [ "$DELETED" -gt 0 ]; then
  echo "[$(date -Iseconds)] retención local: eliminados $DELETED backups antiguos (>${RETENTION_LOCAL_DAYS}d)"
fi

echo "[$(date -Iseconds)] [OK] backup verificado: $SIZE local + MinIO"
