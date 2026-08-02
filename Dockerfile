# ⚠️ LEGACY — pembangunan & deploy sekarang DISARANKAN memakai Nix + systemd
# (lihat flake.nix + .github/workflows/deploy.yml + Caddy reverse proxy di orangevps).
# Dockerfile ini hanya dipertahankan untuk konteks historis / fallback, bukan deploy produksi.

# Stage 1: Builder
FROM oven/bun:alpine AS builder

WORKDIR /usr/src/app

# Install dependencies (devDependencies included for build)
COPY package.json tsconfig.json ./
RUN bun install

# Copy source
COPY src ./src

# Build (lint is run locally before deploy)
RUN bun run build

# Stage 2: Runner
FROM oven/bun:slim AS runner

WORKDIR /usr/src/app

# Copy built files, schema, and package.json
COPY --from=builder /usr/src/app/dist/index.js ./dist/index.js
COPY --from=builder /usr/src/app/dist/migrate.js ./dist/migrate.js
COPY --from=builder /usr/src/app/src/home.html ./dist/home.html
COPY schema.sql ./
COPY package.json ./

# Expose port
EXPOSE 4000

# Start server
CMD ["bun", "dist/index.js"]