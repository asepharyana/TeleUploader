# Telegram Bot Uploader Backend

Backend production-ready untuk upload file ke Telegram yang tersimpan di private channel.

## Setup

1. Siapkan PostgreSQL database (produksi: database `uploader` via PgBouncer pool di `100.121.180.82:6432`)
2. Setup environment: `cp .env.example .env`
3. Edit `.env` dengan nilai yang sesuai (lihat `DATABASE_URL`, `PORT=4000`)
4. Create table: `bun run db:migrate`
5. Install dependencies: `bun install`

## Telegram Private Channel Setup

1. Buat private channel Telegram
2. Tambah bot sebagai admin di channel
3. Dapatkan `STORAGE_CHANNEL_ID` (misalnya -1001234567890)

## Running

```bash
bun run dev      # Development mode
bun run start    # Production mode
```

## Deployment (Produksi — Nix + systemd)

> Infra lama berbasis Docker + Traefik sudah dihapus dari orangevps (2026-08-02).

- **Host**: orangevps
- **Service**: systemd unit `teleuploader` (env via `/etc/teleuploader/env` / BWS secrets)
- **Build**: Nix flake (`flake.nix`) — `nix build .#teleuploader` → `nix copy` → `systemctl restart teleuploader`
- **CI**: `.github/workflows/deploy.yml` (Gitea Actions / GitHub Actions)
- **Port**: `4000` (`PORT` env)
- **Domain**: `https://upload.asepharyana.my.id`
- **Reverse proxy**: Caddy (bukan Traefik/Docker)
- **Database**: `postgresql://asephs:***@100.121.180.82:6432/uploader` (PgBouncer pool di imrnes, **bukan** 5432/localhost)
- `deploy.sh` & `Dockerfile` & `docker-compose.yml` bersifat **legacy** — jangan dipakai untuk deploy produksi.

## API Endpoints

- `POST /api/upload` - Upload file
- `GET /f/:public_id` - Download redirect
- `GET /file/:public_id/info` - File metadata
- `GET /health` - Health check

## FAQ

**URL permanen maksudnya apa?**
URL backend tetap permanen: `https://upload.asepharyana.my.id/f/{public_id}`
Ini berarti URL service Anda fix, bukan jaminan file Telegram abadi.

## Testing

Gunakan bot Telegram untuk upload, atau upload API langsung via HTTP.

## Versioning

This repository uses auto semantic versioning via [semantic-release](https://github.com/semantic-release/semantic-release):

- `fix(...)` commits → patch bump (v1.1.1 → v1.1.2)
- `feat(...)` commits → minor bump (v1.2.0)
- breaking changes → major bump (v2.0.0)
- `chore/ci/docs/refactor/test` commits → no release

On every release, `prepare.mjs` syncs the version across `package.json` and
`flake.nix`, guaranteeing a fresh Nix store path and true auto-deploy via
the `Build & Deploy (Nix)` workflow.
