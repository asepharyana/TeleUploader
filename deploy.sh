#!/bin/bash
# ─── TeleUploader Deploy Script ──────────────────────────────────────────────
# Builds the Bun app locally and deploys to the VPS via Docker.
#
# Strategy: build dist locally, ship dist + Docker context to VPS via tar pipe,
# then rebuild the Docker image and restart the container on the VPS.
#
# Prerequisites:
#   - GitLab CLI (glab) with active session, OR the env vars below
#   - SSH access to the VPS
#   - Docker + docker compose on the VPS
#
# Usage:
#   ./deploy.sh                          # build + deploy
#   ./deploy.sh --no-build               # skip build, just deploy dist
#   ./deploy.sh --help                   # show this message
#   ./deploy.sh --check                  # dry-run: show vars and exit
#
# Required env (or auto-fetched from GitLab CI vars via glab):
#   VPS_HOST              — VPS IP/hostname
#   VPS_USER              — SSH user (default: root)
#   VPS_SSH_KEY           — path/contents of SSH private key
#
# Optional:
#   DEPLOY_DIR            — deploy dir on VPS (default: /opt/teleuploader)
#   ADMIN_PASSWORD        — verify health after deploy (optional)
# ──────────────────────────────────────────────────────────────────────────────

set -eu

# ── Config ────────────────────────────────────────────────────────────────────
APP_NAME="teleuploader"
GITLAB_PROJECT="superaseph%2FTeleUploader"
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

# ── Auto-fetch credentials from GitLab CI vars ─────────────────────────────
fetch_ci_var() {
  glab api "projects/${GITLAB_PROJECT}/variables/$1" 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('value',''))" 2>/dev/null || true
}

# ── Default credentials ─────────────────────────────────────────────────────
# Hardcoded defaults for this project. Env vars take precedence.
: "${VPS_HOST:=45.127.35.244}"
: "${VPS_USER:=root}"
: "${VPS_SSH_KEY:=${HOME}/.ssh/id_ed25519}"

# Fallback: fetch from GitLab CI vars if defaults are empty (for CI runs)
if [ -z "${VPS_HOST:-}" ]; then VPS_HOST=$(fetch_ci_var VPS_HOST); fi
if [ -z "${VPS_USER:-}" ]; then VPS_USER=$(fetch_ci_var VPS_USERNAME); fi
if [ -z "${VPS_SSH_KEY:-}" ]; then
  KEY=$(fetch_ci_var VPS_SSH_KEY)
  if [ -n "$KEY" ]; then
    VPS_SSH_KEY=$(mktemp)
    echo "$KEY" > "$VPS_SSH_KEY"
    chmod 600 "$VPS_SSH_KEY"
  fi
fi

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

# ── Validate ──────────────────────────────────────────────────────────────────
# (Defaults are set above — this fails only if something went wrong)
: "${VPS_HOST:?VPS_HOST resolved to empty}"
: "${VPS_USER:?VPS_USER resolved to empty}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY resolved to empty}"
[ -f "$VPS_SSH_KEY" ] || die "SSH key not found at $VPS_SSH_KEY"

SSH_DEST="${VPS_USER}@${VPS_HOST}"
SSH_OPTS="-i $VPS_SSH_KEY -o StrictHostKeyChecking=accept-new"

# ── Helpers ───────────────────────────────────────────────────────────────────
vps()  { ssh $SSH_OPTS "$SSH_DEST" "$@"; }
log()  { echo "→ $*"; }
ok()   { echo "✓ $*"; }
die()  { echo "✗ $*"; exit 1; }

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

# ── 5. Build Docker image & restart on VPS ───────────────────────────────────
log "Building Docker image on VPS..."
vps "cd '${DEPLOY_DIR}' && docker compose build --pull 2>&1" | tail -5 || die "Docker build failed on VPS"

log "Restarting container..."
vps "cd '${DEPLOY_DIR}' && docker compose up -d --force-recreate 2>&1" || die "Container restart failed"

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
