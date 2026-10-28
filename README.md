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

## Deployment (Produksi — systemd, tanpa Nix)

> Infra lama berbasis Docker + Traefik sudah dihapus dari orangevps (2026-08-02).
> Nix juga sudah dihapus dari VPS (`/nix` tidak ada lagi) sehingga seluruh
> jalur deploy kini pindah ke pnpm + systemd.

- **Host**: orangevps
- **Service**: systemd unit `teleuploader` (env via BWS `bws-exec`)
- **Build**: `pnpm run build` (esbuild → `dist/index.js`) — `deploy.sh`
  mengirim `dist/` ke `/opt/teleuploader/dist`, `systemctl restart teleuploader`,
  lalu cek `GET /health` pada port yang didengarkan PID service
- **CI**: `.github/workflows/deploy.yml` (GitHub Actions / Gitea Actions)
- **Port**: `4000` (`PORT` env)
- **Domain**: `https://upload.asepharyana.my.id`
- **Reverse proxy**: Caddy (bukan Traefik/Docker)
- **Database**: `postgresql://asephs:***@100.121.180.82:6432/uploader` (PgBouncer pool di imrnes, **bukan** 5432/localhost)
- `deploy.sh` adalah satu-satunya jalur deploy; `Dockerfile` & `docker-compose.yml` bersifat **legacy** — jangan dipakai untuk deploy produksi.

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

On every release, `prepare.mjs` syncs the version across `package.json`
(and `flake.nix` only if that file ever comes back), and the
`Build & Deploy` workflow picks the new `dist/` up over plain SSH — no Nix
store path involved.

## Releases and container images

Every push to `main` is analysed by [semantic-release](https://semantic-release.gitbook.io/).
The commit prefix decides the version bump — nobody types a version number:

| Commit | Result |
|---|---|
| `feat(scope): …` | minor bump |
| `fix(scope): …` | patch bump |
| `BREAKING CHANGE:` in the footer | major bump |
| `chore`, `ci`, `docs`, `refactor`, `test`, `build` | patch bump, or no release at all |

A release publishes a tag, a GitHub Release and the changelog. The same workflow
then builds and pushes one container image per service to GHCR at exactly that
version, so an image tag always matches a git tag:

This repo publishes 1 image(s):

| Package | Image |
|---|---|
| `teleuploader` | `ghcr.io/asepharyana/TeleUploader:teleuploader:<version>` |


Pull one without touching the registry UI:

```bash
docker pull ghcr.io/asepharyana/<repo>:<service>:<version>
```

### Adding or removing an image

Do not edit `.github/workflows/release.yml` to change which images are built.
The list lives in `.github/docker-images.json`:

```json
{ "images": [
  { "package": "<service>", "context": ".", "file": "Dockerfile" }
] }
```

- `package` becomes the GHCR path component, so it must be lowercase
  `[a-z0-9._-]`. It does not have to match the repo name.
- `context` is the build context directory, `file` the Dockerfile within it.
- `build_args` is an object of `KEY=value` pairs; the pipeline flattens it before
  the matrix, so both the object and a pre-joined `"A=1\nB=2"` string work.
- `"enabled": false` keeps an entry documented but skips building it. **An empty
  or fully disabled list fails the run** rather than publishing nothing.

Every enabled entry must have a `Dockerfile` **and** a `.dockerignore` in its
context, and both must be tracked by git — CI cannot see an untracked file, and a
missing `.dockerignore` silently ships `node_modules/` and `.git` inside the image.

`latest` tracks the newest stable release. Prereleases (`1.2.0-rc.1`) are
tagged but never promote `latest`.

### If a release fails

Check the run, then fix forward with a normal commit — do not re-tag by hand:

```bash
gh run list --workflow=release.yml --limit 5
gh run view <run-id> --log-failed
```

A run that only built images and published no tag is normal for a `chore` push:
there was nothing to release, so no version was derived and no image was tagged.
<!-- review smoke test 1793182469 -->
