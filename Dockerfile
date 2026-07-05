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
COPY schema.sql ./
COPY package.json ./

# Expose port
EXPOSE 3000

# Start server
CMD ["bun", "dist/index.js"]
