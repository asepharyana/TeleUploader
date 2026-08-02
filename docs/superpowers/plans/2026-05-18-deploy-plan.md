# Docker, Traefik, and GitHub Actions Deployment Plan

> ⚠️ **LEGACY** — Dokumen historis (2026-05-18). Arsitektur Docker + Traefik +
> GitHub Actions sudah digantikan (2026-08-02) oleh Nix + systemd + Caddy di
> orangevps: port `4000`, domain `upload.asepharyana.my.id`, database via
> PgBouncer pool `100.121.180.82:6432` (bukan 5432/localhost).


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Containerize TeleUploader using Bun, configure Traefik labels for routing `upload.asepharyana.my.id`, and set up full GitHub Actions CI/CD to VPS `45.127.35.244`.

**Architecture:** Use a multi-stage `Dockerfile` with Bun to bundle and run the application. Serve via `docker-compose.yml` linking to external Traefik network `app-shared-net`. Deploy via GitHub Action workflow SSH using GitHub secrets for secure configuration.

**Tech Stack:** Bun 1.1, Docker, Docker Compose, Traefik, GitHub Actions.

---

### Task 1: Dockerfile Setup

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Create `.dockerignore` to prevent copying unnecessary files**
Write to `/.dockerignore`:
```ignore
node_modules
.git
.github
docs
logs
dist
.env
```

- [ ] **Step 2: Create multi-stage `Dockerfile` using Bun**
Write to `/Dockerfile`:
```dockerfile
# Stage 1: Build the application
FROM oven/bun:1.1-alpine AS builder

WORKDIR /usr/src/app

# Copy dependency configuration files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source and configurations
COPY tsconfig.json biome.json ./
COPY src ./src

# Lint, format and build
RUN bun run lint
RUN bun run build

# Stage 2: Final minimal production environment
FROM oven/bun:1.1-slim AS runner

WORKDIR /usr/src/app

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=4000

# Copy necessary files from builder and repo
COPY --from=builder /usr/src/app/dist/index.js ./dist/index.js
COPY --from=builder /usr/src/app/package.json ./package.json
COPY schema.sql ./schema.sql

# Expose server port
EXPOSE 4000

# Start server
CMD ["bun", "dist/index.js"]
```

- [ ] **Step 3: Test Docker build locally**
Run: `docker build -t teleuploader:test .`
Expected: Successfully builds without errors.

- [ ] **Step 4: Commit Dockerfile changes**
Run:
```bash
git add Dockerfile .dockerignore
git commit -m "chore: add Dockerfile and dockerignore for production build"
```

---

### Task 2: Docker Compose Setup

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Write `docker-compose.yml` with external Traefik network configuration**
Write to `/docker-compose.yml`:
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

- [ ] **Step 2: Commit docker-compose configuration**
Run:
```bash
git add docker-compose.yml
git commit -m "chore: add docker-compose.yml with Traefik configurations"
```

---

### Task 3: GitHub Actions Deployment Pipeline

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Create GitHub Action deploy workflow**
Write to `/.github/workflows/deploy.yml`:
```yaml
name: Deploy TeleUploader

on:
  push:
    branches:
      - main

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.1

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run Tests
        env:
          BOT_TOKEN: "mock_token"
          STORAGE_CHANNEL_ID: "123456"
          BASE_URL: "http://localhost:4000"
          DATABASE_URL: "postgresql://asephs:***@100.121.180.82:6432/postgres"
          PORT: "4000"
        run: bun run test

  build-and-push:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and Push Docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ghcr.io/mytheclipse/teleuploader:latest

  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to VPS via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: 45.127.35.244
          username: root
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            mkdir -p /opt/teleuploader
            cd /opt/teleuploader
            
            # Log in to GHCR on VPS
            echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
            
            # Write dynamic docker-compose.yml
            cat << 'EOF' > docker-compose.yml
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
            EOF

            # Write .env file from secrets
            cat << EOF > .env
            BOT_TOKEN=${{ secrets.BOT_TOKEN }}
            STORAGE_CHANNEL_ID=${{ secrets.STORAGE_CHANNEL_ID }}
            BASE_URL=${{ secrets.BASE_URL }}
            DATABASE_URL=${{ secrets.DATABASE_URL }}
            PORT=4000
            EOF

            # Pull latest docker image
            docker compose pull

            # Run DB migrations
            docker compose run --rm app bun run db:migrate

            # Start service
            docker compose up -d
```

- [ ] **Step 2: Commit workflow**
Run:
```bash
git add .github/workflows/deploy.yml
git commit -m "ci: add GitHub Actions pipeline for tests, Docker build, and deployment"
```

---

### Task 4: GitHub Secrets Configuration

**Files:**
- Run Commands with `gh` CLI locally

- [ ] **Step 1: Check GitHub CLI authentication**
Run: `gh auth status`
Expected: Authenticated successfully as `MythEclipse` (or similar). If not authenticated, prompt user to login using `! gh auth login`.

- [ ] **Step 2: Configure SSH_PRIVATE_KEY secret**
Run: `gh secret set SSH_PRIVATE_KEY < ~/.ssh/id_rsa` (adjust path if custom key is used).
Expected: Secret successfully set.

- [ ] **Step 3: Configure environment secrets**
Run:
```bash
gh secret set BOT_TOKEN --body "YOUR_TELEGRAM_BOT_TOKEN"
gh secret set STORAGE_CHANNEL_ID --body "-1001234567890"
gh secret set BASE_URL --body "https://upload.yourdomain.com"
gh secret set DATABASE_URL --body "postgresql://user:password@host/dbname?sslmode=require"
```
Expected: All secrets successfully set in repository.
