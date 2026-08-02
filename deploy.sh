#!/bin/bash
# ⚠️ LEGACY — Script deploy lama berbasis Docker. Sejak 2026-08-02 Docker dihapus
# dari orangevps; produksi kini memakai Nix + systemd (lihat flake.nix, dan CI
# .github/workflows/deploy.yml yang menjalankan `nix build` → `nix copy` →
# `systemctl restart teleuploader`). Berkas ini hanya dipertahankan sebagai
# referensi historis — JANGAN dipakai untuk deploy produksi.
# ─── FileDrop Deploy Script ──────────────────────────────────────────────────
# Builds the Bun app locally and deploys to the VPS via Docker.
#
# Strategy: build dist locally, ship dist + Docker context to VPS via tar pipe,
# then rebuild the Docker image and restart the container on the VPS.
#
# Prerequisites:
#   - SSH access to the VPS
#   - Docker + docker compose on the VPS
#   - For CI: Gitea Actions secrets injected as environment variables
#
# Usage:
#   ./deploy.sh                          # build + deploy
#   ./deploy.sh --no-build               # skip build, just deploy dist
#   ./deploy.sh --help                   # show this message
#   ./deploy.sh --check                  # dry-run: show vars and exit
#
# Required env in CI:
#   VPS_HOST              — VPS IP/hostname
#   VPS_USER              — SSH user
#   VPS_SSH_KEY           — path to SSH private key file
#
# Local defaults:
#   VPS_HOST              — 45.127.35.244
#   VPS_USER              — root
#   VPS_SSH_KEY           — ~/.ssh/id_ed25519
#
# Optional:
#   DEPLOY_DIR            — deploy dir on VPS (default: /opt/filedrop)
#   ADMIN_PASSWORD        — verify health after deploy (optional)
# ──────────────────────────────────────────────────────────────────────────────

set -eu

# ── Config ────────────────────────────────────────────────────────────────────
APP_NAME="filedrop"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/${APP_NAME}}"
COMPOSE_FILE="docker-compose.yml"
DOCKER_IMAGE="ghcr.io/mytheclipse/${APP_NAME}"

# ── Parse args ────────────────────────────────────────────────────────────────
DO_BUILD=true
DO_CHECK=false

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      sed -n '2,/^$/ s/^# //p' "$0"
      exit 0
      ;;
    --no-build)    DO_BUILD=false ;;
    --check)       DO_CHECK=true ;;
  esac
done

# ── Default credentials ─────────────────────────────────────────────────────
# Local defaults for this project. CI-provided environment variables take precedence.
: "${VPS_HOST:=45.127.35.244}"
: "${VPS_USER:=root}"
: "${VPS_SSH_KEY:=${HOME}/.ssh/id_ed25519}"

# ── Check mode ────────────────────────────────────────────────────────────────
if $DO_CHECK; then
  echo "=== Config ==="
  echo "App name:     $APP_NAME"
  echo "Deploy dir:   $DEPLOY_DIR"
  echo "Image:        $DOCKER_IMAGE"
  echo ""
  echo "=== Credentials ==="
  echo "VPS_HOST:     ${VPS_HOST:-<not set>}"
  echo "VPS_USER:     ${VPS_USER:-<not set>}"
  echo "VPS_SSH_KEY:  ${VPS_SSH_KEY:+<set (${#VPS_SSH_KEY} chars)>}"
  echo ""
  echo "=== Files to deploy ==="
  for f in .env package.json bun.lock schema.sql Dockerfile docker-compose.yml dist/index.js dist/migrate.js; do
    [ -e "$f" ] && echo "  ✓ $f" || echo "  ✗ $f (missing)"
  done
  exit 0
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { echo "→ $*"; }
ok()   { echo "✓ $*"; }
die()  { echo "✗ $*"; exit 1; }

# ── Validate ──────────────────────────────────────────────────────────────────
# (Defaults are set above — this fails only if something went wrong)
: "${VPS_HOST:?VPS_HOST resolved to empty}"
: "${VPS_USER:?VPS_USER resolved to empty}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY resolved to empty}"
[ -f "$VPS_SSH_KEY" ] || die "SSH key not found at $VPS_SSH_KEY"

SSH_DEST="${VPS_USER}@${VPS_HOST}"
SSH_OPTS="-i $VPS_SSH_KEY -o StrictHostKeyChecking=accept-new"

vps()  { ssh $SSH_OPTS "$SSH_DEST" "$@"; }

# ── 1. Test SSH connection ────────────────────────────────────────────────────
log "Testing SSH connection to ${VPS_USER}@${VPS_HOST}..."
vps "echo connected" > /dev/null 2>&1 || die "SSH connection failed"
ok "SSH connection established"

# ── 2. Build ──────────────────────────────────────────────────────────────────
REPO_ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$REPO_ROOT"

if $DO_BUILD; then
  log "Installing dependencies..."
  bun install 2>&1 | tail -1 || die "bun install failed"

  log "Formatting code..."
  bun run format 2>&1 | tail -3 || log "Format skipped (may be clean)"

  log "Linting..."
  bun run lint 2>&1 | tail -5 || die "Lint failed"

  log "Building dist..."
  bun run build 2>&1 || die "Build failed"

  # Verify dist output exists
  [ -f dist/index.js ] || die "dist/index.js not found after build"
  [ -f dist/migrate.js ] || die "dist/migrate.js not found after build"
  ok "Build complete (dist/index.js: $(wc -c < dist/index.js | numfmt --to=iec) — dist/migrate.js: $(wc -c < dist/migrate.js | numfmt --to=iec))"
else
  log "Skipping build (--no-build)"
fi

# ── 3. Ensure remote deploy directory exists ─────────────────────────────────
log "Ensuring remote directory ${DEPLOY_DIR} exists..."
vps "mkdir -p '${DEPLOY_DIR}'"
ok "Remote directory ready"

# ── 4. Deploy to VPS ─────────────────────────────────────────────────────────
log "Creating deploy archive..."
# Build context: everything needed for `docker compose build` on the VPS
DEPLOY_FILES=(
  .env
  package.json
  bun.lock
  schema.sql
  Dockerfile
  docker-compose.yml
  biome.json
  tsconfig.json
  src
  dist
)

log "Shipping files to VPS..."
# Atomic deploy: extract into temp dir, then rename — avoids partial state
vps "rm -rf '${DEPLOY_DIR}.new' && mkdir -p '${DEPLOY_DIR}.new'"
tar czf - "${DEPLOY_FILES[@]}" | vps "tar xzf - -C '${DEPLOY_DIR}.new'"
vps "rm -rf '${DEPLOY_DIR}.old' && mv '${DEPLOY_DIR}' '${DEPLOY_DIR}.old' 2>/dev/null; mv '${DEPLOY_DIR}.new' '${DEPLOY_DIR}' && rm -rf '${DEPLOY_DIR}.old'"

ok "Files shipped to ${DEPLOY_DIR}"

# ── 5. Build Docker image & restart ──────────────────────────────────────
log "Building Docker image on VPS..."
vps "cd '${DEPLOY_DIR}' && docker compose build --pull 2>&1" | tail -5 || die "Docker build failed on VPS"

log "Restarting container (zero-downtime via healthcheck)..."
vps "cd '${DEPLOY_DIR}' && docker compose up -d --force-recreate --wait --wait-timeout 60 2>&1" || {
  log "Warn: --wait not supported on this docker-compose version, falling back to basic restart"
  vps "cd '${DEPLOY_DIR}' && docker compose up -d --force-recreate 2>&1" || die "Container restart failed"
}

# ── 6. Verify container is running ────────────────────────────────────────────
log "Waiting for container to be healthy..."
sleep 5
CONTAINER_ID=$(vps "docker ps --filter 'name=${APP_NAME}' --format '{{.ID}}' 2>/dev/null" || true)

if [ -n "$CONTAINER_ID" ]; then
  HEALTH=$(vps "docker inspect --format='{{.State.Health.Status}}' '${CONTAINER_ID}'" 2>/dev/null || echo "no-healthcheck")
  STATUS=$(vps "docker inspect --format='{{.State.Status}}' '${CONTAINER_ID}'" 2>/dev/null || echo "unknown")
  log "Container status: ${STATUS} | health: ${HEALTH}"

  # Tail recent logs
  vps "docker logs --tail 10 '${CONTAINER_ID}' 2>&1" || true
else
  log "No container found with name '${APP_NAME}' — checking all recent..."
  vps "docker ps -a --filter 'name=${APP_NAME}' 2>/dev/null" || true
fi

# ── 7. Health check ───────────────────────────────────────────────────────────
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  log "Running health check via HTTP..."
  sleep 3
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${VPS_HOST}/health" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    ok "Health check passed (HTTP ${HTTP_CODE})"
  else
    log "Health check returned HTTP ${HTTP_CODE} (may need a moment or TLS not set up)"
  fi
fi

# ── Cleanup temp SSH key ─────────────────────────────────────────────────────
if [[ "${VPS_SSH_KEY:-}" == /tmp/* ]]; then
  rm -f "$VPS_SSH_KEY"
fi

echo ""
echo "✓ Deploy complete — ${APP_NAME} is running on ${VPS_HOST}"
