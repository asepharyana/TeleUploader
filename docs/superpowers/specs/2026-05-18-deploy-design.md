---
name: docker-traefik-ghactions-deploy
description: Dockerize TeleUploader, route through Traefik, and set up CI/CD with GitHub Actions to deploy to VPS
metadata:
  type: project
---

# Design: TeleUploader Deployment & CI/CD Setup

> ⚠️ **LEGACY** — Dokumen historis (2026-05-18) untuk arsitektur Docker + Traefik +
> GitHub Actions. Docker & Traefik sudah dihapus dari VPS produksi (2026-08-02):
> deploy sekarang Nix + systemd + Caddy di orangevps, port `4000`, domain
> `upload.asepharyana.my.id`, database via PgBouncer pool `100.121.180.82:6432`.


We are setting up production deployment for TeleUploader on VPS `45.127.35.244` behind Traefik utilizing GitHub Actions.

## 1. System Architecture

TeleUploader is a Bun-based service.
- **Docker Containerization**: Custom Docker image based on `oven/bun:1.1` to build and run the Bun application.
- **Reverse Proxy**: Traefik running on VPS acts as reverse proxy and TLS terminator.
- **Shared Network**: The application joins `app-shared-net` (external network pre-configured with Traefik).
- **Database**: External PostgreSQL database (Neon). Migration runs automatically before the service boots.

## 2. Docker Specification

### `Dockerfile`
- Multi-stage build.
- **Stage 1 (Build)**: Install dependencies, copy source files, run Biome lint/format checks, compile TS build to `dist/index.js` using `bun build`.
- **Stage 2 (Run)**: Use minimal `oven/bun:1.1-slim` runtime. Copy `dist/index.js`, `schema.sql`, and `package.json`. Expose port `4000`.

### `docker-compose.yml`
```yaml
version: '3.8'

services:
  app:
    image: ghcr.io/mytheclipse/teleuploader:latest
    container_name: teleuploader-app
    restart: always
    environment:
      - BOT_TOKEN=${BOT_TOKEN}
      - STORAGE_CHANNEL_ID=${STORAGE_CHANNEL_ID}
      - BASE_URL=${BASE_URL}
      - DATABASE_URL=${DATABASE_URL}
      - PORT=4000
      - NODE_ENV=production
      - LOG_LEVEL=info
    networks:
      - app-shared-net
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.teleuploader.rule=Host(`upload.asepharyana.my.id`)"
      - "traefik.http.routers.teleuploader.entrypoints=websecure"
      - "traefik.http.routers.teleuploader.tls=true"
      - "traefik.http.routers.teleuploader.tls.certresolver=letsencrypt"
      - "traefik.http.services.teleuploader.loadbalancer.server.port=4000"

networks:
  app-shared-net:
    name: app-shared-net
    external: true
```

## 3. CI/CD GitHub Actions Specification

- File: `.github/workflows/deploy.yml`
- Runs on: `ubuntu-latest`
- Triggers on: Push to `main` branch.

### Pipeline Steps:
1. **Repository Checkout**: Retrieve code.
2. **Setup Bun**: Prepare test environment.
3. **Run Tests**: Execute `bun test` to guarantee correctness before build.
4. **Log in to GitHub Container Registry (GHCR)**: Authenticate using `GITHUB_TOKEN`.
5. **Build and Push**: Build Docker image and tag as `ghcr.io/mytheclipse/teleuploader:latest`, push to GHCR.
6. **VPS Deployment via SSH**:
   - Establish SSH connection to `45.127.35.244` using private key.
   - Sync/create directory `/opt/teleuploader`.
   - Write dynamic `docker-compose.yml` and `.env` containing production secrets.
   - Pull latest image: `docker compose pull`.
   - Run database migrations: `docker compose run --rm app bun run db:migrate`.
   - Restart service: `docker compose up -d`.

## 4. Secret Configuration Plan
Using Github CLI (`gh secret set`):
- `SSH_PRIVATE_KEY` (using `~/.ssh/id_rsa` or designated key)
- `BOT_TOKEN`
- `STORAGE_CHANNEL_ID`
- `BASE_URL`
- `DATABASE_URL`

---
**Next Step**: User reviews written spec. Let me know if you want changes.
